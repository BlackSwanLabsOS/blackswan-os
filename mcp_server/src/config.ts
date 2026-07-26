import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Prefer mcp_server/.env, then optionally inherit ORACLE_HTTP_SECRET from oracle/.env
loadDotenv({ path: join(__dirname, "..", ".env") });

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function loadOracleHttpSecret(): string {
  const fromEnv = (process.env.ORACLE_HTTP_SECRET ?? "").trim();
  if (fromEnv) return fromEnv;
  const oracleEnv = join(__dirname, "..", "..", "oracle", ".env");
  if (!existsSync(oracleEnv)) return "";
  const match = readFileSync(oracleEnv, "utf8").match(/^ORACLE_HTTP_SECRET=(.*)$/m);
  return match ? match[1].trim() : "";
}

export const config = {
  rpcUrl: process.env.RPC_URL ?? "https://sepolia.base.org",
  chainId: Number(process.env.CHAIN_ID ?? "84532"),
  contractAddress: required("CONTRACT_ADDRESS"),
  usdcAddress: required("USDC_ADDRESS"),
  agentPrivateKey: required("AGENT_PRIVATE_KEY"),
  oracleBaseUrl: process.env.ORACLE_BASE_URL ?? "http://localhost:8000",
  /** Must match oracle/.env ORACLE_HTTP_SECRET (header X-Oracle-Secret). */
  oracleHttpSecret: loadOracleHttpSecret(),
};

/** USDC on Base uses 6 decimals natively (never 18). */
export const USDC_DECIMALS = 6;
