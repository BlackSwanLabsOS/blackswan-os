/**
 * scripts/update_economics_sepolia.js
 *
 * Update BlackSwanOS economic params on Base Sepolia WITHOUT redeploy.
 * Must be signed by the contract owner (deployer / PRIVATE_KEY).
 *
 * Maps the intended Alpha economics onto the REAL ABI (Gemini mixed up
 * function signatures — corrected here):
 *
 *   setFees(systemFeeBps, arbitrationFee)
 *   setDisputeBondParams(disputeBondBps, minDisputeBond)
 *   setPricingParams(minBasePrice, pricePerKb)
 *
 * NOTE: maxFileSize ceiling (102400) is an immutable constant
 *       MAX_ALLOWED_FILE_SIZE — cannot be changed without redeploy.
 *       price is per KiB (ceil(bytes/1024)), not per byte.
 *
 * Usage:
 *   npm run economics:sepolia
 *   npx hardhat run scripts/update_economics_sepolia.js --network baseSepolia
 */

const { ethers, network } = require("hardhat");
const { getContractAddress } = require("./deployment");

function explorerTxUrl(chainId, txHash) {
  const base = chainId === 84532 ? "https://sepolia.basescan.org" : "https://basescan.org";
  return `${base}/tx/${txHash}`;
}

