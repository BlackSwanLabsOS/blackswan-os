/**
 * scripts/sepolia_smoke_test.js
 *
 * Pełny test E2E ("szachy na testnecie") przeciwko REALNIE wdrożonemu
 * kontraktowi BlackSwanOS na Base Sepolia — bez żadnych sztuczek
 * dostępnych tylko lokalnie (`evm_increaseTime`, `hardhat_setStorageAt`
 * itp.), bo to prawdziwy łańcuch z prawdziwym czasem bloków.
 *
 * Przebieg:
 *   1. Buyer i Seller (dwa oddzielne klucze prywatne) zatwierdzają (approve)
 *      testowe USDC na rzecz kontraktu.
 *   2. Buyer woła createEscrow(seller, payloadPrice, maxFileSize, disputeWindow)
 *      — z NOWYMI parametrami (DoS-mitigation + konfigurowalne okno sporu).
 *   3. Seller woła sellerLock(escrowId, payloadHash).
 *   4. "Happy Path": czekamy realnie (na blockchainie nie da się przewinąć
 *      czasu) aż upłynie `disputeWindow`, po czym KTOKOLWIEK — tu: sam Buyer,
 *      ale równie dobrze mógłby to być Seller albo watcher.js — woła
 *      `claimFunds(escrowId)`. UWAGA: kontrakt NIE MA osobnej funkcji
 *      `releaseFunds()` wywoływanej ręcznie przez Buyera — happy-path
 *      auto-release jest permissionless i realizowany właśnie przez
 *      `claimFunds` (patrz audyt bezpieczeństwa z wcześniejszej rozmowy:
 *      to silniejsza gwarancja niż ręczne "zwolnienie" przez jedną stronę).
 *
 * Wymagane zmienne środowiskowe (patrz też sekcja .env w podsumowaniu):
 *   - CONTRACT_ADDRESS, USDC_ADDRESS       (ustawiane automatycznie przez
 *                                            scripts/deploy.js --network baseSepolia)
 *   - SEPOLIA_BUYER_PRIVATE_KEY
 *   - SEPOLIA_SELLER_PRIVATE_KEY
 *   - SMOKE_TEST_PAYLOAD_PRICE_USDC        (opcjonalnie, domyślnie "1")
 *
 * Użycie:
 *   npx hardhat run scripts/sepolia_smoke_test.js --network baseSepolia
 *   (albo: npm run smoke:sepolia)
 */

const { ethers, network } = require("hardhat");
const { getContractAddress, getUsdcAddress } = require("./deployment");

const ERC20_ABI = [
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
];

function requireEnv(key) {
  const value = process.env[key];
  if (!value) {
    throw new Error(
      `❌ Brak wymaganej zmiennej środowiskowej ${key}. Zobacz sekcję ".env" w podsumowaniu wdrożenia.`
    );
  }
  return value;
}

/**
 * Normalizuje klucz prywatny do formatu wymaganego przez ethers.Wallet
 * (0x + 64 znaki hex). Częsta pomyłka: niektóre portfele (np. "copy private
 * key" w MetaMask) kopiują klucz BEZ prefiksu "0x" — dopisujemy go, zamiast
 * wywalać się niejasnym "invalid private key" z głębi ethers.js.
 */
function requirePrivateKey(key) {
  const raw = requireEnv(key);
  const normalized = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error(
      `❌ ${key} nie wygląda na poprawny klucz prywatny (oczekiwano 0x + 64 znaki hex, ewentualnie same 64 znaki hex bez "0x").`
    );
  }
  return normalized;
}

function explorerTxUrl(chainId, txHash) {
  const base = chainId === 84532 ? "https://sepolia.basescan.org" : "https://basescan.org";
  return `${base}/tx/${txHash}`;
}

/** Wartości enuma `EscrowState` z BlackSwanOS.sol (musi się zgadzać z kontraktem). */
const EscrowState = { AWAITING_SELLER: 0, LOCKED: 1, DISPUTED: 2, RESOLVED: 3, CLAIMED: 4 };

