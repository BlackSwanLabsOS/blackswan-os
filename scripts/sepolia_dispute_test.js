/**
 * scripts/sepolia_dispute_test.js
 *
 * E2E test of the DISPUTE path (as opposed to sepolia_smoke_test.js, which
 * only exercises the happy path) against the REALLY deployed BlackSwanOS
 * contract on Base Sepolia — no local shortcuts, no time-skipping.
 *
 * Unlike the happy path, raising a dispute does NOT require waiting for
 * `disputeWindow` to elapse — it can (and, to prove the point, in this
 * script DOES) happen the instant after `sellerLock`. This script stops
 * right there and hands control back to you, so you can manually drive the
 * Oracle side and watch it read the on-chain DISPUTED state for yourself.
 *
 * Flow:
 *   1. Buyer and Seller approve test USDC — as in the smoke test, PLUS Buyer
 *      approves the dispute bond.
 *   2. Buyer calls createEscrow(...) with the new pricing / 100 KB limit logic.
 *   3. Seller calls sellerLock(escrowId, payloadHash) — `payloadHash` is the
 *      SHA-256 of REAL, valid JSON payload (also written to disk), not a random
 *      placeholder — so the Oracle has something meaningful to validate (Steps 1-4 + LLM),
 *      not just read status.
 *   4. Buyer immediately calls raiseDispute(escrowId) — no waiting.
 *   5. Script STOPS and prints exact instructions: how to start the Python Oracle
 *      and send it the same payload for validation.
 *
 * Required environment variables: same as sepolia_smoke_test.js
 *   (CONTRACT_ADDRESS/USDC_ADDRESS from deployment.json, SEPOLIA_BUYER_PRIVATE_KEY,
 *   SEPOLIA_SELLER_PRIVATE_KEY).
 *
 * Usage:
 *   npx hardhat run scripts/sepolia_dispute_test.js --network baseSepolia
 *   (or: npm run dispute:sepolia)
 */

const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
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

/** Same as sepolia_smoke_test.js — normalize "0x" prefix. */
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

function explorerAddressUrl(chainId, address) {
  const base = chainId === 84532 ? "https://sepolia.basescan.org" : "https://basescan.org";
  return `${base}/address/${address}#readContract`;
}

/** `EscrowState` enum values from BlackSwanOS.sol (must match the contract). */
const EscrowState = { AWAITING_SELLER: 0, LOCKED: 1, DISPUTED: 2, RESOLVED: 3, CLAIMED: 4 };

/**
 * Same as sepolia_smoke_test.js: a read right after tx.wait() may hit a stale
 * Base Sepolia public RPC node (load-balanced, no sticky session) and return
 * pre-transaction state. Retry until state reaches the expected value instead of
 * reporting a false failure on a valid transaction.
 */
async function waitForFreshEscrow(contract, escrowId, expectedState, { maxAttempts = 8, delayMs = 4000 } = {}) {
  let last = await contract.getEscrow(escrowId);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (Number(last.state) === expectedState) return { escrow: last, fresh: true };
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    last = await contract.getEscrow(escrowId);
  }
  return { escrow: last, fresh: false };
}

