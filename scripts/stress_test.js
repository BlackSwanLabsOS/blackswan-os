/**
 * scripts/stress_test.js
 *
 * Parallel stress test against the live Base Sepolia BlackSwanOS + local Oracle:
 *   1. Creates 4 escrows (different payloadPrice, mixed good/bad payloads)
 *   2. sellerLock + raiseDispute for each
 *   3. POSTs all 4 payloads to the local Oracle concurrently
 *
 * Purpose:
 *   - Verify systemFeeBps (0.5%) snapshots correctly per price
 *   - Verify Telegram high-value alerts only fire for payloadPrice >= 0.5 USDC
 *   - Verify Oracle/Llama can REJECT garbage datasets (SELLER_CHEATED), not
 *     just rubber-stamp every file as SELLER_VALID
 *   - See whether FastAPI + Llama + chain keep up with parallel dispute traffic
 *
 * Usage:
 *   npx hardhat run scripts/stress_test.js --network baseSepolia
 *
 * Requires the local Oracle already running on http://localhost:8000 and
 * LM Studio serving the local model.
 */

const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { ethers, network } = require("hardhat");
const { getContractAddress, getUsdcAddress } = require("./deployment");
const { oraclePayloadHeaders } = require("./oracle_auth");

const ORACLE_URL = process.env.ORACLE_URL || "http://localhost:8000";
const EscrowState = { AWAITING_SELLER: 0, LOCKED: 1, DISPUTED: 2, RESOLVED: 3, CLAIMED: 4 };

const ERC20_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

function requirePrivateKey(key) {
  const raw = process.env[key];
  if (!raw) throw new Error(`Missing env ${key}`);
  const normalized = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error(`${key} is not a valid private key`);
  }
  return normalized;
}

function explorerTxUrl(chainId, txHash) {
  const base = chainId === 84532 ? "https://sepolia.basescan.org" : "https://basescan.org";
  return `${base}/tx/${txHash}`;
}

async function waitForFreshEscrow(contract, escrowId, expectedState, { maxAttempts = 8, delayMs = 4000 } = {}) {
  let last = await contract.getEscrow(escrowId);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (Number(last.state) === expectedState) return { escrow: last, fresh: true };
    await new Promise((r) => setTimeout(r, delayMs));
    last = await contract.getEscrow(escrowId);
  }
  return { escrow: last, fresh: false };
}

async function ensureApproval(usdc, wallet, contractAddress, requiredAmount, label) {
  // Public Base Sepolia RPC lag: wait before reading allowance after a prior spend.
  await new Promise((r) => setTimeout(r, 2500));
  const current = await usdc.allowance(wallet.address, contractAddress);
  if (current >= requiredAmount) {
    console.log(`   ✅ ${label}: allowance OK (${ethers.formatUnits(current, 6)} USDC)`);
    return;
  }
  console.log(`   🔓 ${label}: approve(${ethers.formatUnits(requiredAmount, 6)} USDC)...`);
  const tx = await usdc.connect(wallet).approve(contractAddress, requiredAmount);
  await tx.wait();
}

/**
 * Four cases:
 *   A 0.2 USDC  — good dataset     (below Telegram threshold; expect SELLER_VALID, no TG)
 *   B 0.4 USDC  — garbage noise    (below threshold; expect SELLER_CHEATED via LLM, no TG)
 *   C 0.8 USDC  — good dataset     (above threshold; expect SELLER_VALID + TG alerts)
 *   D 1.5 USDC  — empty placeholders (above threshold; expect SELLER_CHEATED via LLM + TG)
 *
 * maxFileSize is sized so each payloadPrice clears the on-chain minRequiredPrice floor
 * (0.05 + 0.002 * ceil(bytes/1024) USDC) — cheap escrows cannot declare the full 100 KB.
 */
