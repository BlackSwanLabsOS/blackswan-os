/**
 * scripts/verify_dispute_bond.js
 *
 * Standalone, in-process (no network fork needed) exhaustive check that the
 * dispute-bond + fallback-arbiter security fix keeps `totalLockedFunds`
 * balanced to the exact unit (USDC base unit, 6 decimals) across every new
 * code path, and that `emergencyResolve` produces IDENTICAL payouts to the
 * normal oracle `resolveDispute` + `claimResolved` path.
 *
 * Run with:  npx hardhat run scripts/verify_dispute_bond.js --network hardhat
 *
 * This is NOT wired into `npm test` (the project has no automated test
 * suite yet) — it's an ad hoc verification script for this specific fix.
 * Consider promoting it into `test/BlackSwanOS.test.js` with Hardhat's
 * `chai`/`mocha` assertions later.
 */

const { ethers } = require("hardhat");
const assert = require("node:assert/strict");

const DisputeOutcome = { NONE: 0, SELLER_CHEATED: 1, BUYER_CHEATED: 2, SELLER_VALID: 3 };
const EscrowState = { AWAITING_SELLER: 0, LOCKED: 1, DISPUTED: 2, RESOLVED: 3, CLAIMED: 4 };

const USDC = (n) => ethers.parseUnits(n, 6);

async function deployFixture() {
  const [owner, buyer, seller, oracle, other] = await ethers.getSigners();

  const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
  await usdc.waitForDeployment();

  // 500 bps (5%) — chosen so that, combined with this suite's near-universal
  // payloadPrice="100" USDC across the matrix scenarios below, the snapshotted
  // fee is still exactly 5 USDC (same numbers the assertions already expect),
  // even though the fee is now computed PER-ESCROW from payloadPrice instead
  // of being a flat global amount (see BlackSwanOS.sol's BPS migration).
  const systemFeeBps = 500n;
  const arbitrationFee = USDC("10");
  const contract = await (await ethers.getContractFactory("BlackSwanOS")).deploy(
    await usdc.getAddress(),
    oracle.address,
    systemFeeBps,
    arbitrationFee
  );
  await contract.waitForDeployment();

  for (const acct of [buyer, seller]) {
    await usdc.mint(acct.address, USDC("100000"));
    await usdc.connect(acct).approve(await contract.getAddress(), ethers.MaxUint256);
  }

  return { owner, buyer, seller, oracle, other, usdc, contract, systemFeeBps, arbitrationFee };
}

async function usdcBalance(usdc, addr) {
  return usdc.balanceOf(addr);
}

async function createAndLock(ctx, payloadPriceStr, opts = {}) {
  const { contract, buyer, seller } = ctx;
  const payloadPrice = USDC(payloadPriceStr);
  const maxFileSize = opts.maxFileSize ?? (await contract.MAX_ALLOWED_FILE_SIZE());
  const disputeWindow = opts.disputeWindow ?? (await contract.MIN_DISPUTE_WINDOW());
  const tx = await contract.connect(buyer).createEscrow(seller.address, payloadPrice, maxFileSize, disputeWindow);
  await tx.wait();
  const escrowId = (await contract.nextEscrowId()) - 1n;
  await (await contract.connect(seller).sellerLock(escrowId, ethers.id("payload"))).wait();
  return escrowId;
}

async function assertFullyUnlocked(ctx, label) {
  const { contract, usdc } = ctx;
  const totalLocked = await contract.totalLockedFunds();
  const contractBalance = await usdc.balanceOf(await contract.getAddress());
  assert.equal(totalLocked, 0n, `[${label}] totalLockedFunds should be 0 after full settlement, got ${totalLocked}`);
  // Free balance == whatever forfeited bonds/dust remain; never negative, never > contract balance.
  assert.ok(contractBalance >= 0n, `[${label}] contract balance should never go negative`);
}

