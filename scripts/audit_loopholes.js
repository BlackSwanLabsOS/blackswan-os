/**
 * scripts/audit_loopholes.js
 *
 * Internal security audit harness for BlackSwanOS:
 *   A) On-chain loopholes (local Hardhat + MockUSDC — can time-travel)
 *   B) Oracle FastAPI fuzz (live http://localhost:8000 if up)
 *
 * Usage:
 *   npx hardhat run scripts/audit_loopholes.js --network hardhat
 *   npm run audit:loopholes
 *
 * Optional:
 *   ORACLE_URL=http://localhost:8000   (default)
 *   SKIP_ORACLE_FUZZ=1                 (contract-only)
 */

const assert = require("node:assert/strict");
const { ethers } = require("hardhat");
const { loadOracleHttpSecret, oraclePayloadHeaders } = require("./oracle_auth");

const ORACLE_URL = process.env.ORACLE_URL || "http://localhost:8000";
const SKIP_ORACLE = process.env.SKIP_ORACLE_FUZZ === "1";

const DisputeOutcome = { NONE: 0, SELLER_CHEATED: 1, BUYER_CHEATED: 2, SELLER_VALID: 3 };
const EscrowState = { AWAITING_SELLER: 0, LOCKED: 1, DISPUTED: 2, RESOLVED: 3, CLAIMED: 4 };
const USDC = (n) => ethers.parseUnits(String(n), 6);

const results = [];

function pass(name, detail = "") {
  results.push({ name, ok: true, detail });
  console.log(`  ✅ PASS  ${name}${detail ? " — " + detail : ""}`);
}

function fail(name, detail = "") {
  results.push({ name, ok: false, detail });
  console.log(`  ❌ FAIL  ${name}${detail ? " — " + detail : ""}`);
}

async function expectRevert(promise, label) {
  try {
    await promise;
    fail(label, "expected revert, but tx succeeded");
    return false;
  } catch (err) {
    const msg = String(err.reason || err.shortMessage || err.message || err);
    pass(label, `reverted as expected (${msg.split("\n")[0].slice(0, 80)})`);
    return true;
  }
}

async function deployFixture() {
  const [owner, buyer, seller, oracle, attacker, other] = await ethers.getSigners();
  const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
  await usdc.waitForDeployment();

  // 50 bps = 0.5% system fee (matches production intent)
  const contract = await (
    await ethers.getContractFactory("BlackSwanOS")
  ).deploy(await usdc.getAddress(), oracle.address, 50n, USDC("0"));
  await contract.waitForDeployment();

  for (const acct of [buyer, seller, attacker, other]) {
    await usdc.mint(acct.address, USDC("100000"));
    await usdc.connect(acct).approve(await contract.getAddress(), ethers.MaxUint256);
  }

  return { owner, buyer, seller, oracle, attacker, other, usdc, contract };
}

async function createLocked(ctx, price = "1", opts = {}) {
  const { contract, buyer, seller } = ctx;
  const maxFileSize = opts.maxFileSize ?? 1024;
  const disputeWindow = opts.disputeWindow ?? (await contract.MIN_DISPUTE_WINDOW());
  const payloadPrice = USDC(price);
  await (
    await contract.connect(buyer).createEscrow(seller.address, payloadPrice, maxFileSize, disputeWindow)
  ).wait();
  const escrowId = (await contract.nextEscrowId()) - 1n;
  const hash = opts.hash ?? ethers.id("audit-payload-" + escrowId.toString());
  await (await contract.connect(seller).sellerLock(escrowId, hash)).wait();
  return { escrowId, disputeWindow, payloadPrice };
}

// ---------------------------------------------------------------------------
// A) CONTRACT ATTACKS
// ---------------------------------------------------------------------------

async function testDoubleClaimFunds(ctx) {
  console.log("\n── A1. Double-claim: claimFunds twice ──");
  const { contract, buyer, seller } = ctx;
  const { escrowId, disputeWindow } = await createLocked(ctx, "1");

  await ethers.provider.send("evm_increaseTime", [Number(disputeWindow) + 1]);
  await ethers.provider.send("evm_mine", []);

  await (await contract.connect(seller).claimFunds(escrowId)).wait();
  const after = await contract.getEscrow(escrowId);
  assert.equal(Number(after.state), EscrowState.CLAIMED);

  await expectRevert(contract.connect(buyer).claimFunds(escrowId), "second claimFunds reverts");
  await expectRevert(contract.connect(seller).claimFunds(escrowId), "third claimFunds (seller again) reverts");
}

