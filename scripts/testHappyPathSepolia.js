/**
 * scripts/testHappyPathSepolia.js
 *
 * Fast Happy-Path SETUP on Base Sepolia (does NOT wait for disputeWindow):
 *   Buyer createEscrow → Seller sellerLock → stop + print claimFunds instructions.
 *
 * Why not wait? MIN_DISPUTE_WINDOW is 1 hour on a live chain — a sync script
 * cannot usefully block that long. After the window expires, call claimFunds
 * manually (see footer) or: npm run claim:funds
 *
 * Contrast with `npm run smoke:sepolia`, which DOES sleep the full window and
 * then claims automatically (~1h+ runtime).
 *
 * Env:
 *   SEPOLIA_BUYER_PRIVATE_KEY
 *   SEPOLIA_SELLER_PRIVATE_KEY
 *   CONTRACT_ADDRESS / USDC_ADDRESS (via deployment.json or .env)
 *   HAPPY_PRICE_USDC=0.1          (optional)
 *
 * Usage:
 *   npm run happy:sepolia
 */

const { createHash } = require("node:crypto");
const { ethers, network } = require("hardhat");
const { getContractAddress, getUsdcAddress } = require("./deployment");

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];

const EscrowState = {
  AWAITING_SELLER: 0,
  LOCKED: 1,
  DISPUTED: 2,
  RESOLVED: 3,
  CLAIMED: 4,
};

function requirePrivateKey(key) {
  const raw = process.env[key];
  if (!raw) throw new Error(`Missing env ${key}`);
  const normalized = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) throw new Error(`${key} invalid private key`);
  return normalized;
}

function explorerTxUrl(chainId, txHash) {
  const base = chainId === 84532 ? "https://sepolia.basescan.org" : "https://basescan.org";
  return `${base}/tx/${txHash}`;
}

async function ensureApproval(usdc, wallet, spender, amount, label, chainId) {
  const current = await usdc.allowance(wallet.address, spender);
  if (current >= amount) {
    console.log(`✅ ${label}: allowance OK (${ethers.formatUnits(current, 6)} USDC)`);
    return;
  }
  console.log(`🔓 ${label}: approve(${ethers.formatUnits(amount, 6)} USDC)...`);
  const tx = await usdc.connect(wallet).approve(spender, amount);
  const receipt = await tx.wait();
  console.log(`   ↳ ${explorerTxUrl(chainId, receipt.hash)}`);
}

function parseEvent(contract, receipt, name) {
  for (const log of receipt.logs) {
    try {
      const parsed = contract.interface.parseLog(log);
      if (parsed?.name === name) return parsed;
    } catch {
      // not this contract / topic
    }
  }
  return null;
}

async function waitForFreshEscrow(contract, escrowId, expectedState, { maxAttempts = 8, delayMs = 4000 } = {}) {
  let last = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      last = await contract.getEscrow(escrowId);
      if (Number(last.state) === expectedState) return last;
    } catch (err) {
      // Public Base Sepolia RPC can briefly throw/revert on stale nodes after a write.
      console.warn(
        `   ⚠️  getEscrow attempt ${attempt}/${maxAttempts}: ${err.shortMessage || err.message}`
      );
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return last;
}

