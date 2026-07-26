const { ethers } = require("hardhat");
const { getContractAddress, getUsdcAddress } = require("./scripts/deployment");

async function main() {
    console.log("🚀 Rozpoczynam pełną symulację (zastrzyk dla deployera i sprzedawcy)...");

    const [deployer, seller] = await ethers.getSigners();
    const contractAddress = getContractAddress();
    const usdcAddress = getUsdcAddress();

    console.log(`📍 Kontrakt BlackSwanOS: ${contractAddress}`);
    console.log(`📍 USDC:                 ${usdcAddress}`);

    const usdc = await ethers.getContractAt([
        "function balanceOf(address account) external view returns (uint256)",
        "function approve(address spender, uint256 value) external returns (bool)"
    ], usdcAddress);

    const blackSwan = await ethers.getContractAt("BlackSwanOS", contractAddress);
    const amount = 50_000000n; // 50 USDC

    // Funkcja pomocnicza do wstrzykiwania USDC przez storage slot 9
    // (tak jak robiliśmy to dla natywnego USDC na Base).
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

    console.log("🪙 Wpłacam USDC dla deployera...");
    await fundAccount(deployer.address);
    console.log("🪙 Wpłacam USDC dla sprzedawcy (seller)...");
    await fundAccount(seller.address);

    const deployerBalance = await usdc.balanceOf(deployer.address);
    const sellerBalance = await usdc.balanceOf(seller.address);
    console.log(`   ↳ saldo deployera: ${deployerBalance.toString()} (6 dec.)`);
    console.log(`   ↳ saldo sprzedawcy: ${sellerBalance.toString()} (6 dec.)`);
    if (deployerBalance === 0n || sellerBalance === 0n) {
        throw new Error(
            "Zastrzyk USDC przez storage slot nie zadziałał (saldo = 0). " +
                "Sprawdź, czy sieć jest forkowana z Base i czy slot=9 wciąż " +
                "odpowiada mapie balances w kontrakcie USDC."
        );
    }

    console.log("💰 Deployer zatwierdza nieskończone USDC...");
    const approveTx1 = await usdc.connect(deployer).approve(contractAddress, ethers.MaxUint256);
    await approveTx1.wait();

    console.log("💰 Sprzedawca zatwierdza nieskończone USDC...");
    const approveTx2 = await usdc.connect(seller).approve(contractAddress, ethers.MaxUint256);
    await approveTx2.wait();

    console.log("📦 Tworzę nowy depozyt (escrow)...");
    const maxFileSize = await blackSwan.MAX_ALLOWED_FILE_SIZE(); // 100 KB — limit systemowy
    const disputeWindow = await blackSwan.MIN_DISPUTE_WINDOW(); // 1h — najkrótsze dozwolone okno
    const createTx = await blackSwan.connect(deployer).createEscrow(seller.address, amount, maxFileSize, disputeWindow);
    await createTx.wait();

    const nextId = await blackSwan.nextEscrowId();
    const escrowId = nextId - 1n;
    console.log(`✅ Depozyt utworzony! ID: ${escrowId.toString()}`);

    console.log("🔒 Sprzedawca (seller) blokuje depozyt (sellerLock)...");
    const dummyPayloadHash = ethers.id("przykładowy_payload_danych");
    const lockTx = await blackSwan.connect(seller).sellerLock(escrowId, dummyPayloadHash);
    await lockTx.wait();
    console.log("✅ Depozyt zablokowany przez sprzedawcę!");

    console.log("⚡ Podnoszę spór (raiseDispute) dla tego depozytu...");
    const disputeTx = await blackSwan.connect(deployer).raiseDispute(escrowId);
    await disputeTx.wait();

    const finalState = await blackSwan.getEscrow(escrowId);
    console.log("🔥 Sukces! Spór został zarejestrowany na blockchainie.");
    console.log(`   ↳ escrowId=${escrowId.toString()} state=${finalState.state.toString()} (2 = DISPUTED)`);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("❌ Błąd podczas symulacji:", error);
        process.exit(1);
    });