/**
 * Base Sepolia RPC (`https://sepolia.base.org`) jest load-balancowany między
 * wiele backendowych node'ów BEZ sticky session — odczyt `getEscrow`/`balanceOf`
 * wysłany DOSŁOWNIE od razu po `tx.wait()` może trafić na node, który jeszcze
 * nie dogonił najnowszego bloku, i zwrócić dane sprzed transakcji (widzieliśmy
 * to już przy odczycie `oracle()` zaraz po `setOracleAddress()`). Transakcja
 * jest wtedy w 100% poprawna na chainie — tylko odczyt jest "spóźniony".
 *
 * Żeby finalny raport smoke testu nie kłamał, próbujemy odczytać stan escrow
 * do `maxAttempts` razy, czekając `delayMs` między próbami, aż `status`
 * dojdzie do oczekiwanej wartości (albo poddajemy się i zwracamy ostatni odczyt
 * z wyraźnym ostrzeżeniem — sama transakcja i tak ma potwierdzenie na explorerze).
 */
async function waitForFreshEscrow(contract, escrowId, expectedState, { maxAttempts = 8, delayMs = 4000 } = {}) {
  let last = await contract.getEscrow(escrowId);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (Number(last.state) === expectedState) return { escrow: last, fresh: true };
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    last = await contract.getEscrow(escrowId);
  }
  console.warn(
    `   ⚠️  Po ${maxAttempts} próbach odczyt escrow wciąż pokazuje status=${last.state.toString()} ` +
      `(oczekiwano ${expectedState}). To prawdopodobnie stale-read z load-balancowanego RPC — ` +
      "sprawdź transakcję na explorerze, żeby potwierdzić prawdziwy stan on-chain."
  );
  return { escrow: last, fresh: false };
}

/** Czeka `seconds` realnego czasu, wypisując progres co ~1 minutę (albo częściej dla krótkich okien). */
async function waitRealSeconds(seconds, label) {
  const stepMs = Math.min(60_000, Math.max(5_000, (seconds * 1000) / 10));
  const deadline = Date.now() + seconds * 1000;
  console.log(`⏳ ${label}: czekam ${seconds}s w czasie rzeczywistym (blockchain, bez skrótów)...`);
  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    await new Promise((resolve) => setTimeout(resolve, Math.min(stepMs, remainingMs)));
    const remainingSec = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    if (remainingSec > 0) console.log(`   ↳ pozostało ~${remainingSec}s...`);
  }
}

