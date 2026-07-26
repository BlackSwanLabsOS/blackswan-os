/**
 * Transfer test USDC from buyer → seller on Base Sepolia.
 *
 * Usage:
 *   AMOUNT_USDC=8 npx hardhat run scripts/topup_seller.js --network baseSepolia
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
  const amountStr = process.env.AMOUNT_USDC || "8";
  const amount = ethers.parseUnits(amountStr, 6);
  const usdc = new ethers.Contract(getUsdcAddress(), ERC20_ABI, ethers.provider);

  const buyer = new ethers.Wallet(pk("SEPOLIA_BUYER_PRIVATE_KEY"), ethers.provider);
  const seller = new ethers.Wallet(pk("SEPOLIA_SELLER_PRIVATE_KEY"), ethers.provider);

  const beforeBuyer = await usdc.balanceOf(buyer.address);
  const beforeSeller = await usdc.balanceOf(seller.address);
  console.log(`Buyer  ${buyer.address}: ${ethers.formatUnits(beforeBuyer, 6)} USDC`);
  console.log(`Seller ${seller.address}: ${ethers.formatUnits(beforeSeller, 6)} USDC`);
  console.log(`Transferring ${amountStr} USDC buyer → seller...`);

  if (beforeBuyer < amount) {
    throw new Error(
      `Buyer only has ${ethers.formatUnits(beforeBuyer, 6)} USDC, need ${amountStr}. ` +
        `Faucet: https://faucet.circle.com/ (Base Sepolia USDC) → ${buyer.address}`
    );
  }

  const tx = await usdc.connect(buyer).transfer(seller.address, amount);
  const receipt = await tx.wait();
  console.log(`tx: https://sepolia.basescan.org/tx/${receipt.hash}`);

  const afterBuyer = await usdc.balanceOf(buyer.address);
  const afterSeller = await usdc.balanceOf(seller.address);
  console.log(`Buyer  now: ${ethers.formatUnits(afterBuyer, 6)} USDC`);
  console.log(`Seller now: ${ethers.formatUnits(afterSeller, 6)} USDC`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