async function testDoubleClaimResolved(ctx) {
  console.log("\n── A2. Double-claim: claimResolved twice ──");
  const { contract, buyer, seller, oracle } = ctx;
  const { escrowId } = await createLocked(ctx, "1");
  await (await contract.connect(buyer).raiseDispute(escrowId)).wait();
  await (await contract.connect(oracle).resolveDispute(escrowId, DisputeOutcome.SELLER_VALID)).wait();

  await (await contract.connect(attackerOrBuyer(ctx)).claimResolved(escrowId)).wait();
  await expectRevert(contract.connect(buyer).claimResolved(escrowId), "second claimResolved reverts");
  await expectRevert(contract.connect(seller).claimResolved(escrowId), "claimResolved by other party also reverts");
}

function attackerOrBuyer(ctx) {
  return ctx.attacker; // permissionless claim — attacker can trigger first claim
}

async function testDisputeWindow(ctx) {
  console.log("\n── A3. disputeWindow timing (claimFunds before/after) ──");
  const { contract, seller, buyer } = ctx;
  const { escrowId, disputeWindow } = await createLocked(ctx, "1");

  await expectRevert(
    contract.connect(seller).claimFunds(escrowId),
    "claimFunds BEFORE window ends → DisputeWindowActive"
  );

  // Still inside window — raiseDispute must work
  await (await contract.connect(buyer).raiseDispute(escrowId)).wait();
  const disputed = await contract.getEscrow(escrowId);
  assert.equal(Number(disputed.state), EscrowState.DISPUTED);
  pass("raiseDispute inside window works");

  // claimFunds must NOT work on DISPUTED
  await expectRevert(
    contract.connect(seller).claimFunds(escrowId),
    "claimFunds while DISPUTED → InvalidState"
  );

  // Fresh escrow: skip past window without dispute → claimFunds OK
  const { escrowId: id2, disputeWindow: w2 } = await createLocked(ctx, "1");
  await ethers.provider.send("evm_increaseTime", [Number(w2) + 1]);
  await ethers.provider.send("evm_mine", []);
  await (await contract.connect(seller).claimFunds(id2)).wait();
  pass("claimFunds AFTER window (no dispute) works");

  // raiseDispute after window must fail
  const { escrowId: id3, disputeWindow: w3 } = await createLocked(ctx, "1");
  await ethers.provider.send("evm_increaseTime", [Number(w3) + 1]);
  await ethers.provider.send("evm_mine", []);
  await expectRevert(
    contract.connect(buyer).raiseDispute(id3),
    "raiseDispute AFTER window → DisputeWindowExpired"
  );
}

async function testUnauthorizedResolve(ctx) {
  console.log("\n── A4. Unauthorized resolveDispute (attacker ≠ oracle) ──");
  const { contract, buyer, attacker } = ctx;
  const { escrowId } = await createLocked(ctx, "1");
  await (await contract.connect(buyer).raiseDispute(escrowId)).wait();

  await expectRevert(
    contract.connect(attacker).resolveDispute(escrowId, DisputeOutcome.SELLER_VALID),
    "attacker resolveDispute → Unauthorized"
  );
  await expectRevert(
    contract.connect(buyer).resolveDispute(escrowId, DisputeOutcome.SELLER_CHEATED),
    "buyer cannot self-resolve"
  );
}

async function testDoubleResolve(ctx) {
  console.log("\n── A5. Double resolveDispute by oracle ──");
  const { contract, buyer, oracle } = ctx;
  const { escrowId } = await createLocked(ctx, "1");
  await (await contract.connect(buyer).raiseDispute(escrowId)).wait();
  await (await contract.connect(oracle).resolveDispute(escrowId, DisputeOutcome.SELLER_VALID)).wait();
  await expectRevert(
    contract.connect(oracle).resolveDispute(escrowId, DisputeOutcome.SELLER_CHEATED),
    "second resolveDispute → AlreadyResolved"
  );
}

