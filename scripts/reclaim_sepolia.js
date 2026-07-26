/**
 * scripts/reclaim_sepolia.js
 *
 * Sweep leftover test funds on Base Sepolia:
 *   - claimFunds for LOCKED past disputeWindow
 *   - claimResolved for RESOLVED
 *   - optional: owner sweepFees(USDC) for free/forfeited balance
 *
 * Usage:
 *   npm run reclaim:sepolia
 *   SWEEP_FREE=1 npm run reclaim:sepolia   # also sweep free USDC to owner
 */

const { ethers, network } = require("hardhat");
const { getContractAddress, getUsdcAddress } = require("./deployment");

const STATES = ["AWAITING_SELLER", "LOCKED", "DISPUTED", "RESOLVED", "CLAIMED"];

function explorerTxUrl(chainId, txHash) {
  const base = chainId === 84532 ? "https://sepolia.basescan.org" : "https://basescan.org";
  return `${base}/tx/${txHash}`;
}

function requirePrivateKey(key) {
  const raw = process.env[key];
  if (!raw) throw new Error(`Missing ${key}`);
  const n = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(n)) throw new Error(`${key} invalid`);
  return n;
}

async function main() {
  const contractAddress = getContractAddress();
  const usdcAddress = getUsdcAddress();
  const provider = ethers.provider;
  const chainId = Number((await provider.getNetwork()).chainId);
  const now = Math.floor(Date.now() / 1000);

  const buyer = new ethers.Wallet(requirePrivateKey("SEPOLIA_BUYER_PRIVATE_KEY"), provider);
  const contract = await ethers.getContractAt("BlackSwanOS", contractAddress);
  const usdc = await ethers.getContractAt(
    ["function balanceOf(address) view returns (uint256)"],
    usdcAddress
  );

  const next = Number(await contract.nextEscrowId());
  const locked = await contract.totalLockedFunds();
  const bal = await usdc.balanceOf(contractAddress);
  const free = bal - locked;

  console.log(`🧲 Reclaim on ${network.name}`);
  console.log(`   contract USDC=${ethers.formatUnits(bal, 6)} locked=${ethers.formatUnits(locked, 6)} free=${ethers.formatUnits(free, 6)}`);
  console.log(`   scanning escrow 0..${next - 1}`);

  const jobs = [];
  for (let id = 0; id < next; id++) {
    let e;
    try {
      e = await contract.getEscrow(id);
    } catch {
      continue;
    }
    const st = Number(e.state);
    if (st === 1) {
      const openAt = Number(e.lockTime) + Number(e.disputeWindow);
      if (now >= openAt) jobs.push({ id, action: "claimFunds", e });
    } else if (st === 3) {
      jobs.push({ id, action: "claimResolved", e });
    }
  }

  console.log(`   claimable: ${jobs.length}`);
  if (!jobs.length) {
    console.log("Nothing to claim.");
  }

  const buyerUsdcBefore = await usdc.balanceOf(buyer.address);
  let ok = 0;
  let fail = 0;

  for (const job of jobs) {
    const st = STATES[Number(job.e.state)];
    const price = ethers.formatUnits(job.e.payloadPrice, 6);
    process.stdout.write(`   #${job.id} ${st} ${job.action} (price=${price}) ... `);
    try {
      const tx =
        job.action === "claimFunds"
          ? await contract.connect(buyer).claimFunds(job.id)
          : await contract.connect(buyer).claimResolved(job.id);
      const rc = await tx.wait();
      if (rc.status !== 1) throw new Error(`status=${rc.status}`);
      console.log(`OK ${explorerTxUrl(chainId, rc.hash)}`);
      ok += 1;
    } catch (err) {
      console.log(`FAIL ${err.shortMessage || err.message}`);
      fail += 1;
    }
  }

  const buyerUsdcAfter = await usdc.balanceOf(buyer.address);
  console.log(
    `\n💵 Buyer USDC: ${ethers.formatUnits(buyerUsdcBefore, 6)} → ${ethers.formatUnits(buyerUsdcAfter, 6)} (Δ ${ethers.formatUnits(buyerUsdcAfter - buyerUsdcBefore, 6)})`
  );
  console.log(`   claims OK=${ok} FAIL=${fail}`);

  if (process.env.SWEEP_FREE === "1") {
    const [ownerSigner] = await ethers.getSigners();
    const ownerAddr = await contract.owner();
    if (ownerSigner.address.toLowerCase() !== ownerAddr.toLowerCase()) {
      throw new Error("SWEEP_FREE=1 but signer is not owner");
    }
    const locked2 = await contract.totalLockedFunds();
    const bal2 = await usdc.balanceOf(contractAddress);
    const free2 = bal2 - locked2;
    console.log(`\n🧹 sweepFees free=${ethers.formatUnits(free2, 6)} USDC → owner ${ownerAddr}`);
    if (free2 > 0n) {
      const tx = await contract.connect(ownerSigner).sweepFees(usdcAddress, ownerAddr, free2);
      const rc = await tx.wait();
      console.log(`   ✅ ${explorerTxUrl(chainId, rc.hash)}`);
    } else {
      console.log("   nothing free to sweep");
    }
  } else {
    const locked2 = await contract.totalLockedFunds();
    const bal2 = await usdc.balanceOf(contractAddress);
    const free2 = bal2 - locked2;
    if (free2 > 0n) {
      console.log(
        `\nℹ️  Still ~${ethers.formatUnits(free2, 6)} USDC free on contract (forfeited bonds/fees). Sweep with:\n   $env:SWEEP_FREE=\"1\"; npm run reclaim:sepolia`
      );
    }
  }
}

main().catch((e) => {
  console.error(e.shortMessage || e.message || e);
  process.exit(1);
});