function buildCases() {
  return [
    {
      tag: "A-good-cheap",
      priceUsdc: "0.2",
      maxFileSize: 1024, // 1 KB → minRequired ≈ 0.052 USDC
      expectTelegram: false,
      expectOutcome: "SELLER_VALID",
      payload: {
        dataset: "stress-good-sensor-batch",
        records: [
          { id: 1, sensor: "temp-01", celsius: 21.4, ts: 1737800100 },
          { id: 2, sensor: "temp-01", celsius: 21.6, ts: 1737800160 },
          { id: 3, sensor: "hum-01", rh: 48.2, ts: 1737800220 },
        ],
      },
    },
    {
      tag: "B-garbage-cheap",
      priceUsdc: "0.4",
      maxFileSize: 2048,
      expectTelegram: false,
      expectOutcome: "SELLER_CHEATED",
      // Valid JSON syntax (passes Steps 1-4) but semantically garbage —
      // this is the path the user asked to verify: Llama must REJECT it.
      payload: {
        asdkjh: "!!!!!",
        qwerty: [null, null, "asdfasdfasdf", 999999999999],
        noise: "x".repeat(200),
        placeholder: "",
        empty: {},
      },
    },
    {
      tag: "C-good-high",
      priceUsdc: "0.8",
      maxFileSize: 4096,
      expectTelegram: true,
      expectOutcome: "SELLER_VALID",
      payload: {
        dataset: "stress-trade-ledger",
        currency: "USDC",
        entries: [
          { tradeId: "T-1001", side: "buy", qty: 12.5, price: 1.02 },
          { tradeId: "T-1002", side: "sell", qty: 4.0, price: 1.05 },
          { tradeId: "T-1003", side: "buy", qty: 8.25, price: 1.01 },
        ],
        generatedAt: new Date().toISOString(),
      },
    },
    {
      tag: "D-junk-high",
      priceUsdc: "1.5",
      maxFileSize: 8192,
      expectTelegram: true,
      expectOutcome: "SELLER_CHEATED",
      // Another LLM-reject case: structurally empty / placeholder junk.
      payload: {
        data: null,
        values: ["N/A", "TODO", "lorem ipsum", ""],
        meta: { foo: "bar", unused: true },
        random: Math.random().toString(36).repeat(20),
      },
    },
  ];
}

async function createDisputeCase(ctx, caseDef) {
  const { contract, usdc, buyer, seller, chainId, systemFeeBps, bpsDenominator, disputeBondBps, minDisputeBond, disputeWindow } = ctx;
  const payloadPrice = ethers.parseUnits(caseDef.priceUsdc, 6);
  const systemFee = (payloadPrice * systemFeeBps) / bpsDenominator;
  const buyerDeposit = payloadPrice + systemFee;
  const sellerCollateral = (payloadPrice * (await contract.COLLATERAL_BPS())) / bpsDenominator;
  const percentageBond = (payloadPrice * disputeBondBps) / bpsDenominator;
  const disputeBond = percentageBond > minDisputeBond ? percentageBond : minDisputeBond;

  const minRequired = await contract.minRequiredPrice(caseDef.maxFileSize);
  if (payloadPrice < minRequired) {
    throw new Error(
      `[${caseDef.tag}] payloadPrice ${caseDef.priceUsdc} < minRequiredPrice ${ethers.formatUnits(minRequired, 6)} for maxFileSize=${caseDef.maxFileSize}`
    );
  }

  console.log(`\n── ${caseDef.tag} ──`);
  console.log(`   price=${caseDef.priceUsdc} fee=${ethers.formatUnits(systemFee, 6)} deposit=${ethers.formatUnits(buyerDeposit, 6)} bond=${ethers.formatUnits(disputeBond, 6)}`);
  console.log(`   expect: ${caseDef.expectOutcome}, telegram=${caseDef.expectTelegram}`);

  await ensureApproval(usdc, buyer, await contract.getAddress(), buyerDeposit, `${caseDef.tag} buyer deposit`);
  await ensureApproval(usdc, seller, await contract.getAddress(), sellerCollateral, `${caseDef.tag} seller collateral`);

  const createTx = await contract
    .connect(buyer)
    .createEscrow(seller.address, payloadPrice, caseDef.maxFileSize, disputeWindow);
  const createReceipt = await createTx.wait();
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

  const payloadObject = { ...caseDef.payload, escrowId: escrowId.toString(), stressTag: caseDef.tag };
  const payloadText = JSON.stringify(payloadObject);
  const payloadHash = `0x${createHash("sha256").update(payloadText, "utf-8").digest("hex")}`;
  const payloadFile = path.join(__dirname, "..", `stress_payload_${escrowId}.json`);
  fs.writeFileSync(payloadFile, payloadText);

  console.log(`   escrowId=${escrowId} feeSnapshot will be ${ethers.formatUnits(systemFee, 6)} USDC (0.5%)`);
  console.log(`   create: ${explorerTxUrl(chainId, createReceipt.hash)}`);

  const lockTx = await contract.connect(seller).sellerLock(escrowId, payloadHash);
  const lockReceipt = await lockTx.wait();
  console.log(`   lock:   ${explorerTxUrl(chainId, lockReceipt.hash)}`);

  await ensureApproval(usdc, buyer, await contract.getAddress(), disputeBond, `${caseDef.tag} dispute bond`);
  const disputeTx = await contract.connect(buyer).raiseDispute(escrowId);
  const disputeReceipt = await disputeTx.wait();
  console.log(`   dispute:${explorerTxUrl(chainId, disputeReceipt.hash)}`);

  const { escrow, fresh } = await waitForFreshEscrow(contract, escrowId, EscrowState.DISPUTED);
  if (!fresh) {
    console.warn(`   ⚠️  escrow ${escrowId} state read may be stale (got ${escrow.state})`);
  }

  return {
    tag: caseDef.tag,
    escrowId,
    payloadFile,
    expectOutcome: caseDef.expectOutcome,
    expectTelegram: caseDef.expectTelegram,
    priceUsdc: caseDef.priceUsdc,
    systemFeeUsdc: ethers.formatUnits(systemFee, 6),
    feeSnapshotOnChain: ethers.formatUnits(escrow.systemFeeSnapshot, 6),
  };
}