async function testWrongSellerLock(ctx) {
  console.log("\n── A6. Wrong party sellerLock / raiseDispute ──");
  const { contract, buyer, attacker, seller } = ctx;
  const maxFileSize = 1024;
  const window = await contract.MIN_DISPUTE_WINDOW();
  await (
    await contract.connect(buyer).createEscrow(seller.address, USDC("1"), maxFileSize, window)
  ).wait();
  const escrowId = (await contract.nextEscrowId()) - 1n;

  await expectRevert(
    contract.connect(attacker).sellerLock(escrowId, ethers.id("x")),
    "random address cannot sellerLock"
  );
  await (await contract.connect(seller).sellerLock(escrowId, ethers.id("x"))).wait();
  await expectRevert(
    contract.connect(attacker).raiseDispute(escrowId),
    "random address cannot raiseDispute"
  );
}

async function testClaimFundsWhileDisputedThenResolved(ctx) {
  console.log("\n── A7. Cannot claimFunds after dispute; only claimResolved ──");
  const { contract, buyer, seller, oracle } = ctx;
  const { escrowId, disputeWindow } = await createLocked(ctx, "1");
  await (await contract.connect(buyer).raiseDispute(escrowId)).wait();

  await ethers.provider.send("evm_increaseTime", [Number(disputeWindow) + 1]);
  await ethers.provider.send("evm_mine", []);
  await expectRevert(
    contract.connect(seller).claimFunds(escrowId),
    "even after time passes, DISPUTED blocks claimFunds"
  );

  await (await contract.connect(oracle).resolveDispute(escrowId, DisputeOutcome.SELLER_CHEATED)).wait();
  await (await contract.connect(buyer).claimResolved(escrowId)).wait();
  pass("claimResolved after SELLER_CHEATED works");
}

async function testEmergencyBeforeTimeout(ctx) {
  console.log("\n── A8. emergencyResolve before 24h ──");
  const { contract, buyer, owner } = ctx;
  const { escrowId } = await createLocked(ctx, "1");
  await (await contract.connect(buyer).raiseDispute(escrowId)).wait();
  await expectRevert(
    contract.connect(owner).emergencyResolve(escrowId, DisputeOutcome.SELLER_VALID),
    "emergencyResolve before 24h → EmergencyTimeoutNotReached"
  );
}

async function testSweepCannotTouchLocked(ctx) {
  console.log("\n── A9. sweepFees cannot steal locked escrow USDC ──");
  const { contract, owner, usdc, buyer, seller } = ctx;
  await createLocked(ctx, "5");
  const free = (await usdc.balanceOf(await contract.getAddress())) - (await contract.totalLockedFunds());
  // Try to sweep more than free (i.e. into locked funds)
  const locked = await contract.totalLockedFunds();
  if (locked > 0n) {
    await expectRevert(
      contract.connect(owner).sweepFees(await usdc.getAddress(), owner.address, free + 1n),
      "sweepFees(locked+1) → ExceedsFreeBalance"
    );
  } else {
    pass("sweepFees locked check skipped (no locked — unexpected)", "warn");
  }
}

async function testCreateEscrowSelfAsSeller(ctx) {
  console.log("\n── A10. Buyer cannot create escrow with self as seller ──");
  const { contract, buyer } = ctx;
  const window = await contract.MIN_DISPUTE_WINDOW();
  await expectRevert(
    contract.connect(buyer).createEscrow(buyer.address, USDC("1"), 1024, window),
    "createEscrow(seller=self) → InvalidAddress"
  );
}

// ---------------------------------------------------------------------------
// B) ORACLE HTTP FUZZ
// ---------------------------------------------------------------------------