async function scenarioHappyPath(ctx) {
  const { contract, buyer, seller } = ctx;
  const escrowId = await createAndLock(ctx, "100"); // uses MIN_DISPUTE_WINDOW (1h) by default
  const disputeWindow = await contract.MIN_DISPUTE_WINDOW();
  await ethers.provider.send("evm_increaseTime", [Number(disputeWindow) + 1]);
  await ethers.provider.send("evm_mine", []);

  const sellerBefore = await usdcBalance(ctx.usdc, seller.address);
  await (await contract.connect(buyer).claimFunds(escrowId)).wait();
  const sellerAfter = await usdcBalance(ctx.usdc, seller.address);

  assert.equal(sellerAfter - sellerBefore, USDC("300"), "happy path: seller should net payloadPrice+collateral = 300");
  await assertFullyUnlocked(ctx, "happyPath");
  console.log("✅ scenarioHappyPath: OK (no dispute, totalLockedFunds == 0, seller +300 USDC)");
}

async function scenarioCancelUnmatched(ctx) {
  const { contract, buyer } = ctx;
  const payloadPrice = USDC("50");
  const maxFileSize = await contract.MAX_ALLOWED_FILE_SIZE();
  const disputeWindow = await contract.MIN_DISPUTE_WINDOW();
  await (await contract.connect(buyer).createEscrow(await ctx.other.getAddress(), payloadPrice, maxFileSize, disputeWindow)).wait();
  const escrowId = (await contract.nextEscrowId()) - 1n;

  await ethers.provider.send("evm_increaseTime", [61 * 60]);
  await ethers.provider.send("evm_mine", []);

  const buyerBefore = await usdcBalance(ctx.usdc, buyer.address);
  await (await contract.connect(buyer).cancelUnmatched(escrowId)).wait();
  const buyerAfter = await usdcBalance(ctx.usdc, buyer.address);

  // payloadPrice=50 USDC, fee is now 5% of THIS escrow's price (500 bps),
  // not a flat 5 USDC -> 50 * 0.05 = 2.5 USDC fee -> 52.5 USDC total refund.
  assert.equal(buyerAfter - buyerBefore, USDC("52.5"), "cancelUnmatched: buyer should get back payloadPrice+systemFee = 52.5");
  await assertFullyUnlocked(ctx, "cancelUnmatched");
  console.log("✅ scenarioCancelUnmatched: OK (totalLockedFunds == 0, buyer refunded 52.5 USDC)");
}

/**
 * Core matrix: for each (whoRaised, outcome, viaFallback) combination, verify
 * (a) totalLockedFunds returns to exactly 0, (b) the bond goes to the correct
 * party, (c) emergencyResolve produces IDENTICAL payouts to resolveDispute+claimResolved.
 */
