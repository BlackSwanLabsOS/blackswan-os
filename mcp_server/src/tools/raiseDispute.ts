import {
  ESCROW_STATE_NAMES,
  escrowContract,
  escrowContractReadOnly,
  wallet,
} from "../chain.js";
import { submitPayloadToOracle, type OracleDisputeResult } from "../oracleClient.js";
import { ethers } from "ethers";
import { USDC_DECIMALS } from "../config.js";
import { ensureAllowance } from "../ensureAllowance.js";

export interface RaiseDisputeInput {
  escrowId: string;
  /**
   * EXACT raw JSON payload text, byte-for-byte identical to what the
   * seller SHA-256 hashed for their on-chain commitment. Do not
   * re-serialize/reformat a parsed object here — any whitespace or key
   * ordering difference will change the hash and fail the Oracle's
   * Step 3 raw-bytes hash check.
   */
  payload: string;
}

export interface RaiseDisputeOutput {
  escrowId: string;
  onChainTxHash: string | null;
  onChainAction: "raised" | "already_disputed";
  /** USDC bond paid to raise this dispute; "0.0" if not applicable
   *  (already_disputed) or if the hybrid bond formula currently resolves to 0. */
  disputeBondPaidUsdc: string;
  oracleResult: OracleDisputeResult;
}

/**
 * Raise a dispute for a LOCKED escrow, then forward the raw payload to
 * the Python Oracle for independent zero-trust validation.
 *
 * The MCP server makes no judgment about payload validity itself — it
 * only (a) transitions the escrow to DISPUTED on-chain if needed, and
 * (b) relays the raw bytes to the Oracle's REST endpoint, which
 * re-fetches buyer/seller/payloadHash directly from chain before
 * running its pipeline.
 */
export async function raiseDispute(
  input: RaiseDisputeInput
): Promise<RaiseDisputeOutput> {
  const escrowId = BigInt(input.escrowId);

  const current = await escrowContractReadOnly.getEscrow(escrowId);
  const currentStateName =
    ESCROW_STATE_NAMES[Number(current.state)] ?? "UNKNOWN";

  let onChainTxHash: string | null = null;
  let onChainAction: "raised" | "already_disputed";
  let disputeBondPaid = 0n;

  if (currentStateName === "DISPUTED") {
    // Idempotent: counterparty may have already raised it.
    onChainAction = "already_disputed";
  } else if (currentStateName === "LOCKED") {
    // Security fix: `raiseDispute` now pulls a HYBRID bond in USDC from the
    // disputer (refunded if their claim is upheld, forfeited otherwise — see
    // BlackSwanOS.sol audit notes on the old free-dispute exploit). The bond
    // is `max(payloadPrice * disputeBondBps / BPS_DENOMINATOR, minDisputeBond)`
    // — computed here client-side from the SAME on-chain params the contract
    // itself will use in `raiseDispute`, so we approve/pull the exact amount
    // instead of guessing. Approve first, same pattern as `createEscrow`.
    const [disputeBondBps, minDisputeBond, bpsDenominator] =
      await Promise.all([
        escrowContract.disputeBondBps(),
        escrowContract.minDisputeBond(),
        escrowContract.BPS_DENOMINATOR(),
      ]);
    const percentageBond =
      (BigInt(current.payloadPrice) * BigInt(disputeBondBps)) /
      BigInt(bpsDenominator);
    disputeBondPaid =
      percentageBond > BigInt(minDisputeBond)
        ? percentageBond
        : BigInt(minDisputeBond);

    if (disputeBondPaid > 0n) {
      const disputerAddress = await wallet.getAddress();
      const escrowAddress = await escrowContract.getAddress();
      await ensureAllowance(disputerAddress, escrowAddress, disputeBondPaid);
    }

    const tx = await escrowContract.raiseDispute(escrowId);
    const receipt = await tx.wait();
    onChainTxHash = receipt.hash;
    onChainAction = "raised";
  } else {
    throw new Error(
      `Cannot raise dispute: escrow ${escrowId} is in state ` +
        `${currentStateName}, expected LOCKED or DISPUTED`
    );
  }

  const oracleResult = await submitPayloadToOracle(
    Number(escrowId),
    input.payload
  );

  return {
    escrowId: escrowId.toString(),
    onChainTxHash,
    onChainAction,
    disputeBondPaidUsdc: ethers.formatUnits(disputeBondPaid, USDC_DECIMALS),
    oracleResult,
  };
}
