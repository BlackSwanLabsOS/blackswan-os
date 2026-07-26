// NOTE: `hardhat-toolbox` does NOT load .env automatically — without this line
// process.env.PRIVATE_KEY / BASE_SEPOLIA_RPC_URL / BASESCAN_API_KEY would
// always be `undefined` on a real deploy (on `localhost` nobody noticed because
// that network does not need keys — Hardhat takes accounts directly from the
// local node).
require("dotenv").config({ path: require("node:path").join(__dirname, ".env") });
require("@nomicfoundation/hardhat-toolbox");

/**
 * Hardhat validates the `accounts` format for ALL configured networks on
 * EVERY command (even `hardhat compile`), regardless of whether that network
 * is actually used. Without this filter, a placeholder in .env
 * (e.g. `PRIVATE_KEY=0xYOUR_DEPLOYER_PRIVATE_KEY_HERE`) would break the
 * config on EVERY command, including a plain local `npm run simulate`. We
 * therefore treat any key that is not valid 32-byte hex as missing — the real
 * error still surfaces when you try to deploy to that network.
 */
function resolvePrivateKey(rawValue, envVarName) {
  if (!rawValue) return [];
  // Common mistake: some wallets (e.g. MetaMask "copy private key") copy the
  // key WITHOUT the "0x" prefix — we normalize instead of silently rejecting
  // a valid key just because the prefix is missing.
  const normalized = rawValue.startsWith("0x") ? rawValue : `0x${rawValue}`;
  if (/^0x[0-9a-fA-F]{64}$/.test(normalized)) return [normalized];
  console.warn(
    `⚠️  ${envVarName} in .env does not look like a valid private key (expected 0x + 64 hex chars) — ignoring it.`
  );
  return [];
}

// Base Sepolia testnet config — extracted to a variable because Hardhat matches
// the network name from `--network` EXACTLY 1:1 (string match). Some
// commands/docs/habits use a hyphenated name (`base-sepolia`), others camelCase
// (`baseSepolia`) — so both `--network base-sepolia` (HH100: "Network
// base-sepolia doesn't exist") AND `--network baseSepolia` (used by npm run
// deploy:sepolia / smoke:sepolia) work, we register the same object under
// TWO keys below.
const baseSepoliaNetwork = {
  url: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
  accounts: resolvePrivateKey(process.env.PRIVATE_KEY, "PRIVATE_KEY"),
  chainId: 84532,
};

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: "0.8.24",
  networks: {
    base: {
      url: "https://mainnet.base.org",
      accounts: resolvePrivateKey(process.env.PRIVATE_KEY, "PRIVATE_KEY"),
    },
    baseSepolia: baseSepoliaNetwork,
    "base-sepolia": baseSepoliaNetwork,
  },
  // Source verification (plugin `@nomicfoundation/hardhat-verify`, included
  // by `hardhat-toolbox` as a peer dependency — see package.json).
  //
  // IMPORTANT — migration to Etherscan API V2 (May 2025, BaseScan now runs on
  // the same SHARED infrastructure as Etherscan):
  //   - `apiKey` MUST be a SINGLE string (one key from etherscan.io, valid for
  //     MULTIPLE chains including Base and Base Sepolia), NOT a per-network
  //     object ({ base: "...", baseSepolia: "..." }). The plugin checks
  //     `typeof apiKey` — string => V2 mode (correct endpoint
  //     https://api.etherscan.io/v2/api?chainid=...), object => OLD V1 mode
  //     (per-explorer apiURL), which BaseScan already rejects with
  //     "deprecated V1 endpoint" — that was exactly the error.
  //   - `customChains` for `base`/`baseSepolia` (chainId 8453/84532) are NO
  //     longer needed — the plugin has them BUILT IN (see
  //     node_modules/@nomicfoundation/hardhat-verify/internal/chain-config.js)
  //     and in V2 mode matches the network by the real chainId from RPC
  //     (eth_chainId), NOT by the `--network` name — so our `base-sepolia`
  //     (hyphen) alias also works automatically, without a customChains entry.
  //   - Generate the API key at https://etherscan.io/myapikey (NOT
  //     basescan.org — from V2 onward it is one shared dashboard/key).
  etherscan: {
    apiKey: process.env.BASESCAN_API_KEY || process.env.ETHERSCAN_API_KEY || "",
  },
};
