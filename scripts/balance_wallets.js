/**
 * Equalize Base Sepolia test USDC between buyer and seller.
 *
 * Usage:
 *   npx hardhat run scripts/balance_wallets.js --network baseSepolia
 */
const { ethers } = require("hardhat");
const { getUsdcAddress } = require("./deployment");

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
];

function pk(name) {
  const raw = process.env[name];
  if (!raw) throw new Error(`Missing ${name}`);
  return raw.startsWith("0x") ? raw : `0x${raw}`;
}

async function main() {
  const usdc = new ethers.Contract(getUsdcAddress(), ERC20_ABI, ethers.provider);
  const buyer = new ethers.Wallet(pk("SEPOLIA_BUYER_PRIVATE_KEY"), ethers.provider);
  const seller = new ethers.Wallet(pk("SEPOLIA_SELLER_PRIVATE_KEY"), ethers.provider);

  const buyerBal = await usdc.balanceOf(buyer.address);
  const sellerBal = await usdc.balanceOf(seller.address);
  const total = buyerBal + sellerBal;
  const target = total / 2n; // floor — 1 micro-USDC may remain with the richer side

  console.log("BUYER  ", buyer.address, ethers.formatUnits(buyerBal, 6), "USDC");
  console.log("SELLER ", seller.address, ethers.formatUnits(sellerBal, 6), "USDC");
  console.log("TOTAL  ", ethers.formatUnits(total, 6), "USDC → target each ~", ethers.formatUnits(target, 6));

  if (buyerBal === sellerBal || (buyerBal > sellerBal ? buyerBal - sellerBal : sellerBal - buyerBal) <= 1n) {
    console.log("Already balanced.");
    return;
  }

  let from;
  let to;
  let amount;
  if (sellerBal > buyerBal) {
    from = seller;
    to = buyer;
    amount = sellerBal - target;
  } else {
    from = buyer;
    to = seller;
    amount = buyerBal - target;
  }

  console.log(
    `Transferring ${ethers.formatUnits(amount, 6)} USDC ${from.address === seller.address ? "seller→buyer" : "buyer→seller"}...`
  );
  const tx = await usdc.connect(from).transfer(to.address, amount);
  const receipt = await tx.wait();
  console.log(`tx: https://sepolia.basescan.org/tx/${receipt.hash}`);

  // RPC lag — wait then re-read
  await new Promise((r) => setTimeout(r, 4000));
  const afterBuyer = await usdc.balanceOf(buyer.address);
  const afterSeller = await usdc.balanceOf(seller.address);
  console.log("BUYER  now:", ethers.formatUnits(afterBuyer, 6), "USDC");
  console.log("SELLER now:", ethers.formatUnits(afterSeller, 6), "USDC");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
