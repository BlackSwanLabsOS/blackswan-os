/**
 * Deploy BlackSwanOS — works locally and on public networks.
 *
 *   npx hardhat run scripts/deploy.js --network localhost     (local dev)
 *   npx hardhat run scripts/deploy.js --network baseSepolia   (testnet)
 *
 * After deploy:
 *   - writes the new contract address to deployment.json (repo root),
 *   - automatically updates CONTRACT_ADDRESS / USDC_ADDRESS in all service
 *     .env files (root, mcp_server, oracle),
 *   - so simulate.js, watcher.js, mcp_server, and oracle no longer require
 *     manual address paste,
 *   - ON PUBLIC NETWORKS (not `hardhat`/`localhost`): waits
 *     `VERIFY_CONFIRMATIONS` (default 6) block confirmations, then
 *     automatically verifies source on BaseScan (requires
 *     `BASESCAN_API_KEY` in .env — if missing, verification is skipped
 *     without aborting deploy).
 */

const hre = require("hardhat");
const { ethers, network } = hre;
const fs = require("node:fs");
const path = require("node:path");
const {
  ROOT_DIR,
  DEFAULT_USDC_ADDRESS,
  DEFAULT_BASE_SEPOLIA_USDC_ADDRESS,
  writeDeploymentFile,
} = require("./deployment");

/** Local/ephemeral networks — no need to wait for confirmations or verify on an explorer. */
const LOCAL_NETWORKS = new Set(["hardhat", "localhost"]);
/** Block confirmations to wait on PUBLIC networks before verification (BaseScan indexes with delay). */
const VERIFY_CONFIRMATIONS = Number(process.env.VERIFY_CONFIRMATIONS || 6);

const ENV_FILES_TO_SYNC = [
  path.join(ROOT_DIR, ".env"),
  path.join(ROOT_DIR, "mcp_server", ".env"),
  path.join(ROOT_DIR, "oracle", ".env"),
];

function replaceOrAppendEnvVar(content, key, value) {
  const re = new RegExp(`^${key}=.*$`, "m");
  if (re.test(content)) {
    return content.replace(re, `${key}=${value}`);
  }
  // Key does not exist in this .env — do not append vars services do not use.
  return content;
}

function readEnvValue(envPath, key) {
  if (!fs.existsSync(envPath)) return undefined;
  const content = fs.readFileSync(envPath, "utf-8");
  const match = content.match(new RegExp(`^${key}=(.*)$`, "m"));
  return match ? match[1].trim() : undefined;
}

function syncEnvFile(envPath, contractAddress, usdcAddress) {
  if (!fs.existsSync(envPath)) return;

  let content = fs.readFileSync(envPath, "utf-8");
  const before = content;

  content = replaceOrAppendEnvVar(content, "CONTRACT_ADDRESS", contractAddress);
  content = replaceOrAppendEnvVar(content, "USDC_ADDRESS", usdcAddress);

  if (content !== before) {
    fs.writeFileSync(envPath, content);
    console.log(`   ↳ updated ${path.relative(ROOT_DIR, envPath)}`);
  }
}

/** Default USDC by target network — never mix testnet USDC with mainnet by accident. */
function resolveDefaultUsdcAddress(networkName) {
  if (networkName === "baseSepolia") {
    return process.env.BASE_SEPOLIA_USDC_ADDRESS || DEFAULT_BASE_SEPOLIA_USDC_ADDRESS;
  }
  return DEFAULT_USDC_ADDRESS;
}

