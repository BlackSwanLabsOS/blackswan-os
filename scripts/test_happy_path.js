/**
 * scripts/test_happy_path.js
 *
 * Full Happy Path on Base Sepolia (NO dispute):
 *   1) Buyer  createEscrow
 *   2) Seller sellerLock  (SHA-256 commitment only — bytes never leave this script)
 *   3) Wait until lockTime + disputeWindow  (MIN = 1h on-chain — cannot be shorter)
 *   4) Anyone claimFunds  ← this is the happy-path release (NOT "buyer approve")
 *
 * Gemini note: there is no buyerRelease / buyerApprove on BlackSwanOS.
 * After the dispute window with no raiseDispute, `claimFunds` pays seller + fee.
 *
 * Env:
 *   SEPOLIA_BUYER_PRIVATE_KEY / SEPOLIA_SELLER_PRIVATE_KEY
 *   HAPPY_PRICE_USDC=0.5          (optional)
 *   HAPPY_WAIT=1                  (default 1 = sleep until claimable; 0 = setup only)
 *   HAPPY_ESCROW_ID=N             (optional: skip create/lock, only wait+claim / claim)
 *   HAPPY_POLL_MS=30000           (how often to re-check chain time while waiting)
 *
 * Usage:
 *   npm run happy:full              # full path including ~1h wait
 *   HAPPY_WAIT=0 npm run happy:full # create+lock only, then claim later
 *   HAPPY_ESCROW_ID=8 npm run happy:full  # finish an existing LOCKED escrow
 */

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { ethers, network } = require("hardhat");
const { getContractAddress, getUsdcAddress } = require("./deployment");

const DRILL_FILE = path.join(__dirname, "..", "happy_path_drill.json");

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

const STATE_NAMES = [
  "AWAITING_SELLER",
  "LOCKED",
  "DISPUTED",
  "RESOLVED",
  "CLAIMED",
];

function requirePrivateKey(key) {
  const raw = process.env[key];
  if (!raw) throw new Error(`Missing env ${key}`);
  const normalized = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) throw new Error(`${key} invalid`);
  return normalized;
}

function explorerTxUrl(chainId, txHash) {
  const base =
    chainId === 84532 ? "https://sepolia.basescan.org" : "https://basescan.org";
  return `${base}/tx/${txHash}`;
}

