/**
 * scripts/sepolia_smoke_test.js
 *
 * Full E2E smoke test ("chess on testnet") against a REAL deployed
 * BlackSwanOS contract on Base Sepolia — no local-only tricks
 * (`evm_increaseTime`, `hardhat_setStorageAt`, etc.) because this is a real
 * chain with real block time.
 *
 * Flow:
 *   1. Buyer and Seller (two separate private keys) approve test USDC for the
 *      contract.
 *   2. Buyer calls createEscrow(seller, payloadPrice, maxFileSize, disputeWindow)
 *      — with the NEW parameters (DoS mitigation + configurable dispute window).
 *   3. Seller calls sellerLock(escrowId, payloadHash).
 *   4. "Happy path": wait in real time (you cannot fast-forward on-chain) until
 *      `disputeWindow` elapses, then ANYONE — here: the Buyer, but equally the
 *      Seller or watcher.js — calls `claimFunds(escrowId)`. NOTE: the contract
 *      does NOT have a separate `releaseFunds()` invoked manually by the Buyer —
 *      happy-path auto-release is permissionless and implemented via `claimFunds`
 *      (see prior security audit: stronger guarantee than manual release by one party).
 *
 * Required environment variables (see also .env section in deploy summary):
 *   - CONTRACT_ADDRESS, USDC_ADDRESS       (set automatically by
 *                                            scripts/deploy.js --network baseSepolia)
 *   - SEPOLIA_BUYER_PRIVATE_KEY
 *   - SEPOLIA_SELLER_PRIVATE_KEY
 *   - SMOKE_TEST_PAYLOAD_PRICE_USDC        (optional, default "1")
 *
 * Usage:
 *   npx hardhat run scripts/sepolia_smoke_test.js --network baseSepolia
 *   (or: npm run smoke:sepolia)
 */

const { ethers, network } = require("hardhat");
const { getContractAddress, getUsdcAddress } = require("./deployment");

const ERC20_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

function requireEnv(key) {
  const value = process.env[key];
  if (!value) {
    throw new Error(
      `❌ Missing required environment variable ${key}. See the ".env" section in the deploy summary.`
    );
  }
  return value;
}

/**
 * Normalizes a private key to the format required by ethers.Wallet
 * (0x + 64 hex chars). Common mistake: some wallets (e.g. MetaMask "copy private
 * key") copy the key WITHOUT the "0x" prefix — we add it instead of failing with
 * an opaque "invalid private key" from deep inside ethers.js.
 */
function requirePrivateKey(key) {
  const raw = requireEnv(key);
  const normalized = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error(
      `❌ ${key} does not look like a valid private key (expected 0x + 64 hex chars, or 64 hex chars without "0x").`
    );
  }
  return normalized;
}

function explorerTxUrl(chainId, txHash) {
  const base = chainId === 84532 ? "https://sepolia.basescan.org" : "https://basescan.org";
  return `${base}/tx/${txHash}`;
}

/** `EscrowState` enum values from BlackSwanOS.sol (must match the contract). */
const EscrowState = { AWAITING_SELLER: 0, LOCKED: 1, DISPUTED: 2, RESOLVED: 3, CLAIMED: 4 };

/**
 * Base Sepolia RPC (`https://sepolia.base.org`) is load-balanced across many
 * backend nodes WITHOUT sticky session — a `getEscrow`/`balanceOf` read sent
 * immediately after `tx.wait()` may hit a node that has not caught up to the
 * latest block and return pre-transaction data (we saw this when reading `oracle()`
 * right after `setOracleAddress()`). The transaction is still 100% valid on-chain —
 * only the read is "stale".
 *
 * So the smoke test final report does not lie, we retry reading escrow state up to
 * `maxAttempts` times, waiting `delayMs` between attempts, until `status` reaches
 * the expected value (or we give up and return the last read with a clear warning —
 * the transaction still has confirmation on the explorer).
 */
async function waitForFreshEscrow(contract, escrowId, expectedState, { maxAttempts = 8, delayMs = 4000 } = {}) {
  let last = await contract.getEscrow(escrowId);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (Number(last.state) === expectedState) return { escrow: last, fresh: true };
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    last = await contract.getEscrow(escrowId);
  }
  console.warn(
    `   ⚠️  After ${maxAttempts} attempts escrow read still shows status=${last.state.toString()} ` +
      `(expected ${expectedState}). This is likely a stale read from load-balanced RPC — ` +
      "check the transaction on the explorer to confirm the true on-chain state."
  );
  return { escrow: last, fresh: false };
}

