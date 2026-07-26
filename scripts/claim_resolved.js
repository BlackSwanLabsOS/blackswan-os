/**
 * scripts/claim_resolved.js
 *
 * Calls claimResolved(escrowId) — permissionless, so any funded wallet can
 * trigger it. Escrow must be in RESOLVED state (i.e. resolveDispute already
 * ran). Pass the escrow id via CLAIM_ESCROW_ID env var (defaults to 4).
 *
 * Usage:
 *   CLAIM_ESCROW_ID=4 npx hardhat run scripts/claim_resolved.js --network baseSepolia
 */

const { ethers } = require("hardhat");
const { getContractAddress } = require("./deployment");

async function main() {
  const escrowId = process.env.CLAIM_ESCROW_ID || "4";
  const contractAddress = getContractAddress();
  const provider = ethers.provider;

  const wallet = new ethers.Wallet(
    process.env.SEPOLIA_BUYER_PRIVATE_KEY.startsWith("0x")
      ? process.env.SEPOLIA_BUYER_PRIVATE_KEY
      : `0x${process.env.SEPOLIA_BUYER_PRIVATE_KEY}`,
    provider
  );

  const contract = await ethers.getContractAt("BlackSwanOS", contractAddress);

  const before = await contract.getEscrow(escrowId);
  console.log(`Escrow ${escrowId} state before claim: ${before.state} (3 = RESOLVED)`);
  // Matches DisputeOutcome enum order in BlackSwanOS.sol / constants.py
  console.log(`Outcome: ${before.outcome} (0=NONE,1=SELLER_CHEATED,2=BUYER_CHEATED,3=SELLER_VALID)`);

  const owner = await contract.owner();
  console.log(`Contract owner() (odbiorca systemFee): ${owner}`);

  const tx = await contract.connect(wallet).claimResolved(escrowId);
  const receipt = await tx.wait();
  console.log(`claimResolved tx: https://sepolia.basescan.org/tx/${receipt.hash}`);

  const after = await contract.getEscrow(escrowId);
  console.log(`Escrow ${escrowId} state after claim: ${after.state} (4 = CLAIMED)`);
}

main().catch((error) => {
  console.error("Claim failed:", error.message || error);
  process.exit(1);
});
