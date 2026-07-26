/**
 * Clean local oracle_state.db test history (NOT on-chain — BaseScan / GRANT log stay).
 *
 * Keeps only the live emergency drill row for the current contract (escrow #7 PENDING)
 * unless CLEAN_KEEP_ESCROW is unset/empty.
 *
 *   node scripts/cleanup_oracle_db.js
 *   CLEAN_KEEP_ESCROW=7 node scripts/cleanup_oracle_db.js
 *   CLEAN_WIPE_ALL=1 node scripts/cleanup_oracle_db.js   # wipe disputes+bans entirely
 */

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.join(__dirname, "..");
const dbPath = path.join(ROOT, "oracle", "oracle_state.db");

function readContract() {
  if (process.env.CONTRACT_ADDRESS) return process.env.CONTRACT_ADDRESS.toLowerCase();
  try {
    const d = JSON.parse(fs.readFileSync(path.join(ROOT, "deployment.json"), "utf8"));
    return String(d.contractAddress || "").toLowerCase();
  } catch {
    return "";
  }
}

function main() {
  if (!fs.existsSync(dbPath)) {
    console.log("No DB at", dbPath);
    return;
  }

  const contract = readContract();
  const wipeAll = String(process.env.CLEAN_WIPE_ALL || "") === "1";
  const keepId = process.env.CLEAN_KEEP_ESCROW ?? "7";

  const db = new DatabaseSync(dbPath);
  const before = db.prepare("SELECT COUNT(*) AS n FROM disputes").get().n;
  const bansBefore = db.prepare("SELECT COUNT(*) AS n FROM banned_users").get().n;

  if (wipeAll) {
    db.exec("DELETE FROM disputes; DELETE FROM banned_users; DELETE FROM emergency_alerts;");
    console.log(`Wiped all disputes/bans/alerts (was disputes=${before} bans=${bansBefore})`);
    db.close();
    return;
  }

  // Drop everything except optional keep row on current contract.
  db.prepare("DELETE FROM banned_users").run();
  db.prepare("DELETE FROM emergency_alerts").run();

  if (contract && keepId !== "") {
    db.prepare(
      "DELETE FROM disputes WHERE NOT (lower(contract_address) = ? AND escrow_id = ?)"
    ).run(contract, Number(keepId));
    // Ensure keep row exists as PENDING for ops visibility
    db.prepare(
      `INSERT INTO disputes (contract_address, escrow_id, status, timestamp)
       VALUES (?, ?, 'PENDING', ?)
       ON CONFLICT(contract_address, escrow_id) DO UPDATE SET status='PENDING'`
    ).run(contract, Number(keepId), Math.floor(Date.now() / 1000));
  } else {
    db.exec("DELETE FROM disputes");
  }

  const after = db.prepare("SELECT COUNT(*) AS n FROM disputes").get().n;
  const left = db.prepare("SELECT * FROM disputes").all();
  console.log(`Cleaned disputes ${before} → ${after}; bans ${bansBefore} → 0`);
  console.log("Remaining:", JSON.stringify(left, null, 2));
  db.close();
}

main();