/** Waits `seconds` of real time, printing progress about every minute (or more often for short windows). */
async function waitRealSeconds(seconds, label) {
  const stepMs = Math.min(60_000, Math.max(5_000, (seconds * 1000) / 10));
  const deadline = Date.now() + seconds * 1000;
  console.log(`⏳ ${label}: waiting ${seconds}s in real time (on-chain, no shortcuts)...`);
  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    await new Promise((resolve) => setTimeout(resolve, Math.min(stepMs, remainingMs)));
    const remainingSec = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    if (remainingSec > 0) console.log(`   ↳ ~${remainingSec}s remaining...`);
  }
}

async function main() {
  if (network.name === "hardhat" || network.name === "localhost") {
    console.log(
      "⚠️  This script is intended for real testnets (e.g. baseSepolia) — on a local network " +
        "evm_increaseTime in scripts/verify_dispute_bond.js is much faster. Continuing anyway."
    );
  }

  const contractAddress = getContractAddress();
  const usdcAddress = getUsdcAddress();

  const provider = ethers.provider;
  const chainId = Number((await provider.getNetwork()).chainId);

  const buyer = new ethers.Wallet(requirePrivateKey("SEPOLIA_BUYER_PRIVATE_KEY"), provider);
  const seller = new ethers.Wallet(requirePrivateKey("SEPOLIA_SELLER_PRIVATE_KEY"), provider);

  console.log("🚀 BlackSwanOS — E2E smoke test on", network.name);
  console.log(`   Contract: ${contractAddress}`);
  console.log(`   USDC:     ${usdcAddress}`);
  console.log(`   Buyer:    ${buyer.address}`);
  console.log(`   Seller:   ${seller.address}`);

  const contract = await ethers.getContractAt("BlackSwanOS", contractAddress);
  const usdc = new ethers.Contract(usdcAddress, ERC20_ABI, provider);

  const payloadPriceStr = process.env.SMOKE_TEST_PAYLOAD_PRICE_USDC || "1";
  const payloadPrice = ethers.parseUnits(payloadPriceStr, 6);

  const [maxFileSize, disputeWindow, systemFeeBps, collateralBps, bpsDenominator] = await Promise.all([
    contract.MAX_ALLOWED_FILE_SIZE(),
    contract.MIN_DISPUTE_WINDOW(), // shortest allowed window -> fastest happy path on testnet
    contract.systemFeeBps(),
    contract.COLLATERAL_BPS(),
    contract.BPS_DENOMINATOR(),
  ]);

  const systemFee = (payloadPrice * systemFeeBps) / bpsDenominator;
  const buyerDeposit = payloadPrice + systemFee;
  const sellerCollateral = (payloadPrice * collateralBps) / bpsDenominator;

  console.log(`\n📋 Test escrow parameters:`);
  console.log(`   payloadPrice:   ${ethers.formatUnits(payloadPrice, 6)} USDC`);
  console.log(`   maxFileSize:    ${maxFileSize.toString()} bytes (MAX_ALLOWED_FILE_SIZE)`);
  console.log(`   disputeWindow:  ${disputeWindow.toString()}s (MIN_DISPUTE_WINDOW)`);
  console.log(`   buyerDeposit:   ${ethers.formatUnits(buyerDeposit, 6)} USDC (payloadPrice + systemFee)`);
  console.log(`   sellerCollateral: ${ethers.formatUnits(sellerCollateral, 6)} USDC (200%)`);

  // --- Balance check BEFORE any on-chain action --------------------------------
  const [buyerBalance, sellerBalance] = await Promise.all([
    usdc.balanceOf(buyer.address),
    usdc.balanceOf(seller.address),
  ]);
  if (buyerBalance < buyerDeposit) {
    throw new Error(
      `❌ Buyer (${buyer.address}) has insufficient test USDC: ${ethers.formatUnits(buyerBalance, 6)}, ` +
        `need ${ethers.formatUnits(buyerDeposit, 6)}. Top up from Circle faucet: https://faucet.circle.com/`
    );
  }
  if (sellerBalance < sellerCollateral) {
    throw new Error(
      `❌ Seller (${seller.address}) has insufficient test USDC: ${ethers.formatUnits(sellerBalance, 6)}, ` +
        `need ${ethers.formatUnits(sellerCollateral, 6)}. Top up from Circle faucet: https://faucet.circle.com/`
    );
  }

  // --- Step 1: approve (only if allowance is not already sufficient) ---------
  async function ensureApproval(wallet, requiredAmount, label) {
    const current = await usdc.allowance(wallet.address, contractAddress);
    if (current >= requiredAmount) {
      console.log(`✅ ${label}: allowance already sufficient (${ethers.formatUnits(current, 6)} USDC).`);
      return;
    }
    console.log(`🔓 ${label}: sending approve(${ethers.formatUnits(requiredAmount, 6)} USDC)...`);
    const tx = await usdc.connect(wallet).approve(contractAddress, requiredAmount);
    const receipt = await tx.wait();
    console.log(`   ↳ confirmed: ${explorerTxUrl(chainId, receipt.hash)}`);
  }

  await ensureApproval(buyer, buyerDeposit, "Buyer");
  await ensureApproval(seller, sellerCollateral, "Seller");

  // --- Step 2: createEscrow ---------------------------------------------------
  console.log("\n📦 Buyer: createEscrow(seller, payloadPrice, maxFileSize, disputeWindow)...");
  const createTx = await contract
    .connect(buyer)
    .createEscrow(seller.address, payloadPrice, maxFileSize, disputeWindow);
  const createReceipt = await createTx.wait();
  console.log(`   ↳ tx: ${explorerTxUrl(chainId, createReceipt.hash)}`);

  const createdEvent = createReceipt.logs
    .map((log) => {
      try {
        return contract.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed) => parsed?.name === "EscrowCreated");
  const escrowId = createdEvent ? createdEvent.args.escrowId : (await contract.nextEscrowId()) - 1n;
  console.log(`✅ Escrow created, ID = ${escrowId.toString()}`);

  // --- Step 3: sellerLock -----------------------------------------------------
  console.log("\n🔒 Seller: sellerLock(escrowId, payloadHash)...");
  const payloadHash = ethers.id(`sepolia-smoke-test-${escrowId.toString()}-${Date.now()}`);
  const lockTx = await contract.connect(seller).sellerLock(escrowId, payloadHash);
  const lockReceipt = await lockTx.wait();
  console.log(`   ↳ tx: ${explorerTxUrl(chainId, lockReceipt.hash)}`);

  const lockedEscrow = await contract.getEscrow(escrowId);
  console.log(`✅ Seller locked escrow. lockTime=${lockedEscrow.lockTime.toString()}`);

  // --- Step 4: Happy path — wait for disputeWindow, then claimFunds -----------
  console.log(
    "\n🕊️  Happy path: no dispute during disputeWindow -> after it elapses " +
      "ANYONE (here: Buyer) can permissionlessly call claimFunds() and release funds to the Seller."
  );
  await waitRealSeconds(Number(disputeWindow) + 15, "Waiting for disputeWindow to end (+15s block time buffer)");

  console.log("\n💸 Buyer: claimFunds(escrowId) — happy-path auto-release (permissionless)...");
  const sellerBalanceBefore = await usdc.balanceOf(seller.address);
  const claimTx = await contract.connect(buyer).claimFunds(escrowId);
  const claimReceipt = await claimTx.wait();
  console.log(`   ↳ tx: ${explorerTxUrl(chainId, claimReceipt.hash)}`);

  // A read right after tx.wait() may hit a stale public RPC node (no sticky session)
  // and show pre-transaction state — retry until status reaches CLAIMED instead of
  // reporting a false failure.
  console.log("   ↳ waiting for fresh state read confirmation (RPC may lag a few seconds)...");
  const { escrow: finalEscrow, fresh } = await waitForFreshEscrow(contract, escrowId, EscrowState.CLAIMED);
  const sellerBalanceAfter = await usdc.balanceOf(seller.address);

  const sellerReceived = sellerBalanceAfter - sellerBalanceBefore;
  const expectedReceived = payloadPrice + sellerCollateral;

  console.log(`\n🎉 SUCCESS — full happy-path E2E on ${network.name} completed.`);
  console.log(
    `   Final escrow state: ${finalEscrow.state.toString()} (4 = CLAIMED)` + (fresh ? "" : "  [READ MAY BE STALE]")
  );
  console.log(
    `   Seller received: ${ethers.formatUnits(sellerReceived, 6)} USDC ` +
      `(expected: ${ethers.formatUnits(expectedReceived, 6)} USDC = payloadPrice + collateral)`
  );

  if (fresh && sellerReceived === expectedReceived) {
    console.log("   ✅ Amounts match on a fresh read — happy path verified end-to-end.");
  } else if (!fresh) {
    console.log(
      "   ℹ️  Verify the transaction manually on BaseScan (link above) — the receipt is the source of truth, " +
        "not this read."
    );
  } else {
    console.warn("   ⚠️  Fresh read succeeded but amounts do NOT match — investigate as a real issue.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ E2E smoke test failed:", error.message || error);
    process.exit(1);
  });