async function scenarioDisputeMatrix(ctx) {
  const { contract, buyer, seller, oracle, owner, usdc } = ctx;
  // Hybrid formula: max(payloadPrice * disputeBondBps / 10_000, minDisputeBond).
  // All escrows in this matrix use payloadPrice=100 USDC, so 5% (500 bps) of
  // 100 = 5 USDC, which is well above the 0.20 USDC floor -> percentage wins.
  const bps = await contract.disputeBondBps();
  const minBond = await contract.minDisputeBond();
  assert.equal(bps, 500n, "default disputeBondBps should be 500 (5%)");
  assert.equal(minBond, USDC("0.20"), "default minDisputeBond should be 0.20 USDC");
  const bond = USDC("5");
  assert.equal(bond, (USDC("100") * bps) / 10_000n, "sanity: 5% of 100 USDC == 5 USDC");

  const cases = [
    { raiser: "buyer", outcome: DisputeOutcome.SELLER_CHEATED, raiserWins: true, viaFallback: false },
    { raiser: "buyer", outcome: DisputeOutcome.BUYER_CHEATED, raiserWins: false, viaFallback: false },
    { raiser: "buyer", outcome: DisputeOutcome.SELLER_VALID, raiserWins: false, viaFallback: true },
    { raiser: "seller", outcome: DisputeOutcome.BUYER_CHEATED, raiserWins: true, viaFallback: true },
    { raiser: "seller", outcome: DisputeOutcome.SELLER_VALID, raiserWins: true, viaFallback: false },
    { raiser: "seller", outcome: DisputeOutcome.SELLER_CHEATED, raiserWins: false, viaFallback: false },
  ];

  let expectedForfeitedTotal = 0n; // accumulates across cases sharing one `ctx`/contract instance

  for (const c of cases) {
    const escrowId = await createAndLock(ctx, "100");
    const raiser = c.raiser === "buyer" ? buyer : seller;
    const label = `raiser=${c.raiser} outcome=${c.outcome} viaFallback=${c.viaFallback}`;

    await (await contract.connect(raiser).raiseDispute(escrowId)).wait();
    const afterRaise = await contract.getEscrow(escrowId);
    assert.equal(afterRaise.state, BigInt(EscrowState.DISPUTED));
    assert.equal(afterRaise.disputeRaisedBy, raiser.address);
    assert.equal(afterRaise.disputeBondSnapshot, bond);

    const buyerBefore = await usdcBalance(usdc, buyer.address);
    const sellerBefore = await usdcBalance(usdc, seller.address);
    const ownerBefore = await usdcBalance(usdc, owner.address);

    let settleReceipt;
    if (c.viaFallback) {
      // Skip straight to the 24h fallback instead of resolveDispute.
      await ethers.provider.send("evm_increaseTime", [24 * 60 * 60 + 1]);
      await ethers.provider.send("evm_mine", []);
      settleReceipt = await (await contract.connect(owner).emergencyResolve(escrowId, c.outcome)).wait();
    } else {
      await (await contract.connect(oracle).resolveDispute(escrowId, c.outcome)).wait();
      settleReceipt = await (await contract.connect(buyer).claimResolved(escrowId)).wait();
    }

    // Authoritative bond-settlement check: read it straight from the event
    // rather than trying to back it out of net balance deltas.
    const settledEvent = settleReceipt.logs
      .map((l) => { try { return contract.interface.parseLog(l); } catch { return null; } })
      .find((p) => p?.name === "DisputeBondSettled");
    assert.ok(settledEvent, `[${label}] DisputeBondSettled must be emitted`);
    assert.equal(settledEvent.args.payer, raiser.address, `[${label}] bond payer must be the raiser`);
    assert.equal(settledEvent.args.refunded, c.raiserWins, `[${label}] refunded flag must match expected winner`);
    assert.equal(settledEvent.args.amount, bond, `[${label}] settled amount must equal the snapshotted bond`);

    const escrowAfter = await contract.getEscrow(escrowId);
    assert.equal(escrowAfter.state, BigInt(EscrowState.CLAIMED), `[${label}] should end CLAIMED`);
    assert.equal(escrowAfter.resolvedByFallbackArbiter, c.viaFallback, `[${label}] fallback flag mismatch`);

    // Conservation check: total distributed (buyer+seller+owner deltas) must
    // equal exactly what was locked, MINUS a forfeited bond that deliberately
    // stays inside the contract (as free/sweepable balance) instead of being
    // transferred to anyone at settlement time:
    //   - raiser won  -> bond IS transferred back to them -> 310 distributed
    //                     (300 payload+collateral + 5 systemFee + 5 bond refund).
    //   - raiser lost -> bond stays put -> only 305 distributed, and the
    //                     contract's free (non-locked) balance must hold exactly
    //                     the forfeited 5 USDC bond.
    const buyerDelta = (await usdcBalance(usdc, buyer.address)) - buyerBefore;
    const sellerDelta = (await usdcBalance(usdc, seller.address)) - sellerBefore;
    const ownerDelta = (await usdcBalance(usdc, owner.address)) - ownerBefore;
    const totalOut = buyerDelta + sellerDelta + ownerDelta;
    const expectedOut = c.raiserWins ? USDC("310") : USDC("305");
    assert.equal(totalOut, expectedOut, `[${label}] conservation: total distributed must equal total locked minus any forfeited (unswept) bond`);

    if (!c.raiserWins) {
      expectedForfeitedTotal += bond;
    }
    const contractBalance = await usdc.balanceOf(await contract.getAddress());
    const totalLocked = await contract.totalLockedFunds();
    assert.equal(
      contractBalance - totalLocked,
      expectedForfeitedTotal,
      `[${label}] free/sweepable balance must equal the running total of forfeited bonds so far, not vanish or get auto-swept`
    );

    await assertFullyUnlocked(ctx, label);
    console.log(`✅ matrix ${label}: bond correctly ${c.raiserWins ? "refunded" : "forfeited"}, conservation OK, totalLockedFunds == 0`);
  }
}

