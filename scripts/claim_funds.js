/**
 * scripts/claim_funds.js
 *
 * Permissionless happy-path release: claimFunds(escrowId).
 * Escrow must be LOCKED and disputeWindow must have elapsed.
 *
 *   CLAIM_ESCROW_ID=12 npm run claim:funds
 */

const { ethers } = require("hardhat");
const { getContractAddress } = require("./deployment");

function requirePrivateKey(key) {
  const raw = process.env[key];
  if (!raw) throw new Error(`Missing env ${key}`);
  const normalized = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) throw new Error(`${key} invalid`);
  return normalized;
}

async function main() {
  const escrowId = process.env.CLAIM_ESCROW_ID;
  if (escrowId === undefined || escrowId === "") {
    throw new Error("Set CLAIM_ESCROW_ID (e.g. CLAIM_ESCROW_ID=12 npm run claim:funds)");
  }

  const contractAddress = getContractAddress();
  const provider = ethers.provider;
  const wallet = new ethers.Wallet(requirePrivateKey("SEPOLIA_BUYER_PRIVATE_KEY"), provider);
  const contract = await ethers.getContractAt("BlackSwanOS", contractAddress);

  const before = await contract.getEscrow(escrowId);
  console.log(`Escrow ${escrowId} state before: ${before.state} (1=LOCKED, 4=CLAIMED)`);
  console.log(`lockTime=${before.lockTime} disputeWindow=${before.disputeWindow}`);

  const tx = await contract.connect(wallet).claimFunds(escrowId);
  const receipt = await tx.wait();
  console.log(`claimFunds tx: https://sepolia.basescan.org/tx/${receipt.hash}`);
  console.log(`receipt status: ${receipt.status} (1=success)`);

  // Public Sepolia RPC can return a stale getEscrow right after mining.
  let after = null;
  for (let i = 0; i < 8; i += 1) {
    after = await contract.getEscrow(escrowId);
    if (Number(after.state) === 4) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  console.log(`Escrow ${escrowId} state after: ${after.state} (expect 4=CLAIMED)`);
}

main().catch((error) => {
  console.error("claimFunds failed:", error.message || error);
  process.exit(1);
});