async function main() {
  const [deployer] = await ethers.getSigners();

  const usdcAddress = process.env.USDC_ADDRESS || resolveDefaultUsdcAddress(network.name);

  // Oracle address on the contract: if oracle/.env has ORACLE_PRIVATE_KEY
  // (real local Python oracle), derive the address automatically so the full
  // stack (oracle/main.py, admin_bot, mcp_server) works with the newly
  // deployed contract without manual configuration.
  let oracleAddress = process.env.ORACLE_ADDRESS;
  if (!oracleAddress) {
    const oraclePrivateKey = readEnvValue(path.join(ROOT_DIR, "oracle", ".env"), "ORACLE_PRIVATE_KEY");
    if (oraclePrivateKey && /^0x[0-9a-fA-F]{64}$/.test(oraclePrivateKey)) {
      oracleAddress = new ethers.Wallet(oraclePrivateKey).address;
    }
  }
  if (!oracleAddress) oracleAddress = deployer.address;

  // Basis points of each escrow's payloadPrice (10_000 = 100%) — default 50 = 0.5%.
  // Was a flat absolute USDC amount (env var SYSTEM_FEE) before the BPS migration;
  // renamed to make the unit change unmistakable at the call site.
  const initialSystemFeeBps = BigInt(process.env.SYSTEM_FEE_BPS ?? "50");
  const initialArbitrationFee = BigInt(process.env.ARBITRATION_FEE ?? "0");

  console.log("🚀 Deploying BlackSwanOS...");
  console.log(`   network:   ${network.name}`);
  console.log(`   deployer:  ${deployer.address}`);
  console.log(`   usdc:      ${usdcAddress}`);
  console.log(`   oracle:    ${oracleAddress}`);
  console.log(`   fees:      systemFeeBps=${initialSystemFeeBps} (${Number(initialSystemFeeBps) / 100}%) arbitration=${initialArbitrationFee}`);

  const constructorArgs = [usdcAddress, oracleAddress, initialSystemFeeBps, initialArbitrationFee];

  const Factory = await ethers.getContractFactory("BlackSwanOS");
  const contract = await Factory.deploy(...constructorArgs);
  await contract.waitForDeployment();

  const contractAddress = await contract.getAddress();
  console.log(`✅ BlackSwanOS deployed at: ${contractAddress}`);

  const isLocalNetwork = LOCAL_NETWORKS.has(network.name);

  if (!isLocalNetwork) {
    console.log(`⏳ Waiting for ${VERIFY_CONFIRMATIONS} block confirmations before BaseScan verification...`);
    await contract.deploymentTransaction().wait(VERIFY_CONFIRMATIONS);
  }

  const deploymentInfo = {
    network: network.name,
    chainId: network.config?.chainId ?? null,
    contractAddress,
    usdcAddress,
    oracleAddress,
    deployer: deployer.address,
    deployedAt: new Date().toISOString(),
  };

  writeDeploymentFile(deploymentInfo);
  console.log("📝 Wrote deployment.json");

  console.log("🔄 Syncing contract address in .env files...");
  for (const envPath of ENV_FILES_TO_SYNC) {
    syncEnvFile(envPath, contractAddress, usdcAddress);
  }

  if (!isLocalNetwork) {
    await verifyOnBlockExplorer(contractAddress, constructorArgs);
  }

  return deploymentInfo;
}

/**
 * Programmatic source verification on BaseScan via
 * `@nomicfoundation/hardhat-verify` (task `verify:verify`, see
 * hardhat.config.js -> `etherscan`). After the Etherscan API V2 migration, the
 * plugin uses the unified endpoint (api.etherscan.io/v2/api?chainid=...) and
 * matches the network by real chainId from RPC — `base`/`baseSepolia` are
 * BUILT INTO the plugin, so custom `customChains` are no longer needed.
 * Best-effort: catch errors instead of failing the whole deploy — common
 * causes (contract not indexed yet, already verified, missing/wrong
 * BASESCAN_API_KEY) still need manual follow-up and should not roll back a
 * successful deploy.
 */
async function verifyOnBlockExplorer(contractAddress, constructorArgs) {
  if (!process.env.BASESCAN_API_KEY && !process.env.ETHERSCAN_API_KEY) {
    console.log("⚠️  Skipping automatic verification — BASESCAN_API_KEY/ETHERSCAN_API_KEY not set in .env.");
    return;
  }

  console.log("🔍 Verifying source on BaseScan...");
  try {
    await hre.run("verify:verify", {
      address: contractAddress,
      constructorArguments: constructorArgs,
    });
    console.log("✅ Contract verified on BaseScan.");
  } catch (err) {
    const message = String(err?.message || err);
    if (message.toLowerCase().includes("already verified")) {
      console.log("ℹ️  Contract was already verified.");
      return;
    }
    console.error(
      "⚠️  Automatic verification failed (deploy is still OK — try manually):\n" +
        `   npx hardhat verify --network ${network.name} ${contractAddress} ${constructorArgs.map(String).join(" ")}\n` +
        `   Error: ${message}`
    );
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("❌ Deploy error:", error);
      process.exit(1);
    });
}

module.exports = { main };