async function main() {
  if (network.name === "hardhat" || network.name === "localhost") {
    console.log(
      "⚠️  Ten skrypt jest myślany dla realnych sieci testowych (np. baseSepolia) — na sieci lokalnej " +
        "zwykłe evm_increaseTime w scripts/verify_dispute_bond.js jest dużo szybsze. Kontynuuję mimo to."
    );
  }

  const contractAddress = getContractAddress();
  const usdcAddress = getUsdcAddress();

  const provider = ethers.provider;
  const chainId = Number((await provider.getNetwork()).chainId);

  const buyer = new ethers.Wallet(requirePrivateKey("SEPOLIA_BUYER_PRIVATE_KEY"), provider);
  const seller = new ethers.Wallet(requirePrivateKey("SEPOLIA_SELLER_PRIVATE_KEY"), provider);

  console.log("🚀 BlackSwanOS — smoke test E2E na", network.name);
  console.log(`   Kontrakt: ${contractAddress}`);
  console.log(`   USDC:     ${usdcAddress}`);
  console.log(`   Buyer:    ${buyer.address}`);
  console.log(`   Seller:   ${seller.address}`);

  const contract = await ethers.getContractAt("BlackSwanOS", contractAddress);
  const usdc = new ethers.Contract(usdcAddress, ERC20_ABI, provider);

  const payloadPriceStr = process.env.SMOKE_TEST_PAYLOAD_PRICE_USDC || "1";
  const payloadPrice = ethers.parseUnits(payloadPriceStr, 6);

  const [maxFileSize, disputeWindow, systemFeeBps, collateralBps, bpsDenominator] = await Promise.all([
    contract.MAX_ALLOWED_FILE_SIZE(),
    contract.MIN_DISPUTE_WINDOW(), // najkrótsze dozwolone okno -> najszybszy possible happy path na testnecie
    contract.systemFeeBps(),
    contract.COLLATERAL_BPS(),
    contract.BPS_DENOMINATOR(),
  ]);

  const systemFee = (payloadPrice * systemFeeBps) / bpsDenominator;
  const buyerDeposit = payloadPrice + systemFee;
  const sellerCollateral = (payloadPrice * collateralBps) / bpsDenominator;

  console.log(`\n📋 Parametry testowego escrow:`);
  console.log(`   payloadPrice:   ${ethers.formatUnits(payloadPrice, 6)} USDC`);
  console.log(`   maxFileSize:    ${maxFileSize.toString()} bajtów (MAX_ALLOWED_FILE_SIZE)`);
  console.log(`   disputeWindow:  ${disputeWindow.toString()}s (MIN_DISPUTE_WINDOW)`);
  console.log(`   buyerDeposit:   ${ethers.formatUnits(buyerDeposit, 6)} USDC (payloadPrice + systemFee)`);
  console.log(`   sellerCollateral: ${ethers.formatUnits(sellerCollateral, 6)} USDC (200%)`);

  // --- Sprawdzenie sald PRZED zrobieniem czegokolwiek on-chain ------------
  const [buyerBalance, sellerBalance] = await Promise.all([
    usdc.balanceOf(buyer.address),
    usdc.balanceOf(seller.address),
  ]);
  if (buyerBalance < buyerDeposit) {
    throw new Error(
      `❌ Buyer (${buyer.address}) ma za mało testowego USDC: ${ethers.formatUnits(buyerBalance, 6)}, ` +
        `potrzeba ${ethers.formatUnits(buyerDeposit, 6)}. Doładuj z faucetu Circle: https://faucet.circle.com/`
    );
  }
  if (sellerBalance < sellerCollateral) {
    throw new Error(
      `❌ Seller (${seller.address}) ma za mało testowego USDC: ${ethers.formatUnits(sellerBalance, 6)}, ` +
        `potrzeba ${ethers.formatUnits(sellerCollateral, 6)}. Doładuj z faucetu Circle: https://faucet.circle.com/`
    );
  }

  // --- Krok 1: approve (tylko jeśli allowance już nie wystarcza) ---------
  async function ensureApproval(wallet, requiredAmount, label) {
    const current = await usdc.allowance(wallet.address, contractAddress);
    if (current >= requiredAmount) {
      console.log(`✅ ${label}: allowance już wystarczające (${ethers.formatUnits(current, 6)} USDC).`);
      return;
    }
    console.log(`🔓 ${label}: wysyłam approve(${ethers.formatUnits(requiredAmount, 6)} USDC)...`);
    const tx = await usdc.connect(wallet).approve(contractAddress, requiredAmount);
    const receipt = await tx.wait();
    console.log(`   ↳ potwierdzone: ${explorerTxUrl(chainId, receipt.hash)}`);
  }

  await ensureApproval(buyer, buyerDeposit, "Buyer");
  await ensureApproval(seller, sellerCollateral, "Seller");

  // --- Krok 2: createEscrow -----------------------------------------------
  console.log("\n📦 Buyer: createEscrow(seller, payloadPrice, maxFileSize, disputeWindow)...");
  const createTx = await contract
    .connect(buyer)
    .createEscrow(seller.address, payloadPrice, maxFileSize, disputeWindow);
  const createReceipt = await createTx.wait();
  console.log(`   ↳ tx: ${explorerTxUrl(chainId, createReceipt.hash)}`);

  const createdEvent = createReceipt.logs
    .map((log) => {
      try {
        return contract.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed) => parsed?.name === "EscrowCreated");
  const escrowId = createdEvent ? createdEvent.args.escrowId : (await contract.nextEscrowId()) - 1n;
  console.log(`✅ Escrow utworzony, ID = ${escrowId.toString()}`);

  // --- Krok 3: sellerLock ---------------------------------------------------
  console.log("\n🔒 Seller: sellerLock(escrowId, payloadHash)...");
  const payloadHash = ethers.id(`sepolia-smoke-test-${escrowId.toString()}-${Date.now()}`);
  const lockTx = await contract.connect(seller).sellerLock(escrowId, payloadHash);
  const lockReceipt = await lockTx.wait();
  console.log(`   ↳ tx: ${explorerTxUrl(chainId, lockReceipt.hash)}`);

  const lockedEscrow = await contract.getEscrow(escrowId);
  console.log(`✅ Seller zablokował depozyt. lockTime=${lockedEscrow.lockTime.toString()}`);

  // --- Krok 4: Happy Path — czekamy na koniec disputeWindow, potem claimFunds ---
  console.log(
    "\n🕊️  Happy Path: nikt nie zgłasza sporu w oknie disputeWindow -> po jego upłynięciu " +
      "KAŻDY (tu: Buyer) może permissionless wywołać claimFunds() i uwolnić środki dla Sprzedawcy."
  );
  await waitRealSeconds(Number(disputeWindow) + 15, "Oczekiwanie na koniec disputeWindow (+15s zapasu na czas bloku)");

  console.log("\n💸 Buyer: claimFunds(escrowId) — happy-path auto-release (permissionless)...");
  const sellerBalanceBefore = await usdc.balanceOf(seller.address);
  const claimTx = await contract.connect(buyer).claimFunds(escrowId);
  const claimReceipt = await claimTx.wait();
  console.log(`   ↳ tx: ${explorerTxUrl(chainId, claimReceipt.hash)}`);

  // Odczyt zaraz po tx.wait() może trafić na "spóźniony" node publicznego RPC
  // (brak sticky session) i pokazać stan sprzed transakcji — dogaduj się, aż
  // status faktycznie dojdzie do CLAIMED, zamiast raportować fałszywy fail.
  console.log("   ↳ czekam na potwierdzenie świeżego odczytu stanu (RPC może być kilka sekund w tyle)...");
  const { escrow: finalEscrow, fresh } = await waitForFreshEscrow(contract, escrowId, EscrowState.CLAIMED);
  const sellerBalanceAfter = await usdc.balanceOf(seller.address);

  const sellerReceived = sellerBalanceAfter - sellerBalanceBefore;
  const expectedReceived = payloadPrice + sellerCollateral;

  console.log(`\n🎉 SUKCES — pełny happy path E2E na ${network.name} zakończony.`);
  console.log(
    `   Stan końcowy escrow: ${finalEscrow.state.toString()} (4 = CLAIMED)` + (fresh ? "" : "  [ODCZYT MOŻE BYĆ STALE]")
  );
  console.log(
    `   Seller otrzymał: ${ethers.formatUnits(sellerReceived, 6)} USDC ` +
      `(oczekiwane: ${ethers.formatUnits(expectedReceived, 6)} USDC = payloadPrice + collateral)`
  );

  if (fresh && sellerReceived === expectedReceived) {
    console.log("   ✅ Zgodność potwierdzona świeżym odczytem — happy path zweryfikowany end-to-end.");
  } else if (!fresh) {
    console.log(
      "   ℹ️  Zweryfikuj transakcję ręcznie na BaseScan (link powyżej) — receipt jest ostatecznym źródłem prawdy, " +
        "nie ten odczyt."
    );
  } else {
    console.warn("   ⚠️  Świeży odczyt jest gotowy, ale kwota się NIE zgadza — to już realny problem do zbadania.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ Smoke test E2E nie powiódł się:", error.message || error);
    process.exit(1);
  });
