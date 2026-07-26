const { ethers } = require("hardhat");
const { getContractAddress, getUsdcAddress } = require("./scripts/deployment");

async function main() {
    console.log("🚀 Starting full simulation (USDC injection for deployer and seller)...");

    const [deployer, seller] = await ethers.getSigners();
    const contractAddress = getContractAddress();
    const usdcAddress = getUsdcAddress();

    console.log(`📍 BlackSwanOS contract: ${contractAddress}`);
    console.log(`📍 USDC:                 ${usdcAddress}`);

    const usdc = await ethers.getContractAt([
        "function balanceOf(address account) external view returns (uint256)",
        "function approve(address spender, uint256 value) external returns (bool)"
    ], usdcAddress);

    const blackSwan = await ethers.getContractAt("BlackSwanOS", contractAddress);
    const amount = 50_000000n; // 50 USDC

    // Helper to inject USDC via storage slot 9
    // (same approach as for native USDC on Base).
    async function fundAccount(accountAddress) {
        const slot = 9;
        const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
            ["address", "uint256"],
            [accountAddress, slot]
        );
        const storageKey = ethers.keccak256(encoded);
        const fakeBalance = ethers.zeroPadValue(ethers.toBeHex(10000_000000n), 32);
        await hre.network.provider.send("hardhat_setStorageAt", [
            usdcAddress,
            storageKey,
            fakeBalance,
        ]);
    }

    console.log("🪙 Funding USDC for deployer...");
    await fundAccount(deployer.address);
    console.log("🪙 Funding USDC for seller...");
    await fundAccount(seller.address);

    const deployerBalance = await usdc.balanceOf(deployer.address);
    const sellerBalance = await usdc.balanceOf(seller.address);
    console.log(`   ↳ deployer balance: ${deployerBalance.toString()} (6 decimals)`);
    console.log(`   ↳ seller balance:   ${sellerBalance.toString()} (6 decimals)`);
    if (deployerBalance === 0n || sellerBalance === 0n) {
        throw new Error(
            "USDC injection via storage slot failed (balance = 0). " +
                "Check that the network is forked from Base and that slot=9 still " +
                "maps to the USDC contract balances mapping."
        );
    }

    console.log("💰 Deployer approves unlimited USDC...");
    const approveTx1 = await usdc.connect(deployer).approve(contractAddress, ethers.MaxUint256);
    await approveTx1.wait();

    console.log("💰 Seller approves unlimited USDC...");
    const approveTx2 = await usdc.connect(seller).approve(contractAddress, ethers.MaxUint256);
    await approveTx2.wait();

    console.log("📦 Creating new escrow...");
    const maxFileSize = await blackSwan.MAX_ALLOWED_FILE_SIZE(); // 100 KB — system limit
    const disputeWindow = await blackSwan.MIN_DISPUTE_WINDOW(); // 1h — shortest allowed window
    const createTx = await blackSwan.connect(deployer).createEscrow(seller.address, amount, maxFileSize, disputeWindow);
    await createTx.wait();

    const nextId = await blackSwan.nextEscrowId();
    const escrowId = nextId - 1n;
    console.log(`✅ Escrow created! ID: ${escrowId.toString()}`);

    console.log("🔒 Seller locks escrow (sellerLock)...");
    const dummyPayloadHash = ethers.id("sample_payload_data");
    const lockTx = await blackSwan.connect(seller).sellerLock(escrowId, dummyPayloadHash);
    await lockTx.wait();
    console.log("✅ Escrow locked by seller!");

    console.log("⚡ Raising dispute (raiseDispute) for this escrow...");
    const disputeTx = await blackSwan.connect(deployer).raiseDispute(escrowId);
    await disputeTx.wait();

    const finalState = await blackSwan.getEscrow(escrowId);
    console.log("🔥 Success! Dispute registered on-chain.");
    console.log(`   ↳ escrowId=${escrowId.toString()} state=${finalState.state.toString()} (2 = DISPUTED)`);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("❌ Simulation error:", error);
        process.exit(1);
    });