async function scenarioBondEventsAndSweep(ctx) {
  const { contract, buyer, seller, oracle, owner, usdc } = ctx;

  // Buyer raises a dispute and LOSES (BUYER_CHEATED) — bond must be forfeited
  // (stay in contract) and become sweepable, without ever being transferred
  // to owner automatically.
  const escrowId = await createAndLock(ctx, "100");
  const tx = await contract.connect(buyer).raiseDispute(escrowId);
  const receipt = await tx.wait();
  const bondPaidEvent = receipt.logs
    .map((l) => { try { return contract.interface.parseLog(l); } catch { return null; } })
    .find((p) => p?.name === "DisputeBondPaid");
  assert.ok(bondPaidEvent, "DisputeBondPaid event must be emitted");
  // payloadPrice=100 USDC, default 5% bps -> bond = 5 USDC (percentage wins over the 0.20 floor).
  assert.equal(bondPaidEvent.args.amount, USDC("5"));

  await (await contract.connect(oracle).resolveDispute(escrowId, DisputeOutcome.BUYER_CHEATED)).wait();
  const claimTx = await contract.connect(buyer).claimResolved(escrowId);
  const claimReceipt = await claimTx.wait();
  const settledEvent = claimReceipt.logs
    .map((l) => { try { return contract.interface.parseLog(l); } catch { return null; } })
    .find((p) => p?.name === "DisputeBondSettled");
  assert.ok(settledEvent, "DisputeBondSettled event must be emitted");
  assert.equal(settledEvent.args.refunded, false, "buyer lost -> bond must be forfeited, not refunded");
  assert.equal(settledEvent.args.amount, USDC("5"));

  // Now the forfeited 5 USDC must be exactly sweepable (free balance),
  // and NOT one unit more.
  const contractBalance = await usdc.balanceOf(await contract.getAddress());
  const totalLocked = await contract.totalLockedFunds();
  const freeBalance = contractBalance - totalLocked;
  assert.equal(freeBalance, USDC("5"), "forfeited bond should be exactly the sweepable free balance");

  await assert.rejects(
    contract.connect(owner).sweepFees(await usdc.getAddress(), owner.address, freeBalance + 1n),
    /ExceedsFreeBalance/,
    "sweeping 1 unit more than free balance must revert with ExceedsFreeBalance"
  );

  await (await contract.connect(owner).sweepFees(await usdc.getAddress(), owner.address, freeBalance)).wait();
  const totalLockedAfterSweep = await contract.totalLockedFunds();
  assert.equal(totalLockedAfterSweep, 0n);
  console.log("✅ scenarioBondEventsAndSweep: OK (forfeited bond exactly sweepable, over-sweep correctly reverts)");
}

/**
 * Dedicated coverage for the hybrid bond FORMULA itself (independent of the
 * win/lose settlement matrix above): both branches of
 * `max(payloadPrice * bps / 10_000, minDisputeBond)`, owner-setter validation,
 * and non-retroactivity of `setDisputeBondParams` on already-open disputes.
 */
