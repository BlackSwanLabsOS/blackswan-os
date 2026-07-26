/**
 * Deploy BlackSwanOS — działa zarówno lokalnie, jak i na sieciach publicznych.
 *
 *   npx hardhat run scripts/deploy.js --network localhost     (dev lokalny)
 *   npx hardhat run scripts/deploy.js --network baseSepolia   (testnet)
 *
 * Po wdrożeniu:
 *   - zapisuje świeży adres kontraktu do deployment.json (repo root),
 *   - automatycznie aktualizuje CONTRACT_ADDRESS / USDC_ADDRESS we
 *     wszystkich plikach .env serwisów (root, mcp_server, oracle),
 *   - dzięki temu simulate.js, watcher.js, mcp_server i oracle NIGDY więcej
 *     nie wymagają ręcznego wklejania adresu,
 *   - NA SIECIACH PUBLICZNYCH (nie `hardhat`/`localhost`): czeka
 *     `VERIFY_CONFIRMATIONS` (domyślnie 6) bloków potwierdzeń, po czym
 *     automatycznie weryfikuje kod źródłowy na BaseScan (wymaga
 *     `BASESCAN_API_KEY` w .env — bez niego weryfikacja jest pomijana,
 *     bez przerywania deployu).
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

/** Sieci lokalne/efemeryczne — bez sensu czekać na potwierdzenia ani weryfikować kod na eksploratorze. */
const LOCAL_NETWORKS = new Set(["hardhat", "localhost"]);
/** Ile bloków potwierdzeń czekamy na sieciach PUBLICZNYCH przed weryfikacją (BaseScan indeksuje z opóźnieniem). */
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
  // Klucz nie istnieje w tym pliku .env — nie dopisujemy niepotrzebnych
  // zmiennych do serwisów, które go nie używają.
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
    console.log(`   ↳ zaktualizowano ${path.relative(ROOT_DIR, envPath)}`);
  }
}

/** Domyślny adres USDC zależny od sieci docelowej — nigdy nie mieszamy testowego USDC z mainnetowym przez przypadek. */
function resolveDefaultUsdcAddress(networkName) {
  if (networkName === "baseSepolia") {
    return process.env.BASE_SEPOLIA_USDC_ADDRESS || DEFAULT_BASE_SEPOLIA_USDC_ADDRESS;
  }
  return DEFAULT_USDC_ADDRESS;
}

async function main() {
  const [deployer] = await ethers.getSigners();

  const usdcAddress = process.env.USDC_ADDRESS || resolveDefaultUsdcAddress(network.name);

  // Adres oracle na kontrakcie: jeśli w oracle/.env jest ustawiony
  // ORACLE_PRIVATE_KEY (prawdziwy lokalny Python oracle), wyliczamy z niego
  // adres automatycznie, żeby cały stos (oracle/main.py, admin_bot, mcp_server)
  // od razu współpracował z nowo wdrożonym kontraktem bez ręcznej konfiguracji.
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

  console.log("🚀 Wdrażam BlackSwanOS...");
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
  console.log(`✅ BlackSwanOS wdrożony na: ${contractAddress}`);

  const isLocalNetwork = LOCAL_NETWORKS.has(network.name);

  if (!isLocalNetwork) {
    console.log(`⏳ Czekam na ${VERIFY_CONFIRMATIONS} potwierdzeń bloków przed weryfikacją na BaseScan...`);
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
  console.log("📝 Zapisano deployment.json");

  console.log("🔄 Synchronizuję adres kontraktu w plikach .env...");
  for (const envPath of ENV_FILES_TO_SYNC) {
    syncEnvFile(envPath, contractAddress, usdcAddress);
  }

  if (!isLocalNetwork) {
    await verifyOnBlockExplorer(contractAddress, constructorArgs);
  }

  return deploymentInfo;
}

/**
 * Programowa weryfikacja kodu źródłowego na BaseScan przez
 * `@nomicfoundation/hardhat-verify` (task `verify:verify`, patrz
 * hardhat.config.js -> `etherscan`). Od migracji na Etherscan API V2, plugin
 * łączy się z ujednoliconym endpointem (api.etherscan.io/v2/api?chainid=...)
 * i dopasowuje sieć po realnym chainId z RPC — `base`/`baseSepolia` mają to
 * WBUDOWANE w plugin, więc nie potrzeba już własnych `customChains`.
 * Best-effort: łapiemy błędy zamiast wywalać cały deploy — najczęstsze
 * przyczyny (kontrakt jeszcze nie zaindeksowany, już zweryfikowany
 * wcześniej, brak/zły BASESCAN_API_KEY) i tak wymagają ręcznej interwencji,
 * nie powinny cofać udanego deployu.
 */
async function verifyOnBlockExplorer(contractAddress, constructorArgs) {
  if (!process.env.BASESCAN_API_KEY && !process.env.ETHERSCAN_API_KEY) {
    console.log("⚠️  Pomijam automatyczną weryfikację — brak BASESCAN_API_KEY/ETHERSCAN_API_KEY w .env.");
    return;
  }

  console.log("🔍 Weryfikuję kod źródłowy na BaseScan...");
  try {
    await hre.run("verify:verify", {
      address: contractAddress,
      constructorArguments: constructorArgs,
    });
    console.log("✅ Kontrakt zweryfikowany na BaseScan.");
  } catch (err) {
    const message = String(err?.message || err);
    if (message.toLowerCase().includes("already verified")) {
      console.log("ℹ️  Kontrakt był już zweryfikowany wcześniej.");
      return;
    }
    console.error(
      "⚠️  Automatyczna weryfikacja nie powiodła się (deploy i tak jest OK — spróbuj ręcznie):\n" +
        `   npx hardhat verify --network ${network.name} ${contractAddress} ${constructorArgs.map(String).join(" ")}\n` +
        `   Błąd: ${message}`
    );
  }
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error("❌ Błąd podczas deployu:", error);
      process.exit(1);
    });
}

module.exports = { main };
