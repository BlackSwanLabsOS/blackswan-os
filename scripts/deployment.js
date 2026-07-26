/**
 * Shared helper for reading/writing where BlackSwanOS is currently deployed
 * (deployment.json) — single source of truth used by scripts/deploy.js,
 * simulate.js, and watcher.js so nobody has to paste the contract address by hand.
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT_DIR = path.join(__dirname, "..");
const DEPLOYMENT_FILE = path.join(ROOT_DIR, "deployment.json");

/** Default USDC address on Base mainnet (also used when forking the network). */
const DEFAULT_USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/** Default Circle test USDC on Base Sepolia. */
const DEFAULT_BASE_SEPOLIA_USDC_ADDRESS = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";

const PLACEHOLDER_ADDRESS = "0x0000000000000000000000000000000000000000";

function readDeploymentFile() {
  if (!fs.existsSync(DEPLOYMENT_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(DEPLOYMENT_FILE, "utf-8"));
  } catch (_err) {
    return null;
  }
}

function writeDeploymentFile(info) {
  fs.writeFileSync(DEPLOYMENT_FILE, JSON.stringify(info, null, 2) + "\n");
}

/**
 * Returns the current BlackSwanOS contract address.
 * Priority: CONTRACT_ADDRESS in env (unless placeholder 0x0) -> deployment.json.
 * Throws a clear error if nothing is found.
 */
function getContractAddress() {
  const envAddress = process.env.CONTRACT_ADDRESS;
  if (envAddress && envAddress.toLowerCase() !== PLACEHOLDER_ADDRESS) {
    return envAddress;
  }

  const deployment = readDeploymentFile();
  if (deployment && deployment.contractAddress) {
    return deployment.contractAddress;
  }

  throw new Error(
    "❌ BlackSwanOS contract address not found.\n" +
      "   Deploy first using one of:\n" +
      "     node scripts/orchestrator.js\n" +
      "     npx hardhat run scripts/deploy.js --network localhost\n" +
      "   or set the CONTRACT_ADDRESS environment variable manually."
  );
}

/** Returns the USDC address used at deploy time (fallback: Base mainnet USDC). */
function getUsdcAddress() {
  if (process.env.USDC_ADDRESS) return process.env.USDC_ADDRESS;

  const deployment = readDeploymentFile();
  if (deployment && deployment.usdcAddress) return deployment.usdcAddress;

  return DEFAULT_USDC_ADDRESS;
}

module.exports = {
  ROOT_DIR,
  DEPLOYMENT_FILE,
  DEFAULT_USDC_ADDRESS,
  DEFAULT_BASE_SEPOLIA_USDC_ADDRESS,
  PLACEHOLDER_ADDRESS,
  readDeploymentFile,
  writeDeploymentFile,
  getContractAddress,
  getUsdcAddress,
};