function explorerAddressUrl(chainId, addr) {
  const base =
    chainId === 84532 ? "https://sepolia.basescan.org" : "https://basescan.org";
  return `${base}/address/${addr}`;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds)));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}h ${m}m ${sec}s`;
}

function parseEvent(contract, receipt, name) {
  for (const log of receipt.logs) {
    try {
      const parsed = contract.interface.parseLog(log);
      if (parsed?.name === name) return parsed;
    } catch {
      // ignore
    }
  }
  return null;
}

async function ensureAllowance(usdc, wallet, spender, amount, label, chainId) {
  const current = await usdc.allowance(wallet.address, spender);
  if (current >= amount) {
    console.log(`   ✅ ${label} allowance OK`);
    return;
  }
  if (current > 0n) {
    const z = await usdc.connect(wallet).approve(spender, 0n);
    await z.wait();
  }
  console.log(`   🔓 ${label} approve MaxUint256…`);
  const tx = await usdc.connect(wallet).approve(spender, ethers.MaxUint256);
  const rcpt = await tx.wait();
  console.log(`      ${explorerTxUrl(chainId, rcpt.hash)}`);
}

async function waitForState(contract, escrowId, expected, { attempts = 10, delayMs = 3000 } = {}) {
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const e = await contract.getEscrow(escrowId);
      if (Number(e.state) === expected) return e;
    } catch (err) {
      console.warn(`   ⚠️  getEscrow attempt ${i}/${attempts}: ${err.shortMessage || err.message}`);
    }
    await sleep(delayMs);
  }
  return contract.getEscrow(escrowId);
}

function writeDrill(info) {
  fs.writeFileSync(DRILL_FILE, JSON.stringify(info, null, 2) + "\n");
}

async function main() {
  if (network.name !== "baseSepolia" && network.name !== "base-sepolia") {
    console.warn(`⚠️  Expected baseSepolia (got ${network.name}). Continuing.`);
  }

  const shouldWait = String(process.env.HAPPY_WAIT ?? "1") !== "0";
  const pollMs = Number(process.env.HAPPY_POLL_MS || 30_000);
  const contractAddress = getContractAddress();
  const usdcAddress = getUsdcAddress();
  const provider = ethers.provider;
  const chainId = Number((await provider.getNetwork()).chainId);

  const buyer = new ethers.Wallet(requirePrivateKey("SEPOLIA_BUYER_PRIVATE_KEY"), provider);
  const seller = new ethers.Wallet(requirePrivateKey("SEPOLIA_SELLER_PRIVATE_KEY"), provider);
  const contract = await ethers.getContractAt("BlackSwanOS", contractAddress);
  const usdc = new ethers.Contract(usdcAddress, ERC20_ABI, provider);

  console.log("\n══════════════════════════════════════════════════");
  console.log("  BlackSwanOS — Happy Path (Base Sepolia)");
  console.log("══════════════════════════════════════════════════");
  console.log(`  Network:  ${network.name} (${chainId})`);
  console.log(`  Contract: ${explorerAddressUrl(chainId, contractAddress)}`);
  console.log(`  Buyer:    ${buyer.address}`);
  console.log(`  Seller:   ${seller.address}`);
  console.log(`  Wait:     ${shouldWait ? "YES (~1h dispute window)" : "NO (setup only)"}`);
  console.log("  Release:  claimFunds (permissionless) — NOT raise_dispute");
  console.log("══════════════════════════════════════════════════\n");

  let escrowId = process.env.HAPPY_ESCROW_ID
    ? BigInt(process.env.HAPPY_ESCROW_ID)
    : null;
  let disputeWindow;
  let lockTime;

  // ─── CREATE + LOCK (unless resuming) ───────────────────────────────
  if (escrowId === null) {
    const maxFileSize = 2048n;
    const priceStr = process.env.HAPPY_PRICE_USDC || "0.5";
    let payloadPrice = ethers.parseUnits(priceStr, 6);

    const [minWindow, systemFeeBps, collateralBps, bpsDen, minRequired] =
      await Promise.all([
        contract.MIN_DISPUTE_WINDOW(),
        contract.systemFeeBps(),
        contract.COLLATERAL_BPS(),
        contract.BPS_DENOMINATOR(),
        contract.minRequiredPrice(maxFileSize),
      ]);
    disputeWindow = minWindow;

    if (payloadPrice < minRequired) {
      console.warn(
        `⚠️  price ${priceStr} < minRequired ${ethers.formatUnits(minRequired, 6)} — bumping`
      );
      payloadPrice = minRequired;
    }

    const systemFee = (payloadPrice * systemFeeBps) / bpsDen;
    const buyerDeposit = payloadPrice + systemFee;
    const sellerCollateral = (payloadPrice * collateralBps) / bpsDen;

    console.log(`💵 Price ${ethers.formatUnits(payloadPrice, 6)} USDC + fee ${ethers.formatUnits(systemFee, 6)}`);
    console.log(`🔒 Seller collateral ${ethers.formatUnits(sellerCollateral, 6)} USDC`);
    console.log(`⏱  disputeWindow ${disputeWindow}s (${Number(disputeWindow) / 3600}h)\n`);

    const [buyerBal, sellerBal] = await Promise.all([
      usdc.balanceOf(buyer.address),
      usdc.balanceOf(seller.address),
    ]);
    if (buyerBal < buyerDeposit) {
      throw new Error(
        `Buyer USDC low: ${ethers.formatUnits(buyerBal, 6)} < ${ethers.formatUnits(buyerDeposit, 6)}`
      );
    }
    if (sellerBal < sellerCollateral) {
      throw new Error(
        `Seller USDC low: ${ethers.formatUnits(sellerBal, 6)} < ${ethers.formatUnits(sellerCollateral, 6)}`
      );
    }

    await ensureAllowance(usdc, buyer, contractAddress, buyerDeposit, "Buyer", chainId);
    await ensureAllowance(
      usdc,
      seller,
      contractAddress,
      sellerCollateral,
      "Seller",
      chainId
    );

    // 1) createEscrow
    console.log("① Buyer → createEscrow");
    const createTx = await contract
      .connect(buyer)
      .createEscrow(seller.address, payloadPrice, maxFileSize, disputeWindow);
    const createRcpt = await createTx.wait();
    console.log(`   ✅ confirmed  ${explorerTxUrl(chainId, createRcpt.hash)}`);

    const created = parseEvent(contract, createRcpt, "EscrowCreated");
    escrowId = created
      ? created.args.escrowId
      : (await contract.nextEscrowId()) - 1n;
    console.log(`   escrowId = ${escrowId}`);

    // 2) sellerLock
    const payload = JSON.stringify({
      schema: "blackswanos.m2m.v1",
      dataset: "happy_path",
      escrowId: escrowId.toString(),
      records: [
        {
          device_id: "CNC-01",
          ts: new Date().toISOString(),
          metric: "spindle_temp_c",
          value: 41.8,
        },
      ],
    });
    const payloadHash =
      "0x" + createHash("sha256").update(payload, "utf8").digest("hex");

    console.log("\n② Seller → sellerLock (SHA-256 commitment)");
    console.log(`   payloadHash ${payloadHash}`);
    const lockTx = await contract.connect(seller).sellerLock(escrowId, payloadHash);
    const lockRcpt = await lockTx.wait();
    console.log(`   ✅ confirmed  ${explorerTxUrl(chainId, lockRcpt.hash)}`);

    const lockedEv = parseEvent(contract, lockRcpt, "SellerLocked");
    lockTime = lockedEv ? Number(lockedEv.args.lockTime) : 0;

    const escrow = await waitForState(contract, escrowId, EscrowState.LOCKED);
    if (!lockTime) lockTime = Number(escrow.lockTime);
    disputeWindow = BigInt(escrow.disputeWindow);
    console.log(`   state = ${STATE_NAMES[Number(escrow.state)]}`);

    writeDrill({
      network: network.name,
      chainId,
      contract: contractAddress,
      escrowId: escrowId.toString(),
      createTx: createRcpt.hash,
      lockTx: lockRcpt.hash,
      lockTime,
      disputeWindow: disputeWindow.toString(),
      claimableAtUnix: lockTime + Number(disputeWindow),
      claimableAtIso: new Date((lockTime + Number(disputeWindow)) * 1000).toISOString(),
      payloadHash,
      createdAtIso: new Date().toISOString(),
    });
    console.log(`   💾 saved happy_path_drill.json`);
  } else {
    console.log(`↩  Resuming escrow #${escrowId}`);
    const escrow = await contract.getEscrow(escrowId);
    console.log(`   state = ${STATE_NAMES[Number(escrow.state)]}`);
    if (Number(escrow.state) === EscrowState.CLAIMED) {
      console.log("   Already CLAIMED — nothing to do.");
      return;
    }
    if (Number(escrow.state) !== EscrowState.LOCKED) {
      throw new Error(
        `Escrow #${escrowId} must be LOCKED for happy path (got ${STATE_NAMES[Number(escrow.state)]})`
      );
    }
    lockTime = Number(escrow.lockTime);
    disputeWindow = BigInt(escrow.disputeWindow);
  }

  const claimableAt = lockTime + Number(disputeWindow);
  console.log(
    `\n📅 claimFunds opens at ${new Date(claimableAt * 1000).toISOString()} (UTC)`
  );

  // ─── WAIT ──────────────────────────────────────────────────────────
  if (shouldWait) {
    console.log("\n③ Waiting for dispute window (no raise_dispute)…");
    for (;;) {
      const block = await provider.getBlock("latest");
      const now = Number(block.timestamp);
      const remaining = claimableAt - now;
      if (remaining <= 0) {
        console.log("   ✅ Window elapsed.");
        break;
      }
      console.log(
        `   ⏳ ${formatDuration(remaining)} left  (chain time ${new Date(now * 1000).toISOString()})`
      );
      await sleep(Math.min(pollMs, Math.max(5_000, remaining * 1000)));
    }
  } else {
    console.log("\n③ HAPPY_WAIT=0 — skipping wait.");
    console.log("   Later:");
    console.log(`     $env:HAPPY_ESCROW_ID="${escrowId}"`);
    console.log("     npm run happy:full");
    console.log("   or:");
    console.log(`     $env:CLAIM_ESCROW_ID="${escrowId}"; npm run claim:funds`);
    return;
  }

  // ─── CLAIM ─────────────────────────────────────────────────────────
  console.log("\n④ claimFunds (permissionless happy-path release)");
  const before = await waitForState(contract, escrowId, EscrowState.LOCKED, {
    attempts: 5,
    delayMs: 2000,
  });
  if (Number(before.state) !== EscrowState.LOCKED) {
    throw new Error(
      `Expected LOCKED before claim, got ${STATE_NAMES[Number(before.state)]}`
    );
  }

  const sellerBefore = await usdc.balanceOf(seller.address);
  // Buyer signs claim (anyone could — we use buyer for gas simplicity)
  const claimTx = await contract.connect(buyer).claimFunds(escrowId);
  const claimRcpt = await claimTx.wait();
  console.log(`   ✅ confirmed  ${explorerTxUrl(chainId, claimRcpt.hash)}`);

  const after = await waitForState(contract, escrowId, EscrowState.CLAIMED);
  const sellerAfter = await usdc.balanceOf(seller.address);
  const sellerGain = sellerAfter - sellerBefore;

  console.log(`\n🏁 Final state: ${STATE_NAMES[Number(after.state)]}`);
  console.log(
    `   Seller USDC Δ ≈ ${ethers.formatUnits(sellerGain, 6)} (price + returned collateral)`
  );

  if (fs.existsSync(DRILL_FILE)) {
    try {
      const prev = JSON.parse(fs.readFileSync(DRILL_FILE, "utf8"));
      writeDrill({
        ...prev,
        claimTx: claimRcpt.hash,
        claimedAtIso: new Date().toISOString(),
        finalState: STATE_NAMES[Number(after.state)],
      });
    } catch {
      // ignore
    }
  }

  console.log("\n══════════════════════════════════════════════════");
  console.log("  Happy path COMPLETE — no dispute, funds released.");
  console.log("══════════════════════════════════════════════════\n");
}

main().catch((err) => {
  console.error("\n❌ happy path failed:", err.shortMessage || err.message || err);
  if (err.reason) console.error("   reason:", err.reason);
  process.exitCode = 1;
});
