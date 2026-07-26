/**
 * Shared helper: load ORACLE_HTTP_SECRET for scripts that POST payloads.
 * Prefers process.env, falls back to oracle/.env.
 */
const fs = require("node:fs");
const path = require("node:path");

function loadOracleHttpSecret() {
  if (process.env.ORACLE_HTTP_SECRET && process.env.ORACLE_HTTP_SECRET.trim()) {
    return process.env.ORACLE_HTTP_SECRET.trim();
  }
  try {
    const envPath = path.join(__dirname, "..", "oracle", ".env");
    const text = fs.readFileSync(envPath, "utf8");
    const match = text.match(/^ORACLE_HTTP_SECRET=(.*)$/m);
    if (match) return match[1].trim();
  } catch {
    // ignore
  }
  return "";
}

/** Headers for POST /disputes/{id}/payload (and optionally Content-Type). */
function oraclePayloadHeaders(extra = {}) {
  const secret = loadOracleHttpSecret();
  if (!secret) {
    throw new Error(
      "ORACLE_HTTP_SECRET missing — set it in oracle/.env (header X-Oracle-Secret). " +
        "Restart the Oracle after adding it."
    );
  }
  return {
    "X-Oracle-Secret": secret,
    ...extra,
  };
}

module.exports = { loadOracleHttpSecret, oraclePayloadHeaders };