async function oracleFuzz() {
  console.log("\n── B. Oracle FastAPI fuzz (must stay alive, prefer ≠ 500) ──");
  try {
    const h = await fetch(`${ORACLE_URL}/health`, { signal: AbortSignal.timeout(5000) });
    if (!h.ok) throw new Error(`HTTP ${h.status}`);
  } catch {
    fail("oracle /health reachable", `cannot reach ${ORACLE_URL} — start: python main.py`);
    return;
  }
  pass("oracle /health reachable");

  const secret = loadOracleHttpSecret();
  if (!secret) {
    fail(
      "ORACLE_HTTP_SECRET configured for audit client",
      "missing in oracle/.env — cannot test auth door lock"
    );
    return;
  }
  pass("ORACLE_HTTP_SECRET loaded for audit client");

  // --- Door lock: auth (before body/LLM) ---
  try {
    const noSecret = await fetch(`${ORACLE_URL}/disputes/1/payload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(15000),
    });
    if (noSecret.status === 401) pass("POST without X-Oracle-Secret → 401");
    else fail("POST without X-Oracle-Secret → 401", `got HTTP ${noSecret.status}`);
  } catch (err) {
    fail("POST without X-Oracle-Secret → 401", err.message);
  }

  try {
    const badSecret = await fetch(`${ORACLE_URL}/disputes/1/payload`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Oracle-Secret": "definitely-wrong-secret",
      },
      body: "{}",
      signal: AbortSignal.timeout(15000),
    });
    if (badSecret.status === 401) pass("POST with wrong X-Oracle-Secret → 401");
    else fail("POST with wrong X-Oracle-Secret → 401", `got HTTP ${badSecret.status}`);
  } catch (err) {
    fail("POST with wrong X-Oracle-Secret → 401", err.message);
  }

  try {
    const withSecret = await fetch(`${ORACLE_URL}/disputes/1/payload`, {
      method: "POST",
      headers: oraclePayloadHeaders({ "Content-Type": "application/json" }),
      body: "{}",
      signal: AbortSignal.timeout(30000),
    });
    if (withSecret.status === 401) {
      fail(
        "POST with valid X-Oracle-Secret not rejected as 401",
        "got 401 — restart Oracle after setting ORACLE_HTTP_SECRET?"
      );
    } else if (withSecret.status >= 500) {
      fail("POST with valid X-Oracle-Secret not rejected as 401", `got HTTP ${withSecret.status}`);
    } else {
      pass("POST with valid X-Oracle-Secret accepted past auth", `HTTP ${withSecret.status}`);
    }
  } catch (err) {
    fail("POST with valid X-Oracle-Secret not rejected as 401", err.message);
  }

  const authHeaders = () => oraclePayloadHeaders({ "Content-Type": "application/json" });

  const cases = [
    {
      name: "POST empty body",
      run: () =>
        fetch(`${ORACLE_URL}/disputes/1/payload`, {
          method: "POST",
          headers: authHeaders(),
          body: "",
          signal: AbortSignal.timeout(30000),
        }),
    },
    {
      name: "POST garbage bytes",
      run: () =>
        fetch(`${ORACLE_URL}/disputes/1/payload`, {
          method: "POST",
          headers: authHeaders(),
          body: Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x7b]),
          signal: AbortSignal.timeout(30000),
        }),
    },
    {
      name: "POST invalid JSON text",
      run: () =>
        fetch(`${ORACLE_URL}/disputes/1/payload`, {
          method: "POST",
          headers: authHeaders(),
          body: "{not json!!!",
          signal: AbortSignal.timeout(30000),
        }),
    },
    {
      // Node's fetch forbids forging Content-Length; instead blast a body
      // clearly over the 100 KB ceiling to exercise the streaming DoS guard.
      name: "POST oversized body (>100KB DoS guard)",
      run: () =>
        fetch(`${ORACLE_URL}/disputes/1/payload`, {
          method: "POST",
          headers: authHeaders(),
          body: Buffer.alloc(120_000, 0x61), // 120 KB of 'a'
          signal: AbortSignal.timeout(60000),
        }),
    },
    {
      name: "GET weird escrow id string path (if routed)",
      run: () =>
        fetch(`${ORACLE_URL}/disputes/not-a-number/status`, {
          signal: AbortSignal.timeout(15000),
        }),
    },
    {
      name: "GET negative-looking id",
      run: () =>
        fetch(`${ORACLE_URL}/disputes/-1/status`, { signal: AbortSignal.timeout(15000) }),
    },
    {
      name: "GET huge escrow id",
      run: () =>
        fetch(`${ORACLE_URL}/disputes/999999999999/status`, {
          signal: AbortSignal.timeout(15000),
        }),
    },
    {
      name: "POST path traversal style id",
      run: () =>
        fetch(`${ORACLE_URL}/disputes/../admin/disputes/payload`, {
          method: "POST",
          headers: authHeaders(),
          body: "{}",
          signal: AbortSignal.timeout(15000),
        }),
    },
    {
      name: "POST SQL-ish payload body",
      run: () =>
        fetch(`${ORACLE_URL}/disputes/1/payload`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify({
            a: "'; DROP TABLE disputes;--",
            b: "' OR 1=1 --",
          }),
          signal: AbortSignal.timeout(60000),
        }),
    },
  ];

  let crashed = false;
  for (const c of cases) {
    try {
      const res = await c.run();
      const status = res.status;
      // 500 is a soft fail for audit (server handled it but errored);
      // connection failure = hard fail (crash / down).
      if (status >= 500) {
        fail(c.name, `HTTP ${status} (server error — should prefer 4xx)`);
      } else {
        pass(c.name, `HTTP ${status}`);
      }
    } catch (err) {
      crashed = true;
      fail(c.name, `request failed — Oracle may have crashed: ${err.message}`);
    }
  }

  // Rate limit: hammer until 429 (uses current RATE_LIMIT_PER_MINUTE on server).
  // Skip if RATE_LIMIT_PER_MINUTE=0 (disabled).
  try {
    let got429 = false;
    let lastStatus = 0;
    for (let i = 0; i < 120; i++) {
      const res = await fetch(`${ORACLE_URL}/disputes/1/payload`, {
        method: "POST",
        headers: authHeaders(),
        body: "{}",
        signal: AbortSignal.timeout(10000),
      });
      lastStatus = res.status;
      if (res.status === 429) {
        got429 = true;
        break;
      }
    }
    if (got429) pass("POST rate limit eventually returns 429");
    else {
      fail(
        "POST rate limit eventually returns 429",
        `no 429 after 120 hits (last HTTP ${lastStatus}) — is RATE_LIMIT_PER_MINUTE=0?`
      );
    }
  } catch (err) {
    fail("POST rate limit eventually returns 429", err.message);
  }

  // Still alive?
  try {
    const h2 = await fetch(`${ORACLE_URL}/health`, { signal: AbortSignal.timeout(5000) });
    if (h2.ok) pass("oracle still alive after fuzz");
    else fail("oracle still alive after fuzz", `HTTP ${h2.status}`);
  } catch (err) {
    fail("oracle still alive after fuzz", err.message);
    crashed = true;
  }

  if (!crashed) {
    pass("no Oracle process crash during fuzz suite");
  }
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

async function main() {
  console.log("🔐 BlackSwanOS INTERNAL SECURITY AUDIT");
  console.log("   Contract tests: Hardhat in-process (time travel OK)");
  console.log(`   Oracle fuzz:    ${SKIP_ORACLE ? "SKIPPED" : ORACLE_URL}`);

  const ctx = await deployFixture();

  await testDoubleClaimFunds(ctx);
  await testDoubleClaimResolved(ctx);
  await testDisputeWindow(ctx);
  await testUnauthorizedResolve(ctx);
  await testDoubleResolve(ctx);
  await testWrongSellerLock(ctx);
  await testClaimFundsWhileDisputedThenResolved(ctx);
  await testEmergencyBeforeTimeout(ctx);
  await testSweepCannotTouchLocked(ctx);
  await testCreateEscrowSelfAsSeller(ctx);

  if (!SKIP_ORACLE) {
    await oracleFuzz();
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;

  console.log("\n" + "=".repeat(72));
  console.log(`AUDIT RESULTS: ${passed} passed, ${failed} failed (of ${results.length})`);
  console.log("=".repeat(72));
  if (failed) {
    console.log("\nFailed cases:");
    for (const r of results.filter((x) => !x.ok)) {
      console.log(`  - ${r.name}: ${r.detail}`);
    }
    process.exitCode = 1;
  } else {
    console.log("\nAll automated loophole checks passed.");
  }
}

main().catch((e) => {
  console.error("Audit harness crashed:", e);
  process.exit(1);
});
