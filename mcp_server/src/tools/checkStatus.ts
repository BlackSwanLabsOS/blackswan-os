import { ethers } from "ethers";
import {
  DISPUTE_OUTCOME_NAMES,
  ESCROW_STATE_NAMES,
  escrowContractReadOnly,
} from "../chain.js";
import { USDC_DECIMALS } from "../config.js";

export interface CheckStatusInput {
  escrowId: string;
}

export interface CheckStatusOutput {
  escrowId: string;
  buyer: string;
  seller: string;
  state: string;
  outcome: string;
  payloadPriceUsdc: string;
  sellerCollateralUsdc: string;
  systemFeeUsdc: string;
  arbitrationFeeUsdc: string;
  payloadHash: string;
  createdAt: string;
  lockTime: string;
  disputeRaisedAt: string;
  /** address(0) (as a string) if this escrow was never disputed. */
  disputeRaisedBy: string;
  disputeBondUsdc: string;
  /** True if settled via the owner's `emergencyResolve` fallback instead of
   *  the normal oracle `resolveDispute` path (dispute-bond security fix). */
  resolvedByFallbackArbiter: boolean;
  /** Buyer-declared payload size ceiling in bytes (file-size DoS mitigation). */
  maxFileSize: string;
  /** Buyer-chosen window (seconds) after `sellerLock` during which either
   *  party may `raiseDispute`; `claimFunds` only opens up once this elapses. */
  disputeWindowSeconds: string;
}

/** Read-only, zero-gas lookup of an escrow's full on-chain state. */
export async function checkStatus(
  input: CheckStatusInput
): Promise<CheckStatusOutput> {
  const escrowId = BigInt(input.escrowId);
  const escrow = await escrowContractReadOnly.getEscrow(escrowId);

  return {
    escrowId: escrowId.toString(),
    buyer: escrow.buyer,
    seller: escrow.seller,
    state: ESCROW_STATE_NAMES[Number(escrow.state)] ?? "UNKNOWN",
    outcome: DISPUTE_OUTCOME_NAMES[Number(escrow.outcome)] ?? "UNKNOWN",
    payloadPriceUsdc: ethers.formatUnits(escrow.payloadPrice, USDC_DECIMALS),
    sellerCollateralUsdc: ethers.formatUnits(
      escrow.sellerCollateral,
      USDC_DECIMALS
    ),
    systemFeeUsdc: ethers.formatUnits(
      escrow.systemFeeSnapshot,
      USDC_DECIMALS
    ),
    arbitrationFeeUsdc: ethers.formatUnits(
      escrow.arbitrationFeeSnapshot,
      USDC_DECIMALS
    ),
    payloadHash: escrow.payloadHash,
    createdAt: escrow.createdAt.toString(),
    lockTime: escrow.lockTime.toString(),
    disputeRaisedAt: escrow.disputeRaisedAt.toString(),
    disputeRaisedBy: escrow.disputeRaisedBy,
    disputeBondUsdc: ethers.formatUnits(
      escrow.disputeBondSnapshot,
      USDC_DECIMALS
    ),
    resolvedByFallbackArbiter: escrow.resolvedByFallbackArbiter,
    maxFileSize: escrow.maxFileSize.toString(),
    disputeWindowSeconds: escrow.disputeWindow.toString(),
  };
}