async function postPayloadToOracle(caseResult) {
  const url = `${ORACLE_URL}/disputes/${caseResult.escrowId}/payload`;
  const body = fs.readFileSync(caseResult.payloadFile);
  const started = Date.now();
  const res = await fetch(url, {
    method: "POST",
    headers: oraclePayloadHeaders({ "Content-Type": "application/json" }),
    body,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return {
    ...caseResult,
    httpStatus: res.status,
    oracleResponse: json,
    elapsedMs: Date.now() - started,
  };
}

async function main() {
  const contractAddress = getContractAddress();
  const usdcAddress = getUsdcAddress();
  const provider = ethers.provider;
  const chainId = Number((await provider.getNetwork()).chainId);

  const buyer = new ethers.Wallet(requirePrivateKey("SEPOLIA_BUYER_PRIVATE_KEY"), provider);
  const seller = new ethers.Wallet(requirePrivateKey("SEPOLIA_SELLER_PRIVATE_KEY"), provider);
  const contract = await ethers.getContractAt("BlackSwanOS", contractAddress);
  const usdc = new ethers.Contract(usdcAddress, ERC20_ABI, provider);

  const [systemFeeBps, bpsDenominator, disputeBondBps, minDisputeBond, disputeWindow] = await Promise.all([
    contract.systemFeeBps(),
    contract.BPS_DENOMINATOR(),
    contract.disputeBondBps(),
    contract.minDisputeBond(),
    contract.MIN_DISPUTE_WINDOW(),
  ]);

  console.log("💥 BlackSwanOS STRESS TEST");
  console.log(`   network:  ${network.name} (chainId=${chainId})`);
  console.log(`   contract: ${contractAddress}`);
  console.log(`   oracle:   ${ORACLE_URL}`);
  console.log(`   systemFeeBps: ${systemFeeBps} (${Number(systemFeeBps) / 100}%)`);
  console.log(`   buyer:    ${buyer.address}`);
  console.log(`   seller:   ${seller.address}`);

  // Sanity: Oracle must be up before we burn gas on 4 escrows.
  const healthRes = await fetch(`${ORACLE_URL}/health`);
  if (!healthRes.ok) throw new Error(`Oracle /health failed: HTTP ${healthRes.status}`);
  const health = await healthRes.json();
  console.log(`   oracle health: ${JSON.stringify(health)}`);
  if (health.contract_address?.toLowerCase() !== contractAddress.toLowerCase()) {
    throw new Error(
      `Oracle is pointed at ${health.contract_address}, but deployment.json says ${contractAddress}. Restart python main.py.`
    );
  }

  const [buyerBal, sellerBal] = await Promise.all([
    usdc.balanceOf(buyer.address),
    usdc.balanceOf(seller.address),
  ]);
  console.log(`   buyer USDC:  ${ethers.formatUnits(buyerBal, 6)}`);
  console.log(`   seller USDC: ${ethers.formatUnits(sellerBal, 6)}`);

  const cases = buildCases();

  // Preflight: seller needs 200% collateral for EVERY case locked at once;
  // buyer needs deposits + dispute bonds for all cases.
  let sellerNeeded = 0n;
  let buyerNeeded = 0n;
  for (const c of cases) {
    const price = ethers.parseUnits(c.priceUsdc, 6);
    const fee = (price * systemFeeBps) / bpsDenominator;
    const pctBond = (price * disputeBondBps) / bpsDenominator;
    const bond = pctBond > minDisputeBond ? pctBond : minDisputeBond;
    sellerNeeded += (price * 20_000n) / bpsDenominator; // COLLATERAL_BPS = 200%
    buyerNeeded += price + fee + bond;
  }
  console.log(`   buyer needs  ≥ ${ethers.formatUnits(buyerNeeded, 6)} USDC (deposits+bonds)`);
  console.log(`   seller needs ≥ ${ethers.formatUnits(sellerNeeded, 6)} USDC (200% collateral x4)`);
  if (sellerBal < sellerNeeded) {
    throw new Error(
      `Seller has ${ethers.formatUnits(sellerBal, 6)} USDC but needs ${ethers.formatUnits(sellerNeeded, 6)}. ` +
        `Top up at https://faucet.circle.com/ or claimResolved older escrows first.`
    );
  }
  if (buyerBal < buyerNeeded) {
    throw new Error(
      `Buyer has ${ethers.formatUnits(buyerBal, 6)} USDC but needs ${ethers.formatUnits(buyerNeeded, 6)}. ` +
        `Top up at https://faucet.circle.com/`
    );
  }

  const ctx = {
    contract,
    usdc,
    buyer,
    seller,
    chainId,
    systemFeeBps,
    bpsDenominator,
    disputeBondBps,
    minDisputeBond,
    disputeWindow,
  };

  // --- Phase 1: create all 4 disputes SEQUENTIALLY on-chain ---------------
  // (parallel createEscrow from the same wallets risks nonce collisions)
  console.log("\n📦 PHASE 1 — create + lock + raiseDispute (sequential on-chain)...");
  const created = [];
  for (const c of cases) {
    created.push(await createDisputeCase(ctx, c));
  }

  console.log("\n📋 Created escrows:");
  for (const c of created) {
    console.log(
      `   #${c.escrowId} ${c.tag}: price=${c.priceUsdc} feeSnapshot=${c.feeSnapshotOnChain} (computed ${c.systemFeeUsdc}) expect=${c.expectOutcome} tg=${c.expectTelegram}`
    );
  }

  // --- Phase 2: hammer the Oracle in PARALLEL -----------------------------
  console.log("\n⚡ PHASE 2 — POST all payloads to Oracle concurrently...");
  const results = await Promise.all(created.map((c) => postPayloadToOracle(c)));

  console.log("\n" + "=".repeat(78));
  console.log("📊 STRESS TEST RESULTS");
  console.log("=".repeat(78));

  let mismatches = 0;
  for (const r of results) {
    const status = r.oracleResponse?.status || `HTTP_${r.httpStatus}`;
    const ok =
      (r.expectOutcome === "SELLER_VALID" && status === "RESOLVED_SELLER_VALID") ||
      (r.expectOutcome === "SELLER_CHEATED" && status === "RESOLVED_SELLER_CHEATED");
    if (!ok) mismatches += 1;
    console.log(
      `\n[${ok ? "✅" : "❌"}] escrow #${r.escrowId} ${r.tag} (${r.elapsedMs}ms)`
    );
    console.log(`   expected: ${r.expectOutcome}  got: ${status}`);
    console.log(`   telegram expected: ${r.expectTelegram ? "YES (≥0.5 USDC)" : "NO (<0.5 USDC)"}`);
    console.log(`   feeSnapshot: ${r.feeSnapshotOnChain} USDC`);
    console.log(`   tx_hash: ${r.oracleResponse?.tx_hash || "n/a"}`);
    if (r.oracleResponse?.step_failed) {
      console.log(`   decided_by: ${r.oracleResponse.step_failed}`);
    }
  }

  console.log("\n" + "=".repeat(78));
  console.log("📱 TELEGRAM CHECK (manual — look at your phone):");
  console.log("   Expected alerts ONLY for escrows with price ≥ 0.5 USDC:");
  for (const r of results) {
    if (r.expectTelegram) {
      console.log(`   → escrow #${r.escrowId} (${r.tag}, ${r.priceUsdc} USDC): dispute-raised + verdict`);
    } else {
      console.log(`   ✗ escrow #${r.escrowId} (${r.tag}, ${r.priceUsdc} USDC): should be SILENT`);
    }
  }
  console.log("=".repeat(78));

  if (mismatches > 0) {
    console.error(`\n❌ ${mismatches} outcome mismatch(es) — Llama/pipeline did not match expectations.`);
    process.exit(1);
  }
  console.log("\n🎉 All oracle outcomes matched expectations. Check Telegram gating manually.");
}

main().catch((err) => {
  console.error("\n❌ Stress test failed:", err.message || err);
  process.exit(1);
});