async function main() {
  if (network.name !== "baseSepolia") {
    console.warn(`⚠️  Expected --network baseSepolia (got ${network.name}). Continuing anyway.`);
  }

  const contractAddress = getContractAddress();
  const usdcAddress = getUsdcAddress();
  const provider = ethers.provider;
  const chainId = Number((await provider.getNetwork()).chainId);

  const buyer = new ethers.Wallet(requirePrivateKey("SEPOLIA_BUYER_PRIVATE_KEY"), provider);
  const seller = new ethers.Wallet(requirePrivateKey("SEPOLIA_SELLER_PRIVATE_KEY"), provider);

  const contract = await ethers.getContractAt("BlackSwanOS", contractAddress);
  const usdc = new ethers.Contract(usdcAddress, ERC20_ABI, provider);

  // Small declared file size so 0.1 USDC clears the size-scaled price floor
  // (minBasePrice + pricePerKb * ceil(bytes/1024)).
  const maxFileSize = 1024; // 1 KB → floor ≈ 0.052 USDC with defaults
  const priceStr = process.env.HAPPY_PRICE_USDC || "0.1";
  let payloadPrice = ethers.parseUnits(priceStr, 6);

  const [disputeWindow, systemFeeBps, collateralBps, bpsDen, minRequired] = await Promise.all([
    contract.MIN_DISPUTE_WINDOW(),
    contract.systemFeeBps(),
    contract.COLLATERAL_BPS(),
    contract.BPS_DENOMINATOR(),
    contract.minRequiredPrice(maxFileSize),
  ]);

  if (payloadPrice < minRequired) {
    console.warn(
      `⚠️  ${priceStr} USDC < minRequiredPrice(${maxFileSize})=${ethers.formatUnits(minRequired, 6)} — bumping price`
    );
    payloadPrice = minRequired;
  }

  const systemFee = (payloadPrice * systemFeeBps) / bpsDen;
  const buyerDeposit = payloadPrice + systemFee;
  const sellerCollateral = (payloadPrice * collateralBps) / bpsDen;

  console.log("🕊️  BlackSwanOS — Happy Path SETUP (no wait) on", network.name);
  console.log(`   contract: ${contractAddress}`);
  console.log(`   buyer:    ${buyer.address}`);
  console.log(`   seller:   ${seller.address}`);
  console.log(`   price:    ${ethers.formatUnits(payloadPrice, 6)} USDC`);
  console.log(`   fee:      ${ethers.formatUnits(systemFee, 6)} USDC (${Number(systemFeeBps) / 100}%)`);
  console.log(`   deposit:  ${ethers.formatUnits(buyerDeposit, 6)} USDC`);
  console.log(`   collateral: ${ethers.formatUnits(sellerCollateral, 6)} USDC (200%)`);
  console.log(`   maxFileSize: ${maxFileSize} bytes`);
  console.log(`   disputeWindow: ${disputeWindow.toString()}s (${Number(disputeWindow) / 3600}h)`);

  const [buyerBal, sellerBal] = await Promise.all([
    usdc.balanceOf(buyer.address),
    usdc.balanceOf(seller.address),
  ]);
  if (buyerBal < buyerDeposit) {
    throw new Error(
      `Buyer USDC too low: ${ethers.formatUnits(buyerBal, 6)} < ${ethers.formatUnits(buyerDeposit, 6)}. Faucet: https://faucet.circle.com/`
    );
  }
  if (sellerBal < sellerCollateral) {
    throw new Error(
      `Seller USDC too low: ${ethers.formatUnits(sellerBal, 6)} < ${ethers.formatUnits(sellerCollateral, 6)}. Faucet: https://faucet.circle.com/`
    );
  }

  await ensureApproval(usdc, buyer, contractAddress, buyerDeposit, "Buyer", chainId);
  await ensureApproval(usdc, seller, contractAddress, sellerCollateral, "Seller", chainId);

  console.log("\n📦 Buyer: createEscrow(...)");
  const createTx = await contract
    .connect(buyer)
    .createEscrow(seller.address, payloadPrice, maxFileSize, disputeWindow);
  const createReceipt = await createTx.wait();
  console.log(`   ↳ ${explorerTxUrl(chainId, createReceipt.hash)}`);

  const createdEvent = createReceipt.logs
    .map((log) => {
      try {
        return contract.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((p) => p?.name === "EscrowCreated");
  const escrowId = createdEvent ? createdEvent.args.escrowId : (await contract.nextEscrowId()) - 1n;
  console.log(`✅ escrowId = ${escrowId.toString()}`);

  // Mock payload + SHA-256 (same algo as dispute path / Oracle). Happy path
  // never checks the bytes on-chain — hash is only a commitment.
  const mockPayload = Buffer.from(
    JSON.stringify({ happy: true, escrowId: escrowId.toString(), ts: Date.now() }),
    "utf8"
  );
  const payloadHash = "0x" + createHash("sha256").update(mockPayload).digest("hex");

  console.log("\n🔒 Seller: sellerLock(escrowId, sha256(mockPayload))");
  console.log(`   hash: ${payloadHash}`);
  const lockTx = await contract.connect(seller).sellerLock(escrowId, payloadHash);
  const lockReceipt = await lockTx.wait();
  console.log(`   ↳ ${explorerTxUrl(chainId, lockReceipt.hash)}`);

  if (lockReceipt.status !== 1) {
    throw new Error(`sellerLock tx mined but status=${lockReceipt.status} (reverted)`);
  }

  // Prefer lockTime from the SellerLocked event — receipt is source of truth.
  // A follow-up getEscrow on public RPC can flake (stale node → false "reverted").
  const lockedEv = parseEvent(contract, lockReceipt, "SellerLocked");
  let lockTime = lockedEv ? Number(lockedEv.args.lockTime) : 0;
  let stateNum = EscrowState.LOCKED;

  const escrow = await waitForFreshEscrow(contract, escrowId, EscrowState.LOCKED);
  if (escrow) {
    if (!lockTime) lockTime = Number(escrow.lockTime);
    stateNum = Number(escrow.state);
  } else if (!lockTime) {
    // Last resort: block timestamp of the lock tx
    const block = await provider.getBlock(lockReceipt.blockNumber);
    lockTime = Number(block.timestamp);
    console.warn("   ⚠️  Using block timestamp as lockTime (event/getEscrow unavailable)");
  }

  const claimableAt = lockTime + Number(disputeWindow);
  const claimableAtIso = new Date(claimableAt * 1000).toISOString();

  console.log(`\n✅ LOCKED on-chain (sellerLock receipt OK).`);
  console.log(`   escrowId=${escrowId.toString()} state≈${stateNum} (1=LOCKED)`);
  console.log(`   lockTime=${lockTime} → claimFunds open at ~${claimableAtIso} (unix ${claimableAt})`);

  console.log(`
────────────────────────────────────────────────────────────────────────
STOP — script does NOT wait ${Number(disputeWindow) / 3600}h for disputeWindow.

escrowId: ${escrowId.toString()}
claimable after: ${claimableAtIso}

When the window expires, claim (permissionless — buyer, seller, or any wallet):

  $env:CLAIM_ESCROW_ID="${escrowId.toString()}"
  npm run claim:funds

Basescan: https://sepolia.basescan.org/address/${contractAddress}#readContract
  → getEscrow(${escrowId.toString()})  (state 1=LOCKED → 4=CLAIMED after claim)
────────────────────────────────────────────────────────────────────────
`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\n❌ Happy path setup failed:", err.shortMessage || err.message || err);
    if (err.data) console.error("   data:", err.data);
    if (err.reason) console.error("   reason:", err.reason);
    process.exitCode = 1;
  });
