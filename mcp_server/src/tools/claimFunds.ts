import {
  ESCROW_STATE_NAMES,
  escrowContract,
  escrowContractReadOnly,
} from "../chain.js";

export interface ClaimFundsInput {
  escrowId: string;
}

export interface ClaimFundsOutput {
  escrowId: string;
  txHash: string;
  stateBefore: string;
  stateAfter: string;
  note: string;
}

/**
 * Permissionless happy-path release after disputeWindow elapses with no dispute.
 * Anyone (buyer, seller, keeper agent) may call this — payouts still go to the
 * correct on-chain recipients (seller price+collateral, owner system fee).
 */
export async function claimFunds(
  input: ClaimFundsInput
): Promise<ClaimFundsOutput> {
  const escrowId = BigInt(input.escrowId);
  const before = await escrowContractReadOnly.getEscrow(escrowId);
  const stateBefore =
    ESCROW_STATE_NAMES[Number(before.state)] ?? "UNKNOWN";

  if (stateBefore !== "LOCKED") {
    throw new Error(
      `claim_funds requires LOCKED escrow; escrow ${escrowId} is ${stateBefore}. ` +
        `Use claim_resolved if state is RESOLVED.`
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const openAt = Number(before.lockTime) + Number(before.disputeWindow);
  if (now < openAt) {
    throw new Error(
      `disputeWindow still active for escrow ${escrowId}: ` +
        `claimable after unix ${openAt} (~${openAt - now}s). ` +
        `Raise dispute instead, or wait.`
    );
  }

  const tx = await escrowContract.claimFunds(escrowId);
  const receipt = await tx.wait();
  const after = await escrowContractReadOnly.getEscrow(escrowId);

  return {
    escrowId: escrowId.toString(),
    txHash: receipt.hash,
    stateBefore,
    stateAfter: ESCROW_STATE_NAMES[Number(after.state)] ?? "UNKNOWN",
    note: "Happy-path release. Seller received price+collateral; owner received systemFee.",
  };
}
