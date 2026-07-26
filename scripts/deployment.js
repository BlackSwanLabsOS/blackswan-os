/**
 * Shared helper for reading/writing the "gdzie jest aktualnie wdrożony
 * kontrakt BlackSwanOS" (deployment.json) — pojedyncze źródło prawdy
 * używane przez scripts/deploy.js, simulate.js oraz watcher.js, żeby
 * nikt nie musiał już ręcznie wklejać adresu kontraktu.
 */

const fs = require("node:fs");
const path = require("node:path");

const ROOT_DIR = path.join(__dirname, "..");
const DEPLOYMENT_FILE = path.join(ROOT_DIR, "deployment.json");

/** Domyślny adres USDC na Base mainnet (używany też przy forkowaniu sieci). */
const DEFAULT_USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/** Domyślny adres testowego USDC (Circle) na Base Sepolia. */
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
 * Zwraca aktualny adres kontraktu BlackSwanOS.
 * Priorytet: CONTRACT_ADDRESS w env (o ile nie jest placeholderem 0x0) -> deployment.json.
 * Rzuca zrozumiały błąd po polsku, jeśli nic nie znaleziono.
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
    "❌ Nie znaleziono adresu kontraktu BlackSwanOS.\n" +
      "   Odpal najpierw deployment jedną z metod:\n" +
      "     node scripts/orchestrator.js\n" +
      "     npx hardhat run scripts/deploy.js --network localhost\n" +
      "   albo ustaw ręcznie zmienną środowiskową CONTRACT_ADDRESS."
  );
}

/** Zwraca adres USDC użyty przy deployu (fallback: Base mainnet USDC). */
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
