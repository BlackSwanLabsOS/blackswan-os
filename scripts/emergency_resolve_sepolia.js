/**
 * scripts/emergency_resolve_sepolia.js
 *
 * Plan B drill on Base Sepolia: owner `emergencyResolve` after 24h DISPUTED.
 *
 * Modes (from npm script name, or EMERGENCY_ACTION override):
 *   setup   — createEscrow → sellerLock → raiseDispute (ON-CHAIN ONLY, no Oracle POST)
 *   status  — show countdown until EMERGENCY_TIMEOUT (24h)
 *   resolve — owner calls emergencyResolve(escrowId, outcome) + settle in one tx
 *
 * Env:
 *   PRIVATE_KEY                 — contract owner (deployer)
 *   SEPOLIA_BUYER_PRIVATE_KEY
 *   SEPOLIA_SELLER_PRIVATE_KEY
 *   EMERGENCY_ACTION=setup|status|resolve  (optional override)
 *   EMERGENCY_ESCROW_ID=N       — required for status/resolve (setup writes emergency_drill.json)
 *   EMERGENCY_OUTCOME=SELLER_VALID|SELLER_CHEATED|BUYER_CHEATED  (default SELLER_VALID)
 *   EMERGENCY_PRICE_USDC=0.5    — optional (setup)
 *
 * Usage:
 *   npm run emergency:setup
 *   npm run emergency:status
 *   npm run emergency:resolve
 *
 * IMPORTANT: Stop / do not POST payload to Oracle during this drill, or Oracle
 * will resolve before the 24h window and emergencyResolve will revert.
 */

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { ethers, network } = require("hardhat");
const { getContractAddress, getUsdcAddress } = require("./deployment");

const DRILL_FILE = path.join(__dirname, "..", "emergency_drill.json");

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

const DisputeOutcome = {
  NONE: 0,
  SELLER_CHEATED: 1,
  BUYER_CHEATED: 2,
  SELLER_VALID: 3,
};

const OUTCOME_NAMES = {
  0: "NONE",
  1: "SELLER_CHEATED",
  2: "BUYER_CHEATED",
  3: "SELLER_VALID",
};

function requirePrivateKey(key) {
  const raw = process.env[key];
  if (!raw) throw new Error(`Missing env ${key}`);
  const normalized = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error(`${key} invalid private key`);
  }
  return normalized;
}

function explorerTxUrl(chainId, txHash) {
  const base =
    chainId === 84532 ? "https://sepolia.basescan.org" : "https://basescan.org";
  return `${base}/tx/${txHash}`;
}

function parseOutcome(raw) {
  const key = (raw || "SELLER_VALID").trim().toUpperCase();
  if (!(key in DisputeOutcome) || key === "NONE") {
    throw new Error(
      `EMERGENCY_OUTCOME must be SELLER_VALID | SELLER_CHEATED | BUYER_CHEATED (got ${raw})`
    );
  }
  return DisputeOutcome[key];
}

