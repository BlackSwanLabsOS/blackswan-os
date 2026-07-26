import { createHash } from "node:crypto";
import { ethers } from "ethers";
import {
  ESCROW_STATE_NAMES,
  escrowContract,
  escrowContractReadOnly,
  wallet,
} from "../chain.js";
import { USDC_DECIMALS } from "../config.js";
import { ensureAllowance } from "../ensureAllowance.js";

export interface SellerLockInput {
  escrowId: string;
  /**
   * EXACT raw JSON payload text (byte-for-byte) that this agent, acting as
   * Seller, commits to delivering. SHA-256-hashed here and stored on-chain
   * as `payloadHash` — if a dispute is later raised, the Oracle re-hashes
   * whatever bytes are actually submitted and compares them against THIS
   * commitment (Step 3 of its validation pipeline). Do not
   * re-serialize/reformat the payload after locking (different whitespace
   * or key ordering changes the hash) — deliver these EXACT bytes, or this
   * agent will be penalized as SELLER_CHEATED on a hash mismatch even if
   * the underlying data is otherwise valid.
   */
  payload: string;
}

export interface SellerLockOutput {
  escrowId: string;
  seller: string;
  payloadHash: string;
  sellerCollateralUsdc: string;
  lockTime: string;
  txHash: string;
}

/**
 * Lock 200% USDC collateral and commit to a SHA-256 hash of the payload,
 * acting as the Seller on an `AWAITING_SELLER` escrow.
 *
 * Approves USDC collateral (reads the CURRENT on-chain `payloadPrice` +
 * `COLLATERAL_BPS`/`BPS_DENOMINATOR` — never a cached/assumed value) if the
 * existing allowance is insufficient, then calls
 * `sellerLock(escrowId, payloadHash)`. After this, the buyer/seller may
 * `raiseDispute` during the escrow's `disputeWindow`, or anyone may call
 * `claimFunds` (happy-path auto-release) once it elapses undisputed.
 */
export async function sellerLock(
  input: SellerLockInput
): Promise<SellerLockOutput> {
  const escrowId = BigInt(input.escrowId);

  const escrow = await escrowContractReadOnly.getEscrow(escrowId);
  const currentStateName =
    ESCROW_STATE_NAMES[Number(escrow.state)] ?? "UNKNOWN";

  if (currentStateName !== "AWAITING_SELLER") {
    throw new Error(
      `Cannot lock: escrow ${escrowId} is in state ${currentStateName}, expected AWAITING_SELLER`
    );
  }

  const sellerAddress = await wallet.getAddress();
  if (escrow.seller.toLowerCase() !== sellerAddress.toLowerCase()) {
    throw new Error(
      `This agent's wallet (${sellerAddress}) is not the designated seller ` +
        `(${escrow.seller}) for escrow ${escrowId}`
    );
  }

  // SHA-256 of the raw UTF-8 bytes — MUST match what the Oracle computes
  // in `oracle/validation/hash_check.py` (`hashlib.sha256(raw).digest()`)
  // over the exact bytes it later receives via `raise_dispute`.
  const payloadHash = `0x${createHash("sha256")
    .update(input.payload, "utf-8")
    .digest("hex")}`;

  // Collateral is derived on-chain in `_sellerCollateral`, but we need it
  // client-side up front to know how much USDC to approve.
  const [collateralBps, bpsDenominator] = await Promise.all([
    escrowContract.COLLATERAL_BPS(),
    escrowContract.BPS_DENOMINATOR(),
  ]);
  const sellerCollateral =
    (BigInt(escrow.payloadPrice) * BigInt(collateralBps)) /
    BigInt(bpsDenominator);

  const escrowAddress = await escrowContract.getAddress();
  await ensureAllowance(sellerAddress, escrowAddress, sellerCollateral);

  const tx = await escrowContract.sellerLock(escrowId, payloadHash);
  const receipt = await tx.wait();

  const lockedEvent = receipt.logs
    .map((log: ethers.Log) => {
      try {
        return escrowContract.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find(
      (parsed: ethers.LogDescription | null) => parsed?.name === "SellerLocked"
    );

  const lockTime: bigint = lockedEvent
    ? (lockedEvent.args.lockTime as bigint)
    : (await escrowContractReadOnly.getEscrow(escrowId)).lockTime;

  return {
    escrowId: escrowId.toString(),
    seller: sellerAddress,
    payloadHash,
    sellerCollateralUsdc: ethers.formatUnits(sellerCollateral, USDC_DECIMALS),
    lockTime: lockTime.toString(),
    txHash: receipt.hash,
  };
}