async function main() {
  if (network.name !== "baseSepolia") {
    console.warn(`⚠️  Expected baseSepolia, got ${network.name}`);
  }

  const contractAddress = getContractAddress();
  const [signer] = await ethers.getSigners();
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const contract = await ethers.getContractAt("BlackSwanOS", contractAddress);

  const owner = await contract.owner();
  console.log("🔧 BlackSwanOS — update economics (no redeploy)");
  console.log(`   network:  ${network.name} (chainId=${chainId})`);
  console.log(`   contract: ${contractAddress}`);
  console.log(`   owner:    ${owner}`);
  console.log(`   signer:   ${signer.address}`);

  if (signer.address.toLowerCase() !== owner.toLowerCase()) {
    throw new Error(
      `Signer is NOT the contract owner. Use PRIVATE_KEY of ${owner} in .env / hardhat accounts.`
    );
  }

  // --- Target params (USDC 6 decimals) ------------------------------------
  const systemFeeBps = 50n; // 0.5%
  const disputeBondBps = 500n; // 5%
  const minDisputeBond = ethers.parseUnits("0.2", 6); // 200_000
  const arbitrationFee = ethers.parseUnits("0.05", 6); // 50_000
  const minBasePrice = ethers.parseUnits("0.1", 6); // 100_000
  // 0.005 USDC per started KiB (1024 bytes) — NOT per byte
  const pricePerKb = ethers.parseUnits("0.005", 6); // 5_000

  console.log("\n📋 Target:");
  console.log(`   setFees(${systemFeeBps}, arbitrationFee=${ethers.formatUnits(arbitrationFee, 6)} USDC)`);
  console.log(
    `   setDisputeBondParams(${disputeBondBps} bps, min=${ethers.formatUnits(minDisputeBond, 6)} USDC)`
  );
  console.log(
    `   setPricingParams(minBase=${ethers.formatUnits(minBasePrice, 6)} USDC, pricePerKb=${ethers.formatUnits(pricePerKb, 6)} USDC)`
  );
  console.log("   MAX_ALLOWED_FILE_SIZE = 102400 (constant — no on-chain setter)");

  // --- Balances -----------------------------------------------------------
  const ethBal = await ethers.provider.getBalance(signer.address);
  console.log(`\n💰 Owner ETH: ${ethers.formatEther(ethBal)} ETH`);
  if (ethBal < ethers.parseEther("0.0005")) {
    throw new Error("Owner ETH too low for gas — top up deployer on Base Sepolia");
  }

  // --- Read before --------------------------------------------------------
  const before = {
    systemFeeBps: await contract.systemFeeBps(),
    arbitrationFee: await contract.arbitrationFee(),
    disputeBondBps: await contract.disputeBondBps(),
    minDisputeBond: await contract.minDisputeBond(),
    minBasePrice: await contract.minBasePrice(),
    pricePerKb: await contract.pricePerKb(),
    maxFile: await contract.MAX_ALLOWED_FILE_SIZE(),
  };
  console.log("\n📖 Before:");
  console.log(`   systemFeeBps=${before.systemFeeBps} arbitrationFee=${ethers.formatUnits(before.arbitrationFee, 6)}`);
  console.log(
    `   disputeBondBps=${before.disputeBondBps} minDisputeBond=${ethers.formatUnits(before.minDisputeBond, 6)}`
  );
  console.log(
    `   minBasePrice=${ethers.formatUnits(before.minBasePrice, 6)} pricePerKb=${ethers.formatUnits(before.pricePerKb, 6)}`
  );
  console.log(`   MAX_ALLOWED_FILE_SIZE=${before.maxFile}`);

  const previewFloor = (bytes) => {
    const kb = BigInt(Math.ceil(bytes / 1024));
    return minBasePrice + pricePerKb * kb;
  };
  console.log("\n🧮 New min price floors (formula):");
  console.log(`   10 KB  → ${ethers.formatUnits(previewFloor(10 * 1024), 6)} USDC`);
  console.log(`   50 KB  → ${ethers.formatUnits(previewFloor(50 * 1024), 6)} USDC`);
  console.log(`   100 KB → ${ethers.formatUnits(previewFloor(100 * 1024), 6)} USDC`);

  // --- TX 1: setFees ------------------------------------------------------
  console.log("\n1️⃣  setFees...");
  const tx1 = await contract.connect(signer).setFees(systemFeeBps, arbitrationFee);
  const rc1 = await tx1.wait();
  console.log(`   ✅ ${explorerTxUrl(chainId, rc1.hash)}`);

  // --- TX 2: setDisputeBondParams -----------------------------------------
  console.log("\n2️⃣  setDisputeBondParams...");
  const tx2 = await contract.connect(signer).setDisputeBondParams(disputeBondBps, minDisputeBond);
  const rc2 = await tx2.wait();
  console.log(`   ✅ ${explorerTxUrl(chainId, rc2.hash)}`);

  // --- TX 3: setPricingParams ---------------------------------------------
  console.log("\n3️⃣  setPricingParams...");
  const tx3 = await contract.connect(signer).setPricingParams(minBasePrice, pricePerKb);
  const rc3 = await tx3.wait();
  console.log(`   ✅ ${explorerTxUrl(chainId, rc3.hash)}`);

  // --- Verify on-chain (retry — public RPC can lag right after mine) ------
  async function readEconomics() {
    return {
      systemFeeBps: await contract.systemFeeBps(),
      arbitrationFee: await contract.arbitrationFee(),
      disputeBondBps: await contract.disputeBondBps(),
      minDisputeBond: await contract.minDisputeBond(),
      minBasePrice: await contract.minBasePrice(),
      pricePerKb: await contract.pricePerKb(),
    };
  }

  function matches(v) {
    return (
      v.systemFeeBps === systemFeeBps &&
      v.arbitrationFee === arbitrationFee &&
      v.disputeBondBps === disputeBondBps &&
      v.minDisputeBond === minDisputeBond &&
      v.minBasePrice === minBasePrice &&
      v.pricePerKb === pricePerKb
    );
  }

  let after = await readEconomics();
  for (let i = 1; i <= 8 && !matches(after); i += 1) {
    console.warn(`   ⚠️  stale read after txs (attempt ${i}/8) — retrying…`);
    await new Promise((r) => setTimeout(r, 3000));
    after = await readEconomics();
  }

  console.log("\n📖 After:");
  console.log(`   systemFeeBps=${after.systemFeeBps} arbitrationFee=${ethers.formatUnits(after.arbitrationFee, 6)}`);
  console.log(
    `   disputeBondBps=${after.disputeBondBps} minDisputeBond=${ethers.formatUnits(after.minDisputeBond, 6)}`
  );
  console.log(
    `   minBasePrice=${ethers.formatUnits(after.minBasePrice, 6)} pricePerKb=${ethers.formatUnits(after.pricePerKb, 6)}`
  );

  const floor100 = await contract.minRequiredPrice(102400);
  console.log(`   minRequiredPrice(100KB)=${ethers.formatUnits(floor100, 6)} USDC (expect 0.6)`);

  if (!matches(after)) {
    throw new Error("On-chain values do not match targets — inspect txs on BaseScan");
  }
  console.log("\n🎉 Economics updated successfully (future escrows / disputes only).");
}

main().catch((err) => {
  console.error("\n❌ update economics failed:", err.shortMessage || err.message || err);
  process.exit(1);
});