async function ensureApproval(usdc, wallet, contractAddress, requiredAmount, label, chainId) {
  // Same "stale RPC node without sticky session" issue as `waitForFreshEscrow`
  // above: reading `allowance` immediately after a PRIOR transaction that
  // consumed it (e.g. `createEscrow`'s transferFrom) can hit a load-balanced
  // public RPC replica that hasn't caught up yet, returning the OLD
  // (pre-consumption) allowance. That made this function wrongly conclude
  // "already sufficient" and skip re-approving, causing the NEXT on-chain
  // call (e.g. raiseDispute) to revert with "transfer amount exceeds
  // allowance". Small fixed delay is enough here (unlike escrow state,
  // there's no natural "expected value" to poll against).
  await new Promise((resolve) => setTimeout(resolve, 3000));
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

async function main() {
  const contractAddress = getContractAddress();
  const usdcAddress = getUsdcAddress();

  const provider = ethers.provider;
  const chainId = Number((await provider.getNetwork()).chainId);

  const buyer = new ethers.Wallet(requirePrivateKey("SEPOLIA_BUYER_PRIVATE_KEY"), provider);
  const seller = new ethers.Wallet(requirePrivateKey("SEPOLIA_SELLER_PRIVATE_KEY"), provider);

  console.log("⚔️  BlackSwanOS — dispute path test on", network.name);
  console.log(`   Contract: ${contractAddress}`);
  console.log(`   USDC:     ${usdcAddress}`);
  console.log(`   Buyer:    ${buyer.address}`);
  console.log(`   Seller:   ${seller.address}`);

  const contract = await ethers.getContractAt("BlackSwanOS", contractAddress);
  const usdc = new ethers.Contract(usdcAddress, ERC20_ABI, provider);

  const payloadPriceStr = process.env.SMOKE_TEST_PAYLOAD_PRICE_USDC || "1";
  const payloadPrice = ethers.parseUnits(payloadPriceStr, 6);

  const [
    maxFileSize,
    disputeWindow,
    systemFeeBps,
    collateralBps,
    bpsDenominator,
    disputeBondBps,
    minDisputeBond,
  ] = await Promise.all([
    contract.MAX_ALLOWED_FILE_SIZE(), // full ceiling -> also exercises new pricing logic in createEscrow
    contract.MIN_DISPUTE_WINDOW(),
    contract.systemFeeBps(),
    contract.COLLATERAL_BPS(),
    contract.BPS_DENOMINATOR(),
    contract.disputeBondBps(),
    contract.minDisputeBond(),
  ]);

  const minRequiredPrice = await contract.minRequiredPrice(maxFileSize);
  if (payloadPrice < minRequiredPrice) {
    throw new Error(
      `❌ SMOKE_TEST_PAYLOAD_PRICE_USDC (${payloadPriceStr} USDC) is below the minimum price for ` +
        `maxFileSize=${maxFileSize}: required ${ethers.formatUnits(minRequiredPrice, 6)} USDC.`
    );
  }

  const systemFee = (payloadPrice * systemFeeBps) / bpsDenominator;
  const buyerDeposit = payloadPrice + systemFee;
  const sellerCollateral = (payloadPrice * collateralBps) / bpsDenominator;
  const percentageBond = (payloadPrice * disputeBondBps) / bpsDenominator;
  const disputeBond = percentageBond > minDisputeBond ? percentageBond : minDisputeBond;

  console.log(`\n📋 Test escrow parameters:`);
  console.log(`   payloadPrice:      ${ethers.formatUnits(payloadPrice, 6)} USDC`);
  console.log(`   maxFileSize:       ${maxFileSize.toString()} bytes (MAX_ALLOWED_FILE_SIZE)`);
  console.log(`   disputeWindow:     ${disputeWindow.toString()}s (MIN_DISPUTE_WINDOW) — not waited on in this test`);
  console.log(`   systemFee:         ${ethers.formatUnits(systemFee, 6)} USDC (${Number(systemFeeBps) / 100}% of payloadPrice)`);
  console.log(`   buyerDeposit:      ${ethers.formatUnits(buyerDeposit, 6)} USDC (payloadPrice + systemFee)`);
  console.log(`   sellerCollateral:  ${ethers.formatUnits(sellerCollateral, 6)} USDC (200%)`);
  console.log(`   disputeBond:       ${ethers.formatUnits(disputeBond, 6)} USDC (hybrid: max(5%, min 0.20 USDC))`);

  // --- Balance check BEFORE any on-chain action --------------------------------
  const [buyerBalance, sellerBalance] = await Promise.all([
    usdc.balanceOf(buyer.address),
    usdc.balanceOf(seller.address),
  ]);
  const buyerTotalNeeded = buyerDeposit + disputeBond; // Buyer pays deposit AND (in this test) dispute bond
  if (buyerBalance < buyerTotalNeeded) {
    throw new Error(
      `❌ Buyer (${buyer.address}) has insufficient test USDC: ${ethers.formatUnits(buyerBalance, 6)}, ` +
        `need ${ethers.formatUnits(buyerTotalNeeded, 6)} (deposit + dispute bond). ` +
        `Top up from Circle faucet: https://faucet.circle.com/`
    );
  }
  if (sellerBalance < sellerCollateral) {
    throw new Error(
      `❌ Seller (${seller.address}) has insufficient test USDC: ${ethers.formatUnits(sellerBalance, 6)}, ` +
        `need ${ethers.formatUnits(sellerCollateral, 6)}. Top up from Circle faucet: https://faucet.circle.com/`
    );
  }

  // --- Step 1: approve --------------------------------------------------------
  await ensureApproval(usdc, buyer, contractAddress, buyerDeposit, "Buyer (deposit)", chainId);
  await ensureApproval(usdc, seller, contractAddress, sellerCollateral, "Seller (collateral)", chainId);

  // --- Step 2: createEscrow ---------------------------------------------------
  console.log("\n📦 Buyer: createEscrow(seller, payloadPrice, maxFileSize, disputeWindow)...");
  const createTx = await contract
    .connect(buyer)
    .createEscrow(seller.address, payloadPrice, maxFileSize, disputeWindow);
  const createReceipt = await createTx.wait();
  console.log(`   ↳ tx: ${explorerTxUrl(chainId, createReceipt.hash)}`);

  // Read escrowId from THIS transaction's event (certain, same receipt) — NOT a
  // separate nextEscrowId() query right after tx.wait(), which may hit a stale RPC
  // node (load-balanced sepolia.base.org without sticky session) and return an
  // escrowId already used by a prior test, causing sellerLock/raiseDispute to revert
  // below. Fallback to nextEscrowId() only if event parsing fails (should not, but
  // we avoid hard failure without trying).
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

  // --- Step 3: sellerLock with REAL payload -----------------------------------
  // Real, valid JSON — not ethers.id(random string) as in the smoke test — so the
  // Oracle has something meaningful to validate (Steps 1-4 + LLM), not just read
  // DISPUTED status.
  const payloadObject = {
    dataset: "sepolia-dispute-test",
    escrowId: escrowId.toString(),
    generatedAt: new Date().toISOString(),
    records: [
      { id: 1, label: "example-record-one", value: 42 },
      { id: 2, label: "example-record-two", value: 7 },
    ],
  };
  // JSON.stringify without indent — bytes we hash and send must match file contents
  // and what the Oracle hashes.
  const payloadText = JSON.stringify(payloadObject);
  const payloadHash = `0x${createHash("sha256").update(payloadText, "utf-8").digest("hex")}`;

  const payloadFilePath = path.join(__dirname, "..", `dispute_test_payload_${escrowId}.json`);
  fs.writeFileSync(payloadFilePath, payloadText); // no trailing "\n" — otherwise hash diverges

  console.log("\n🔒 Seller: sellerLock(escrowId, payloadHash)...");
  console.log(`   payloadHash (SHA-256): ${payloadHash}`);
  console.log(`   payload saved to:      ${payloadFilePath}`);
  const lockTx = await contract.connect(seller).sellerLock(escrowId, payloadHash);
  const lockReceipt = await lockTx.wait();
  console.log(`   ↳ tx: ${explorerTxUrl(chainId, lockReceipt.hash)}`);

  // --- Step 4: Buyer raises dispute immediately — no waiting ------------------
  await ensureApproval(usdc, buyer, contractAddress, disputeBond, "Buyer (dispute bond)", chainId);

  console.log("\n⚔️  Buyer: raiseDispute(escrowId) — immediately, without waiting for disputeWindow...");
  const disputeTx = await contract.connect(buyer).raiseDispute(escrowId);
  const disputeReceipt = await disputeTx.wait();
  console.log(`   ↳ tx: ${explorerTxUrl(chainId, disputeReceipt.hash)}`);

  console.log("   ↳ waiting for fresh state read confirmation (RPC may lag a few seconds)...");
  const { escrow: finalEscrow, fresh } = await waitForFreshEscrow(contract, escrowId, EscrowState.DISPUTED);
  console.log(
    `\n✅ Escrow ${escrowId} is now in state: ${finalEscrow.state.toString()} (2 = DISPUTED)` +
      (fresh ? "" : "  [READ MAY BE STALE — check Basescan]")
  );

  // --- STOP. Manual steps follow. ---------------------------------------------
  console.log("\n" + "=".repeat(78));
  console.log("🛑 SCRIPT PAUSED — dispute is on-chain; continue manually.");
  console.log("=".repeat(78));
  console.log(`
Escrow ID:        ${escrowId}
On-chain state:   DISPUTED (verify: ${explorerAddressUrl(chainId, contractAddress)})
Payload (to send to the Oracle), also saved to file:
  ${payloadFilePath}

---- STEP A: start the Python Oracle (PowerShell, Windows) --------------------
  cd oracle
  .\\venv\\Scripts\\python.exe -m uvicorn main:app --reload --port 8000

  (venv already has fastapi/uvicorn/web3 — nothing extra to install.
   Requires a filled oracle/.env: RPC_URL, CONTRACT_ADDRESS, ORACLE_PRIVATE_KEY
   — already set — AND OPENAI_API_KEY or ANTHROPIC_API_KEY for Step 5 (LLM).
   NO LLM key in oracle/.env right now? Without it: Steps 1-4 still pass, Step 5
   returns a clear error, and escrow safely REMAINS DISPUTED — expected zero-trust
   behavior, not a bug; add a key before this step if you want the full LLM verdict.)

---- STEP B: confirm the Oracle sees the dispute (before sending payload) ------
  Invoke-RestMethod -Uri "http://localhost:8000/disputes/${escrowId}/status" -Method Get

  Expected: "on_chain_state": "DISPUTED" — proof the Oracle READS state directly
  from chain (not from cache/events), regardless of whether the event listener
  caught the event (it may not if Oracle started AFTER this script — irrelevant;
  Oracle re-fetches escrow on-chain on every request).

---- STEP C: send payload for validation + resolution -------------------------
  (requires header X-Oracle-Secret = ORACLE_HTTP_SECRET from oracle/.env)

  curl.exe -X POST "http://localhost:8000/disputes/${escrowId}/payload" ^
    -H "X-Oracle-Secret: YOUR_SECRET_FROM_ENV" ^
    --data-binary "@${payloadFilePath}"

  (PowerShell — substitute $secret from oracle/.env):
  $h = @{ "X-Oracle-Secret" = $secret; "Content-Type" = "application/json" }
  Invoke-RestMethod -Uri "http://localhost:8000/disputes/${escrowId}/payload" -Method Post -InFile "${payloadFilePath}" -Headers $h

  This call: (1) verifies hash/size/syntax, (2) if all good, sends payload to LLM
  for verdict, (3) calls resolveDispute() on-chain from the Oracle wallet. JSON
  response includes verdict and tx_hash.

---- STEP D: after resolution — claim funds -----------------------------------
  Escrow moves to RESOLVED. Anyone (buyer/seller/you) can now call
  claimResolved(${escrowId}) on the contract to transfer USDC per the verdict.
`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ Dispute path test failed:", error.message || error);
    process.exit(1);
  });
