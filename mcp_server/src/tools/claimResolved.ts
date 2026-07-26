import {
  DISPUTE_OUTCOME_NAMES,
  ESCROW_STATE_NAMES,
  escrowContract,
  escrowContractReadOnly,
} from "../chain.js";

export interface ClaimResolvedInput {
  escrowId: string;
}

export interface ClaimResolvedOutput {
  escrowId: string;
  txHash: string;
  stateBefore: string;
  stateAfter: string;
  outcome: string;
  note: string;
}

/**
 * Permissionless settlement after Oracle `resolveDispute` left the escrow
 * in RESOLVED. Pays parties + always-on arbitrationFee (S-03) + systemFee.
 */
export async function claimResolved(
  input: ClaimResolvedInput
): Promise<ClaimResolvedOutput> {
  const escrowId = BigInt(input.escrowId);
  const before = await escrowContractReadOnly.getEscrow(escrowId);
  const stateBefore =
    ESCROW_STATE_NAMES[Number(before.state)] ?? "UNKNOWN";

  if (stateBefore !== "RESOLVED") {
    throw new Error(
      `claim_resolved requires RESOLVED escrow; escrow ${escrowId} is ${stateBefore}. ` +
        `Use claim_funds for LOCKED happy-path after the dispute window.`
    );
  }

  const tx = await escrowContract.claimResolved(escrowId);
  const receipt = await tx.wait();
  const after = await escrowContractReadOnly.getEscrow(escrowId);
  const outcome =
    DISPUTE_OUTCOME_NAMES[Number(after.outcome)] ?? "UNKNOWN";

  return {
    escrowId: escrowId.toString(),
    txHash: receipt.hash,
    stateBefore,
    stateAfter: ESCROW_STATE_NAMES[Number(after.state)] ?? "UNKNOWN",
    outcome,
    note:
      "Dispute settlement complete (includes arbitrationFee to owner on every outcome).",
  };
}