async function ensureAllowance(usdc, wallet, spender, amount, label, chainId) {
  const current = await usdc.allowance(wallet.address, spender);
  if (current >= amount) {
    console.log(`✅ ${label}: allowance OK`);
    return;
  }
  if (current > 0n) {
    const z = await usdc.connect(wallet).approve(spender, 0n);
    await z.wait();
  }
  console.log(`🔓 ${label}: approve MaxUint256…`);
  const tx = await usdc.connect(wallet).approve(spender, ethers.MaxUint256);
  const receipt = await tx.wait();
  console.log(`   ↳ ${explorerTxUrl(chainId, receipt.hash)}`);
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

function writeDrill(info) {
  fs.writeFileSync(DRILL_FILE, JSON.stringify(info, null, 2) + "\n");
}

function readDrill() {
  if (!fs.existsSync(DRILL_FILE)) return null;
  try {
    return JSON.parse(fs.readFileSync(DRILL_FILE, "utf-8"));
  } catch {
    return null;
  }
}

function formatDuration(seconds) {
  const s = Math.max(0, Number(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}h ${m}m ${sec}s`;
}

async function actionSetup(contract, usdc, buyer, seller, chainId) {
  const maxFileSize = 2048n;
  const priceStr = process.env.EMERGENCY_PRICE_USDC || "0.5";
  let payloadPrice = ethers.parseUnits(priceStr, 6);

  const [
    minWindow,
    systemFeeBps,
    collateralBps,
    bpsDen,
    minRequired,
    disputeBondBps,
    minDisputeBond,
    emergencyTimeout,
  ] = await Promise.all([
    contract.MIN_DISPUTE_WINDOW(),
    contract.systemFeeBps(),
    contract.COLLATERAL_BPS(),
    contract.BPS_DENOMINATOR(),
    contract.minRequiredPrice(maxFileSize),
    contract.disputeBondBps(),
    contract.minDisputeBond(),
    contract.EMERGENCY_TIMEOUT(),
  ]);

  if (payloadPrice < minRequired) {
    console.warn(
      `⚠️  price ${priceStr} < minRequired ${ethers.formatUnits(minRequired, 6)} — bumping`
    );
    payloadPrice = minRequired;
  }

  const systemFee = (payloadPrice * systemFeeBps) / bpsDen;
  const buyerDeposit = payloadPrice + systemFee;
  const sellerCollateral = (payloadPrice * collateralBps) / bpsDen;
  let disputeBond = (payloadPrice * disputeBondBps) / bpsDen;
  if (disputeBond < minDisputeBond) disputeBond = minDisputeBond;

  const payload =
    process.env.EMERGENCY_PAYLOAD ||
    JSON.stringify({
      schema: "blackswanos.m2m.v1",
      dataset: "emergency_drill",
      note: "on-chain dispute only — do not POST to Oracle",
      ts: new Date().toISOString(),
    });
  const payloadHash =
    "0x" + createHash("sha256").update(payload, "utf8").digest("hex");

  console.log("\n═══ EMERGENCY DRILL — SETUP ═══");
  console.log(`Contract: ${await contract.getAddress()}`);
  console.log(`Buyer:    ${buyer.address}`);
  console.log(`Seller:   ${seller.address}`);
  console.log(`Price:    ${ethers.formatUnits(payloadPrice, 6)} USDC`);
  console.log(
    `⚠️  Do NOT submit this payload to Oracle — leave escrow DISPUTED for ${formatDuration(emergencyTimeout)}.`
  );

  await ensureAllowance(usdc, buyer, await contract.getAddress(), buyerDeposit, "Buyer", chainId);

  const createTx = await contract
    .connect(buyer)
    .createEscrow(seller.address, payloadPrice, maxFileSize, minWindow);
  const createRcpt = await createTx.wait();
  const created = parseEvent(contract, createRcpt, "EscrowCreated");
  const escrowId = created ? created.args.escrowId : (await contract.nextEscrowId()) - 1n;
  console.log(`\n1️⃣  createEscrow → escrow #${escrowId}`);
  console.log(`   ↳ ${explorerTxUrl(chainId, createRcpt.hash)}`);

  await ensureAllowance(
    usdc,
    seller,
    await contract.getAddress(),
    sellerCollateral,
    "Seller",
    chainId
  );
  const lockTx = await contract.connect(seller).sellerLock(escrowId, payloadHash);
  const lockRcpt = await lockTx.wait();
  console.log(`\n2️⃣  sellerLock`);
  console.log(`   ↳ ${explorerTxUrl(chainId, lockRcpt.hash)}`);

  await ensureAllowance(
    usdc,
    buyer,
    await contract.getAddress(),
    disputeBond,
    "Buyer bond",
    chainId
  );
  const dispTx = await contract.connect(buyer).raiseDispute(escrowId);
  const dispRcpt = await dispTx.wait();
  console.log(`\n3️⃣  raiseDispute (on-chain only)`);
  console.log(`   ↳ ${explorerTxUrl(chainId, dispRcpt.hash)}`);

  // Public Sepolia RPC can return stale getEscrow right after the write
  // (disputeRaisedAt=0). Poll until DISPUTED with a non-zero timestamp.
  let escrow = null;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    escrow = await contract.getEscrow(escrowId);
    if (
      Number(escrow.state) === EscrowState.DISPUTED &&
      Number(escrow.disputeRaisedAt) > 0
    ) {
      break;
    }
    console.warn(
      `   ⚠️  waiting for fresh DISPUTED state (attempt ${attempt}/10)…`
    );
    await new Promise((r) => setTimeout(r, 3000));
  }
  if (
    !escrow ||
    Number(escrow.state) !== EscrowState.DISPUTED ||
    Number(escrow.disputeRaisedAt) === 0
  ) {
    throw new Error(
      `Escrow #${escrowId} not visibly DISPUTED yet — re-run: EMERGENCY_ESCROW_ID=${escrowId} npm run emergency:status`
    );
  }

  const unlockAt = Number(escrow.disputeRaisedAt) + Number(emergencyTimeout);
  const drill = {
    network: network.name,
    chainId,
    contract: await contract.getAddress(),
    escrowId: escrowId.toString(),
    disputeRaisedAt: escrow.disputeRaisedAt.toString(),
    emergencyTimeoutSeconds: emergencyTimeout.toString(),
    unlockAtUnix: unlockAt,
    unlockAtIso: new Date(unlockAt * 1000).toISOString(),
    raiseDisputeTx: dispRcpt.hash,
    payloadHash,
    note: "Wait until unlockAt, then: npm run emergency:resolve",
    createdAtIso: new Date().toISOString(),
  };
  writeDrill(drill);

  console.log(`\n✅ Escrow #${escrowId} is DISPUTED.`);
  console.log(`   emergencyResolve unlocks at: ${drill.unlockAtIso} (UTC)`);
  console.log(`   Saved: emergency_drill.json`);
  console.log(`\nNext:`);
  console.log(`   npm run emergency:status`);
  console.log(
    `   # after unlock: EMERGENCY_OUTCOME=SELLER_VALID npm run emergency:resolve`
  );
  console.log(
    `\n⛔ Keep Oracle from resolving this id (no POST /disputes/${escrowId}/payload).`
  );
}

async function actionStatus(contract) {
  const drill = readDrill();
  const escrowId =
    process.env.EMERGENCY_ESCROW_ID || (drill && drill.escrowId);
  if (escrowId === undefined || escrowId === null || escrowId === "") {
    throw new Error(
      "Set EMERGENCY_ESCROW_ID or run npm run emergency:setup first (emergency_drill.json)"
    );
  }

  const [escrow, emergencyTimeout, latest] = await Promise.all([
    contract.getEscrow(escrowId),
    contract.EMERGENCY_TIMEOUT(),
    ethers.provider.getBlock("latest"),
  ]);

  const stateName = STATE_NAMES[Number(escrow.state)] ?? String(escrow.state);
  const unlockAt = Number(escrow.disputeRaisedAt) + Number(emergencyTimeout);
  const now = Number(latest.timestamp);
  const remaining = unlockAt - now;

  console.log("\n═══ EMERGENCY DRILL — STATUS ═══");
  console.log(`Escrow:     #${escrowId}`);
  console.log(`State:      ${stateName}`);
  console.log(`Outcome:    ${OUTCOME_NAMES[Number(escrow.outcome)]}`);
  console.log(`Fallback:   ${escrow.resolvedByFallbackArbiter}`);
  console.log(`Raised at:  ${new Date(Number(escrow.disputeRaisedAt) * 1000).toISOString()}`);
  console.log(`Unlock at:  ${new Date(unlockAt * 1000).toISOString()} (UTC)`);
  console.log(`Chain now:  ${new Date(now * 1000).toISOString()} (UTC)`);

  if (Number(escrow.state) !== EscrowState.DISPUTED) {
    console.log(
      `\n⚠️  Not DISPUTED — emergencyResolve will revert. (Oracle may have already resolved.)`
    );
    return;
  }

  if (remaining > 0) {
    console.log(`\n⏳ Still locked: ${formatDuration(remaining)} remaining`);
    console.log(`   Re-check later: npm run emergency:status`);
  } else {
    console.log(`\n✅ Timeout reached — owner may run:`);
    console.log(
      `   EMERGENCY_ESCROW_ID=${escrowId} EMERGENCY_OUTCOME=SELLER_VALID npm run emergency:resolve`
    );
  }
}

async function actionResolve(contract, owner, chainId) {
  const drill = readDrill();
  const escrowId =
    process.env.EMERGENCY_ESCROW_ID || (drill && drill.escrowId);
  if (escrowId === undefined || escrowId === null || escrowId === "") {
    throw new Error(
      "Set EMERGENCY_ESCROW_ID or run setup first (emergency_drill.json)"
    );
  }

  const outcome = parseOutcome(process.env.EMERGENCY_OUTCOME);
  const ownerOnChain = await contract.owner();
  if (owner.address.toLowerCase() !== ownerOnChain.toLowerCase()) {
    throw new Error(
      `PRIVATE_KEY wallet ${owner.address} is not contract owner ${ownerOnChain}`
    );
  }

  const before = await contract.getEscrow(escrowId);
  const stateName = STATE_NAMES[Number(before.state)] ?? String(before.state);
  console.log("\n═══ EMERGENCY DRILL — RESOLVE ═══");
  console.log(`Owner:   ${owner.address}`);
  console.log(`Escrow:  #${escrowId}`);
  console.log(`State:   ${stateName}`);
  console.log(`Verdict: ${OUTCOME_NAMES[outcome]}`);

  if (Number(before.state) !== EscrowState.DISPUTED) {
    throw new Error(`Escrow must be DISPUTED (got ${stateName})`);
  }

  const emergencyTimeout = await contract.EMERGENCY_TIMEOUT();
  const latest = await ethers.provider.getBlock("latest");
  const unlockAt = Number(before.disputeRaisedAt) + Number(emergencyTimeout);
  if (Number(latest.timestamp) < unlockAt) {
    throw new Error(
      `EmergencyTimeoutNotReached — wait ${formatDuration(unlockAt - Number(latest.timestamp))}`
    );
  }

  const tx = await contract.connect(owner).emergencyResolve(escrowId, outcome);
  const receipt = await tx.wait();
  console.log(`\n✅ emergencyResolve tx: ${explorerTxUrl(chainId, receipt.hash)}`);

  const after = await contract.getEscrow(escrowId);
  console.log(`State after:  ${STATE_NAMES[Number(after.state)]}`);
  console.log(`Outcome:      ${OUTCOME_NAMES[Number(after.outcome)]}`);
  console.log(`Fallback arb: ${after.resolvedByFallbackArbiter} (expect true)`);

  if (drill) {
    writeDrill({
      ...drill,
      resolvedAtIso: new Date().toISOString(),
      resolveTx: receipt.hash,
      outcome: OUTCOME_NAMES[outcome],
      finalState: STATE_NAMES[Number(after.state)],
    });
  }
}

function resolveAction() {
  if (process.env.EMERGENCY_ACTION) {
    return process.env.EMERGENCY_ACTION.toLowerCase();
  }
  // npm sets npm_lifecycle_event to the script name (emergency:setup / :status / :resolve)
  const life = process.env.npm_lifecycle_event || "";
  if (life.endsWith(":setup") || life === "emergency:setup") return "setup";
  if (life.endsWith(":resolve") || life === "emergency:resolve") return "resolve";
  if (life.endsWith(":status") || life === "emergency:status") return "status";
  return "status";
}

async function main() {
  const action = resolveAction();
  if (network.name !== "baseSepolia" && network.name !== "base-sepolia") {
    console.warn(
      `⚠️  Expected baseSepolia (got ${network.name}). Continuing anyway.`
    );
  }

  const contractAddress = getContractAddress();
  const usdcAddress = getUsdcAddress();
  const provider = ethers.provider;
  const chainId = Number((await provider.getNetwork()).chainId);
  const contract = await ethers.getContractAt("BlackSwanOS", contractAddress);
  const usdc = new ethers.Contract(usdcAddress, ERC20_ABI, provider);

  if (action === "setup") {
    const buyer = new ethers.Wallet(
      requirePrivateKey("SEPOLIA_BUYER_PRIVATE_KEY"),
      provider
    );
    const seller = new ethers.Wallet(
      requirePrivateKey("SEPOLIA_SELLER_PRIVATE_KEY"),
      provider
    );
    await actionSetup(contract, usdc, buyer, seller, chainId);
    return;
  }

  if (action === "status") {
    await actionStatus(contract);
    return;
  }

  if (action === "resolve") {
    const owner = new ethers.Wallet(requirePrivateKey("PRIVATE_KEY"), provider);
    await actionResolve(contract, owner, chainId);
    return;
  }

  throw new Error(
    `Unknown EMERGENCY_ACTION=${action} (use setup | status | resolve)`
  );
}

main().catch((error) => {
  console.error("\n❌ emergency_resolve_sepolia failed:");
  console.error(error.shortMessage || error.message || error);
  process.exit(1);
});