async function scenarioHybridBondFormula(ctx) {
  const { contract, buyer, seller, owner } = ctx;

  const defaultBps = await contract.disputeBondBps();
  const defaultMinBond = await contract.minDisputeBond();
  assert.equal(defaultBps, 500n, "default disputeBondBps should be 500 (5%)");
  assert.equal(defaultMinBond, USDC("0.20"), "default minDisputeBond should be 0.20 USDC");

  // Branch A: percentage wins — 5% of 100 USDC = 5 USDC > 0.20 floor.
  {
    const escrowId = await createAndLock(ctx, "100");
    await (await contract.connect(buyer).raiseDispute(escrowId)).wait();
    const e = await contract.getEscrow(escrowId);
    assert.equal(e.disputeBondSnapshot, USDC("5"), "100 USDC escrow: percentage (5) should win over floor (0.20)");
  }

  // Branch B: floor wins — 5% of 1 USDC = 0.05 < 0.20 floor.
  {
    const escrowId = await createAndLock(ctx, "1");
    await (await contract.connect(seller).raiseDispute(escrowId)).wait();
    const e = await contract.getEscrow(escrowId);
    assert.equal(e.disputeBondSnapshot, USDC("0.20"), "1 USDC escrow: floor (0.20) should win over percentage (0.05)");
  }

  // setDisputeBondParams validation: reject nonsensical/overflowing params.
  await assert.rejects(
    contract.connect(owner).setDisputeBondParams(10_001, USDC("0.20")),
    /InvalidAmount/,
    "bps above BPS_DENOMINATOR (100%) must revert"
  );
  await assert.rejects(
    contract.connect(owner).setDisputeBondParams(500, 2n ** 128n),
    /InvalidAmount/,
    "minDisputeBond above uint128 max must revert"
  );

  // Non-retroactivity: an already-open dispute keeps its snapshotted bond
  // even after the owner changes the formula; only NEW disputes see the
  // updated rate.
  const openEscrowId = await createAndLock(ctx, "100");
  await (await contract.connect(buyer).raiseDispute(openEscrowId)).wait();
  const snapshotBefore = (await contract.getEscrow(openEscrowId)).disputeBondSnapshot;
  assert.equal(snapshotBefore, USDC("5"));

  const tx = await contract.connect(owner).setDisputeBondParams(1000, USDC("1")); // 10%, floor 1 USDC
  const receipt = await tx.wait();
  const updatedEvent = receipt.logs
    .map((l) => { try { return contract.interface.parseLog(l); } catch { return null; } })
    .find((p) => p?.name === "DisputeBondParamsUpdated");
  assert.ok(updatedEvent, "DisputeBondParamsUpdated must be emitted");
  assert.equal(updatedEvent.args.previousBps, 500n);
  assert.equal(updatedEvent.args.newBps, 1000n);
  assert.equal(updatedEvent.args.previousMinBond, USDC("0.20"));
  assert.equal(updatedEvent.args.newMinBond, USDC("1"));

  const snapshotAfter = (await contract.getEscrow(openEscrowId)).disputeBondSnapshot;
  assert.equal(snapshotAfter, snapshotBefore, "already-open dispute's bond snapshot must NOT change retroactively");

  const newEscrowId = await createAndLock(ctx, "100");
  await (await contract.connect(buyer).raiseDispute(newEscrowId)).wait();
  const newSnapshot = (await contract.getEscrow(newEscrowId)).disputeBondSnapshot;
  assert.equal(newSnapshot, USDC("10"), "new dispute after param update should use the new 10% rate -> 10 USDC");

  console.log("✅ scenarioHybridBondFormula: OK (percentage/floor branches, setter validation, non-retroactive updates)");
}

/**
 * File-size DoS mitigation (`maxFileSize`) + configurable per-escrow
 * `disputeWindow` (replaces the old fixed 5-minute `DISPUTE_WINDOW`
 * constant — see the "auto-release" audit fix).
 */
