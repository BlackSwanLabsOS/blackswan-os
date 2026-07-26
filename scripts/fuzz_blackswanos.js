/**
 * scripts/fuzz_blackswanos.js
 *
 * Lightweight property/fuzz harness (Hardhat).
 * Randomizes createEscrow inputs within / outside legal ranges and asserts
 * invariants: illegal calls revert; legal calls preserve totalLockedFunds
 * accounting; terminal states cannot be re-entered.
 *
 * Usage:
 *   npm run fuzz:contract
 *   FUZZ_ROUNDS=100 npx hardhat run scripts/fuzz_blackswanos.js --network hardhat
 */

const assert = require("node:assert/strict");
const { ethers } = require("hardhat");

const USDC = (n) => ethers.parseUnits(String(n), 6);
const EscrowState = { AWAITING_SELLER: 0, LOCKED: 1, DISPUTED: 2, RESOLVED: 3, CLAIMED: 4 };

function rnd(max) {
  return Math.floor(Math.random() * max);
}

async function main() {
  const rounds = Math.max(20, Number(process.env.FUZZ_ROUNDS || 80));
  const [owner, buyer, seller, oracle, other] = await ethers.getSigners();

  const usdc = await (await ethers.getContractFactory("MockUSDC")).deploy();
  await usdc.waitForDeployment();
  const contract = await (
    await ethers.getContractFactory("BlackSwanOS")
  ).deploy(await usdc.getAddress(), oracle.address, 50n, USDC("0.05"));
  await contract.waitForDeployment();
  await (await contract.connect(owner).setPricingParams(USDC("0.1"), USDC("0.005"))).wait();

  for (const a of [buyer, seller, other]) {
    await usdc.mint(a.address, USDC("1000000"));
    await usdc.connect(a).approve(await contract.getAddress(), ethers.MaxUint256);
  }

  const minWin = Number(await contract.MIN_DISPUTE_WINDOW());
  const maxWin = Number(await contract.MAX_DISPUTE_WINDOW());
  const maxFile = Number(await contract.MAX_ALLOWED_FILE_SIZE());

  let legal = 0;
  let illegal = 0;
  let invariantFails = 0;

  console.log(`🎲 Fuzz BlackSwanOS — ${rounds} rounds`);

  for (let i = 0; i < rounds; i++) {
    const mode = rnd(5);

    if (mode === 0) {
      // Illegal createEscrow params — must revert
      const badCases = [
        () => contract.connect(buyer).createEscrow(ethers.ZeroAddress, USDC("1"), 1024, minWin),
        () => contract.connect(buyer).createEscrow(buyer.address, USDC("1"), 1024, minWin),
        () => contract.connect(buyer).createEscrow(seller.address, 0, 1024, minWin),
        () => contract.connect(buyer).createEscrow(seller.address, USDC("1"), 0, minWin),
        () =>
          contract
            .connect(buyer)
            .createEscrow(seller.address, USDC("1"), maxFile + 1, minWin),
        () =>
          contract
            .connect(buyer)
            .createEscrow(seller.address, USDC("10"), 1024, minWin - 1),
        () =>
          contract
            .connect(buyer)
            .createEscrow(seller.address, USDC("10"), 1024, maxWin + 1),
        () =>
          contract
            .connect(buyer)
            .createEscrow(seller.address, USDC("0.01"), maxFile, minWin), // below floor
      ];
      const fn = badCases[rnd(badCases.length)];
      try {
        await fn();
        console.log(`  ❌ round ${i}: expected illegal create to revert`);
        invariantFails += 1;
      } catch {
        illegal += 1;
      }
      continue;
    }

    // Legal happy / dispute path with random legal size
    const kb = 1 + rnd(20); // 1..20 KB
    const maxFileSize = kb * 1024;
    const floor = await contract.minRequiredPrice(maxFileSize);
    const price = floor + USDC(String(rnd(5))); // floor .. floor+4
    const window = minWin + rnd(Math.min(3600, maxWin - minWin));

    const lockedBefore = await contract.totalLockedFunds();
    try {
      await (
        await contract.connect(buyer).createEscrow(seller.address, price, maxFileSize, window)
      ).wait();
    } catch (err) {
      console.log(`  ❌ round ${i}: legal create reverted: ${err.message}`);
      invariantFails += 1;
      continue;
    }
    const id = (await contract.nextEscrowId()) - 1n;
    const fee = (price * 50n) / 10_000n;
    const afterCreate = await contract.totalLockedFunds();
    if (afterCreate !== lockedBefore + price + fee) {
      console.log(`  ❌ round ${i}: totalLockedFunds after create mismatch`);
      invariantFails += 1;
      continue;
    }

    await (await contract.connect(seller).sellerLock(id, ethers.id(`fuzz-${i}`))).wait();
    const coll = (price * 20_000n) / 10_000n;
    const afterLock = await contract.totalLockedFunds();
    if (afterLock !== afterCreate + coll) {
      console.log(`  ❌ round ${i}: totalLockedFunds after lock mismatch`);
      invariantFails += 1;
      continue;
    }

    const branch = rnd(3);
    if (branch === 0) {
      // Happy path
      await ethers.provider.send("evm_increaseTime", [window + 1]);
      await ethers.provider.send("evm_mine", []);
      await (await contract.connect(other).claimFunds(id)).wait();
    } else if (branch === 1) {
      await (await contract.connect(buyer).raiseDispute(id)).wait();
      await (await contract.connect(oracle).resolveDispute(id, 1 + rnd(3))).wait(); // 1..3
      await (await contract.connect(other).claimResolved(id)).wait();
    } else {
      await (await contract.connect(seller).raiseDispute(id)).wait();
      await (await contract.connect(oracle).resolveDispute(id, 1 + rnd(3))).wait();
      await (await contract.connect(buyer).claimResolved(id)).wait();
    }

    const e = await contract.getEscrow(id);
    if (Number(e.state) !== EscrowState.CLAIMED) {
      console.log(`  ❌ round ${i}: expected CLAIMED`);
      invariantFails += 1;
      continue;
    }

    // Replay claim must fail
    try {
      await contract.connect(buyer).claimFunds(id);
      console.log(`  ❌ round ${i}: replay claimFunds should revert`);
      invariantFails += 1;
      continue;
    } catch {
      // ok
    }

    legal += 1;
  }

  // Global invariant: free balance accounting
  const bal = await usdc.balanceOf(await contract.getAddress());
  const locked = await contract.totalLockedFunds();
  assert.ok(bal >= locked, "USDC balance >= totalLockedFunds");

  console.log(`\n   legal paths OK:   ${legal}`);
  console.log(`   illegal reverts:  ${illegal}`);
  console.log(`   invariant fails:  ${invariantFails}`);
  console.log(`   contract USDC=${ethers.formatUnits(bal, 6)} locked=${ethers.formatUnits(locked, 6)}`);

  if (invariantFails > 0) process.exit(1);
  console.log("\n✅ Fuzz harness passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
