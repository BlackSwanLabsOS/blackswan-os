import { ethers } from "ethers";
import {
  escrowContract,
  escrowContractReadOnly,
  wallet,
} from "../chain.js";
import { USDC_DECIMALS } from "../config.js";
import { ensureAllowance } from "../ensureAllowance.js";

export interface CreateEscrowInput {
  sellerAddress: string;
  payloadPriceUsdc: string;
  /**
   * Max size (bytes) of the payload the seller may deliver — DoS
   * mitigation, enforced off-chain by the Oracle before it buffers a
   * submitted payload into memory. Optional: defaults to the contract's
   * `MAX_ALLOWED_FILE_SIZE` ceiling (currently 100 KB) if omitted.
   */
  maxFileSizeBytes?: number;
  /**
   * Seconds after `sellerLock` during which either party may
   * `raiseDispute`; `claimFunds` (happy-path auto-release, callable by
   * anyone) only opens up once this elapses with no dispute. Optional:
   * defaults to the contract's `MIN_DISPUTE_WINDOW` floor (currently 1h)
   * if omitted. Must be within `[MIN_DISPUTE_WINDOW, MAX_DISPUTE_WINDOW]`.
   */
  disputeWindowSeconds?: number;
}

export interface CreateEscrowOutput {
  escrowId: string;
  buyer: string;
  seller: string;
  payloadPriceUsdc: string;
  systemFeeUsdc: string;
  totalLockedUsdc: string;
  maxFileSize: string;
  disputeWindowSeconds: string;
  txHash: string;
}

/**
 * Create a new BlackSwanOS escrow, acting as the Buyer.
 *
 * Reads the CURRENT on-chain `systemFeeBps` (never a cached/assumed value —
 * fees can change) and computes `payloadPrice * systemFeeBps / BPS_DENOMINATOR`
 * to get the exact deposit, approves USDC if the existing allowance is
 * insufficient, then calls `createEscrow`.
 */
export async function createEscrow(
  input: CreateEscrowInput
): Promise<CreateEscrowOutput> {
  const { sellerAddress, payloadPriceUsdc } = input;

  if (!ethers.isAddress(sellerAddress)) {
    throw new Error(`Invalid sellerAddress: ${sellerAddress}`);
  }

  const payloadPriceUnits = ethers.parseUnits(payloadPriceUsdc, USDC_DECIMALS);
  if (payloadPriceUnits <= 0n) {
    throw new Error("payloadPriceUsdc must be greater than zero");
  }

  // Defaults sourced live from the contract's own constants — never
  // hardcoded here — so they can never drift out of sync with an on-chain
  // upgrade/redeploy.
  const maxAllowedFileSize: bigint = await escrowContract.MAX_ALLOWED_FILE_SIZE();
  const minDisputeWindow: bigint = await escrowContract.MIN_DISPUTE_WINDOW();
  const maxDisputeWindow: bigint = await escrowContract.MAX_DISPUTE_WINDOW();

  const maxFileSize =
    input.maxFileSizeBytes !== undefined
      ? BigInt(input.maxFileSizeBytes)
      : maxAllowedFileSize;
  if (maxFileSize <= 0n || maxFileSize > maxAllowedFileSize) {
    throw new Error(
      `maxFileSizeBytes must be in (0, ${maxAllowedFileSize}] bytes`
    );
  }

  const disputeWindow =
    input.disputeWindowSeconds !== undefined
      ? BigInt(input.disputeWindowSeconds)
      : minDisputeWindow;
  if (disputeWindow < minDisputeWindow || disputeWindow > maxDisputeWindow) {
    throw new Error(
      `disputeWindowSeconds must be in [${minDisputeWindow}, ${maxDisputeWindow}] seconds`
    );
  }

  // Size-scaled price floor (anti-griefing: a cheap escrow declaring a large
  // maxFileSize would otherwise force an expensive off-chain LLM judgment
  // call for a disproportionately small dispute bond — see BlackSwanOS.sol
  // `setPricingParams` NatSpec). Check BEFORE sending a transaction that
  // would otherwise revert on-chain with an opaque InvalidAmount().
  const minRequired: bigint = await escrowContractReadOnly.minRequiredPrice(
    maxFileSize
  );
  if (payloadPriceUnits < minRequired) {
    throw new Error(
      `payloadPriceUsdc (${payloadPriceUsdc} USDC) is below the minimum required ` +
        `for a ${maxFileSize}-byte maxFileSize: ${ethers.formatUnits(
          minRequired,
          USDC_DECIMALS
        )} USDC. Either raise payloadPriceUsdc or lower maxFileSizeBytes.`
    );
  }

  const systemFeeBps: bigint = await escrowContract.systemFeeBps();
  const bpsDenominator: bigint = await escrowContract.BPS_DENOMINATOR();
  const systemFee = (payloadPriceUnits * systemFeeBps) / bpsDenominator;
  const totalDeposit = payloadPriceUnits + systemFee;

  const buyerAddress = await wallet.getAddress();
  const escrowAddress = await escrowContract.getAddress();
  await ensureAllowance(buyerAddress, escrowAddress, totalDeposit);

  const tx = await escrowContract.createEscrow(
    sellerAddress,
    payloadPriceUnits,
    maxFileSize,
    disputeWindow
  );
  const receipt = await tx.wait();

  const createdEvent = receipt.logs
    .map((log: ethers.Log) => {
      try {
        return escrowContract.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find(
      (parsed: ethers.LogDescription | null) => parsed?.name === "EscrowCreated"
    );

  const escrowId: bigint = createdEvent
    ? (createdEvent.args.escrowId as bigint)
    : (await escrowContract.nextEscrowId()) - 1n;

  return {
    escrowId: escrowId.toString(),
    buyer: buyerAddress,
    seller: sellerAddress,
    payloadPriceUsdc,
    systemFeeUsdc: ethers.formatUnits(systemFee, USDC_DECIMALS),
    totalLockedUsdc: ethers.formatUnits(totalDeposit, USDC_DECIMALS),
    maxFileSize: maxFileSize.toString(),
    disputeWindowSeconds: disputeWindow.toString(),
    txHash: receipt.hash,
  };
}