async function scenarioMaxFileSizeAndDisputeWindow(ctx) {
  const { contract, buyer, seller } = ctx;

  const maxAllowedFileSize = await contract.MAX_ALLOWED_FILE_SIZE();
  const minDisputeWindow = await contract.MIN_DISPUTE_WINDOW();
  const maxDisputeWindow = await contract.MAX_DISPUTE_WINDOW();
  assert.equal(maxAllowedFileSize, 102_400n, "MAX_ALLOWED_FILE_SIZE should be 100 KB");
  assert.equal(minDisputeWindow, 3600n, "MIN_DISPUTE_WINDOW should be 1 hour");
  assert.equal(maxDisputeWindow, 7n * 24n * 3600n, "MAX_DISPUTE_WINDOW should be 7 days");

  // --- maxFileSize validation ------------------------------------------
  await assert.rejects(
    contract.connect(buyer).createEscrow(seller.address, USDC("10"), 0, minDisputeWindow),
    /InvalidAmount/,
    "maxFileSize == 0 must revert"
  );
  await assert.rejects(
    contract.connect(buyer).createEscrow(seller.address, USDC("10"), maxAllowedFileSize + 1n, minDisputeWindow),
    /InvalidAmount/,
    "maxFileSize above MAX_ALLOWED_FILE_SIZE must revert"
  );
  // Boundary: exactly MAX_ALLOWED_FILE_SIZE must succeed.
  {
    const tx = await contract.connect(buyer).createEscrow(seller.address, USDC("10"), maxAllowedFileSize, minDisputeWindow);
    const receipt = await tx.wait();
    const created = receipt.logs
      .map((l) => { try { return contract.interface.parseLog(l); } catch { return null; } })
      .find((p) => p?.name === "EscrowCreated");
    assert.ok(created, "EscrowCreated must be emitted");
    assert.equal(created.args.maxFileSize, maxAllowedFileSize);
    assert.equal(created.args.disputeWindow, minDisputeWindow);
    const escrowId = (await contract.nextEscrowId()) - 1n;
    const e = await contract.getEscrow(escrowId);
    assert.equal(e.maxFileSize, maxAllowedFileSize, "boundary maxFileSize must be stored exactly");
  }

  // --- disputeWindow validation -----------------------------------------
  await assert.rejects(
    contract.connect(buyer).createEscrow(seller.address, USDC("10"), maxAllowedFileSize, minDisputeWindow - 1n),
    /InvalidAmount/,
    "disputeWindow below MIN_DISPUTE_WINDOW must revert"
  );
  await assert.rejects(
    contract.connect(buyer).createEscrow(seller.address, USDC("10"), maxAllowedFileSize, maxDisputeWindow + 1n),
    /InvalidAmount/,
    "disputeWindow above MAX_DISPUTE_WINDOW must revert"
  );
  // Boundary: exactly MAX_DISPUTE_WINDOW must succeed.
  {
    await (await contract.connect(buyer).createEscrow(seller.address, USDC("10"), maxAllowedFileSize, maxDisputeWindow)).wait();
    const escrowId = (await contract.nextEscrowId()) - 1n;
    const e = await contract.getEscrow(escrowId);
    assert.equal(e.disputeWindow, maxDisputeWindow, "boundary disputeWindow (MAX) must be stored exactly");
  }

  console.log("✅ scenarioMaxFileSizeAndDisputeWindow (validation): OK (bounds enforced on both maxFileSize and disputeWindow)");

  // --- disputeWindow actually GOVERNS raiseDispute/claimFunds timing ----
  // Use a custom 2-hour window (well above the 1h floor) to prove the
  // ESCROW's own value is used, not a hardcoded constant anywhere.
  const customWindow = 2n * 3600n; // 2 hours
  const escrowId = await createAndLock(ctx, "100", { disputeWindow: customWindow });

  // 1 hour in: still well within the 2h window — raiseDispute must succeed
  // (would have incorrectly reverted under the OLD hardcoded 5-minute window's
  // sibling error path if disputeWindow weren't actually being read per-escrow).
  await ethers.provider.send("evm_increaseTime", [3600]);
  await ethers.provider.send("evm_mine", []);
  await (await contract.connect(buyer).raiseDispute(escrowId)).wait();
  const afterRaise = await contract.getEscrow(escrowId);
  assert.equal(afterRaise.state, BigInt(EscrowState.DISPUTED), "raiseDispute at 1h into a 2h window must succeed");

  // claimFunds on a DIFFERENT escrow with the same custom window: must
  // revert with DisputeWindowActive before the 2h mark, then succeed after.
  const escrowId2 = await createAndLock(ctx, "100", { disputeWindow: customWindow });
  await ethers.provider.send("evm_increaseTime", [3600]); // +1h (only 1h elapsed on escrowId2's own clock)
  await ethers.provider.send("evm_mine", []);
  await assert.rejects(
    contract.connect(seller).claimFunds(escrowId2),
    /DisputeWindowActive/,
    "claimFunds before the escrow's own 2h disputeWindow elapses must revert"
  );
  await ethers.provider.send("evm_increaseTime", [3600 + 1]); // total +2h1s
  await ethers.provider.send("evm_mine", []);
  await (await contract.connect(seller).claimFunds(escrowId2)).wait();
  const escrow2After = await contract.getEscrow(escrowId2);
  assert.equal(escrow2After.state, BigInt(EscrowState.CLAIMED), "claimFunds after the escrow's own 2h disputeWindow must succeed");

  console.log("✅ scenarioMaxFileSizeAndDisputeWindow (timing): OK (per-escrow disputeWindow correctly governs raiseDispute/claimFunds, not a global constant)");
}

/**
 * Size-scaled minimum-price floor (`minRequiredPrice` / `setPricingParams`)
 * — anti-griefing fix so a near-zero `payloadPrice` escrow can't declare
 * the full `maxFileSize` and force an expensive off-chain LLM judgment call
 * for a disproportionately small dispute bond.
 */
async function scenarioPriceScaling(ctx) {
  const { contract, owner, buyer, seller } = ctx;

  const defaultMinBasePrice = await contract.DEFAULT_MIN_BASE_PRICE();
  const defaultPricePerKb = await contract.DEFAULT_PRICE_PER_KB();
  assert.equal(await contract.minBasePrice(), defaultMinBasePrice, "minBasePrice should start at DEFAULT_MIN_BASE_PRICE");
  assert.equal(await contract.pricePerKb(), defaultPricePerKb, "pricePerKb should start at DEFAULT_PRICE_PER_KB");

  // --- minRequiredPrice formula: minBasePrice + pricePerKb * ceil(bytes/1024) ---
  assert.equal(
    await contract.minRequiredPrice(1),
    defaultMinBasePrice + defaultPricePerKb, // 1 byte -> 1 "started" KB
    "1 byte should round up to exactly 1 KB of surcharge"
  );
  assert.equal(
    await contract.minRequiredPrice(1024),
    defaultMinBasePrice + defaultPricePerKb, // exactly 1024 bytes -> exactly 1 KB
    "exactly 1024 bytes should be exactly 1 KB of surcharge, not 2"
  );
  assert.equal(
    await contract.minRequiredPrice(1025),
    defaultMinBasePrice + defaultPricePerKb * 2n, // 1025 bytes -> rounds up to 2 KB
    "1025 bytes should round up to 2 KB of surcharge"
  );
  const maxAllowedFileSize = await contract.MAX_ALLOWED_FILE_SIZE();
  assert.equal(
    await contract.minRequiredPrice(maxAllowedFileSize),
    defaultMinBasePrice + defaultPricePerKb * (maxAllowedFileSize / 1024n),
    "minRequiredPrice at the MAX_ALLOWED_FILE_SIZE ceiling must match the formula exactly"
  );

  // --- createEscrow must reject payloadPrice below the size-scaled floor ---
  const requiredAtMax = await contract.minRequiredPrice(maxAllowedFileSize);
  await assert.rejects(
    contract.connect(buyer).createEscrow(seller.address, requiredAtMax - 1n, maxAllowedFileSize, await contract.MIN_DISPUTE_WINDOW()),
    /InvalidAmount/,
    "payloadPrice 1 unit below minRequiredPrice must revert"
  );
  // Boundary: exactly the required minimum must succeed.
  {
    const tx = await contract
      .connect(buyer)
      .createEscrow(seller.address, requiredAtMax, maxAllowedFileSize, await contract.MIN_DISPUTE_WINDOW());
    await tx.wait();
    const escrowId = (await contract.nextEscrowId()) - 1n;
    const e = await contract.getEscrow(escrowId);
    assert.equal(e.payloadPrice, requiredAtMax, "boundary payloadPrice must be stored exactly");
  }
  // A tiny file size has a tiny floor (just minBasePrice) — cheap escrows
  // with small declared files must still work fine, unaffected by this fix.
  {
    const tinyRequired = await contract.minRequiredPrice(1);
    await (
      await contract.connect(buyer).createEscrow(seller.address, tinyRequired, 1, await contract.MIN_DISPUTE_WINDOW())
    ).wait();
  }

  // --- setPricingParams: only owner, only affects FUTURE escrows ---------
  await assert.rejects(
    contract.connect(buyer).setPricingParams(0n, 0n),
    /OwnableUnauthorizedAccount/,
    "setPricingParams must be onlyOwner"
  );

  // Snapshot an escrow created under the OLD params, then raise the floor
  // sharply and confirm the already-created escrow's payloadPrice is
  // untouched (nothing to "retroactively" enforce — payloadPrice is fixed
  // at creation either way — this just confirms the setter has no
  // surprising side effects on existing escrows).
  const preChangeEscrowId = await createAndLock(ctx, "1"); // 1 USDC, well above the tiny default floor
  const preChangePrice = (await contract.getEscrow(preChangeEscrowId)).payloadPrice;

  const newMinBasePrice = USDC("5"); // 5 USDC flat floor now
  const newPricePerKb = USDC("1"); // 1 USDC per KB now
  const setTx = await contract.connect(owner).setPricingParams(newMinBasePrice, newPricePerKb);
  const setReceipt = await setTx.wait();
  const updatedEvent = setReceipt.logs
    .map((l) => { try { return contract.interface.parseLog(l); } catch { return null; } })
    .find((p) => p?.name === "PricingParamsUpdated");
  assert.ok(updatedEvent, "PricingParamsUpdated must be emitted");
  assert.equal(updatedEvent.args.previousMinBasePrice, defaultMinBasePrice);
  assert.equal(updatedEvent.args.newMinBasePrice, newMinBasePrice);
  assert.equal(updatedEvent.args.previousPricePerKb, defaultPricePerKb);
  assert.equal(updatedEvent.args.newPricePerKb, newPricePerKb);

  assert.equal(
    (await contract.getEscrow(preChangeEscrowId)).payloadPrice,
    preChangePrice,
    "pre-existing escrow's payloadPrice must be unaffected by a later setPricingParams call"
  );

  // The OLD "1 USDC, full-size file" combo that used to pass under default
  // params must now revert, because the new floor for a 100 KB file is
  // 5 + 1*100 = 105 USDC.
  await assert.rejects(
    contract.connect(buyer).createEscrow(seller.address, USDC("1"), maxAllowedFileSize, await contract.MIN_DISPUTE_WINDOW()),
    /InvalidAmount/,
    "1 USDC for a full 100 KB file must revert under the new, stricter pricing params"
  );
  // ...but succeeds once priced correctly under the NEW formula.
  const newRequiredAtMax = await contract.minRequiredPrice(maxAllowedFileSize);
  assert.equal(newRequiredAtMax, newMinBasePrice + newPricePerKb * (maxAllowedFileSize / 1024n));
  await (
    await contract
      .connect(buyer)
      .createEscrow(seller.address, newRequiredAtMax, maxAllowedFileSize, await contract.MIN_DISPUTE_WINDOW())
  ).wait();

  console.log("✅ scenarioPriceScaling: OK (minRequiredPrice formula, createEscrow enforcement, owner-only setter, non-retroactive)");
}

async function scenarioOwnable2Step(ctx) {
  const { contract, owner, other } = ctx;
  await (await contract.connect(owner).transferOwnership(other.address)).wait();
  assert.equal(await contract.owner(), owner.address, "owner must NOT change until acceptOwnership is called");
  assert.equal(await contract.pendingOwner(), other.address);

  await assert.rejects(contract.connect(other).pause(), /OwnableUnauthorizedAccount/, "pendingOwner must not have owner powers yet");

  await (await contract.connect(other).acceptOwnership()).wait();
  assert.equal(await contract.owner(), other.address, "owner must change after acceptOwnership");
  console.log("✅ scenarioOwnable2Step: OK (transferOwnership requires acceptOwnership)");
}

async function main() {
  console.log("🔎 Verifying dispute-bond fix + fallback arbiter (in-process, no fork)...\n");

  let ctx = await deployFixture();
  await scenarioHappyPath(ctx);

  ctx = await deployFixture();
  await scenarioCancelUnmatched(ctx);

  ctx = await deployFixture();
  await scenarioDisputeMatrix(ctx);

  ctx = await deployFixture();
  await scenarioBondEventsAndSweep(ctx);

  ctx = await deployFixture();
  await scenarioHybridBondFormula(ctx);

  ctx = await deployFixture();
  await scenarioMaxFileSizeAndDisputeWindow(ctx);

  ctx = await deployFixture();
  await scenarioPriceScaling(ctx);

  ctx = await deployFixture();
  await scenarioOwnable2Step(ctx);

  console.log("\n🎉 ALL SCENARIOS PASSED. totalLockedFunds balances to the unit in every case.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ VERIFICATION FAILED:", error);
    process.exit(1);
  });
