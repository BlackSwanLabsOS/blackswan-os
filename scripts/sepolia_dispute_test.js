/**
 * scripts/sepolia_dispute_test.js
 *
 * E2E test of the DISPUTE path (as opposed to sepolia_smoke_test.js, which
 * only exercises the happy path) against the REALLY deployed BlackSwanOS
 * contract on Base Sepolia — no local shortcuts, no time-skipping.
 *
 * Unlike the happy path, raising a dispute does NOT require waiting for
 * `disputeWindow` to elapse — it can (and, to prove the point, in this
 * script DOES) happen the instant after `sellerLock`. This script stops
 * right there and hands control back to you, so you can manually drive the
 * Oracle side and watch it read the on-chain DISPUTED state for yourself.
 *
 * Przebieg:
 *   1. Buyer i Seller zatwierdzają (approve) testowe USDC — jak w smoke teście,
 *      PLUS Buyer zatwierdza dodatkowo kaucję za spór (dispute bond).
 *   2. Buyer woła createEscrow(...) z nową logiką cenowej/limitu 100 KB.
 *   3. Seller woła sellerLock(escrowId, payloadHash) — `payloadHash` jest
 *      SHA-256 PRAWDZIWEGO, poprawnego JSON payloadu (zapisanego też do
 *      pliku na dysku), nie losowego placeholdera — żeby Oracle miał
 *      faktycznie coś sensownego do zwalidowania (Steps 1-4 + LLM), a nie
 *      tylko odczytać status.
 *   4. Buyer OD RAZU woła raiseDispute(escrowId) — bez czekania.
 *   5. Skrypt SIĘ ZATRZYMUJE i wypisuje dokładne instrukcje: jak odpalić
 *      Python Oracle i jak wysłać mu ten sam payload do walidacji.
 *
 * Wymagane zmienne środowiskowe: te same co sepolia_smoke_test.js
 *   (CONTRACT_ADDRESS/USDC_ADDRESS z deployment.json, SEPOLIA_BUYER_PRIVATE_KEY,
 *   SEPOLIA_SELLER_PRIVATE_KEY).
 *
 * Użycie:
 *   npx hardhat run scripts/sepolia_dispute_test.js --network baseSepolia
 *   (albo: npm run dispute:sepolia)
 */

const { createHash } = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
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

/** Patrz identyczny komentarz w sepolia_smoke_test.js — normalizacja "0x" prefiksu. */
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

function explorerAddressUrl(chainId, address) {
  const base = chainId === 84532 ? "https://sepolia.basescan.org" : "https://basescan.org";
  return `${base}/address/${address}#readContract`;
}

/** Wartości enuma `EscrowState` z BlackSwanOS.sol (musi się zgadzać z kontraktem). */
const EscrowState = { AWAITING_SELLER: 0, LOCKED: 1, DISPUTED: 2, RESOLVED: 3, CLAIMED: 4 };

/**
 * Patrz identyczny komentarz w sepolia_smoke_test.js: odczyt zaraz po
 * tx.wait() może trafić na "spóźniony" node publicznego RPC Base Sepolia
 * (load-balancowany, bez sticky session) i zwrócić stan sprzed transakcji.
 * Retry aż stan faktycznie dojdzie do oczekiwanej wartości, zamiast raportować
 * fałszywy fail na czysto poprawnej transakcji.
 */
async function waitForFreshEscrow(contract, escrowId, expectedState, { maxAttempts = 8, delayMs = 4000 } = {}) {
  let last = await contract.getEscrow(escrowId);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (Number(last.state) === expectedState) return { escrow: last, fresh: true };
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    last = await contract.getEscrow(escrowId);
  }
  return { escrow: last, fresh: false };
}

async function ensureApproval(usdc, wallet, contractAddress, requiredAmount, label, chainId) {
  // Same "spóźniony node RPC bez sticky session" issue as `waitForFreshEscrow`
  // above: reading `allowance` immediately after a PRIOR transaction that
  // consumed it (e.g. `createEscrow`'s transferFrom) can hit a load-balanced
  // public RPC replica that hasn't caught up yet, returning the OLD
  // (pre-consumption) allowance. That made this function wrongly conclude
  // "already sufficient" and skip re-approving, causing the NEXT on-chain
  // call (e.g. raiseDispute) to revert with "transfer amount exceeds
  // allowance". Small fixed delay is enough here (unlike escrow state,
  // there's no natural "expected value" to poll against).
  await new Promise((resolve) => setTimeout(resolve, 3000));
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

async function main() {
  const contractAddress = getContractAddress();
  const usdcAddress = getUsdcAddress();

  const provider = ethers.provider;
  const chainId = Number((await provider.getNetwork()).chainId);

  const buyer = new ethers.Wallet(requirePrivateKey("SEPOLIA_BUYER_PRIVATE_KEY"), provider);
  const seller = new ethers.Wallet(requirePrivateKey("SEPOLIA_SELLER_PRIVATE_KEY"), provider);

  console.log("⚔️  BlackSwanOS — test ścieżki SPORU (dispute path) na", network.name);
  console.log(`   Kontrakt: ${contractAddress}`);
  console.log(`   USDC:     ${usdcAddress}`);
  console.log(`   Buyer:    ${buyer.address}`);
  console.log(`   Seller:   ${seller.address}`);

  const contract = await ethers.getContractAt("BlackSwanOS", contractAddress);
  const usdc = new ethers.Contract(usdcAddress, ERC20_ABI, provider);

  const payloadPriceStr = process.env.SMOKE_TEST_PAYLOAD_PRICE_USDC || "1";
  const payloadPrice = ethers.parseUnits(payloadPriceStr, 6);

  const [
    maxFileSize,
    disputeWindow,
    systemFeeBps,
    collateralBps,
    bpsDenominator,
    disputeBondBps,
    minDisputeBond,
  ] = await Promise.all([
    contract.MAX_ALLOWED_FILE_SIZE(), // pełny sufit -> ćwiczymy też nową logikę cenową w createEscrow
    contract.MIN_DISPUTE_WINDOW(),
    contract.systemFeeBps(),
    contract.COLLATERAL_BPS(),
    contract.BPS_DENOMINATOR(),
    contract.disputeBondBps(),
    contract.minDisputeBond(),
  ]);

  const minRequiredPrice = await contract.minRequiredPrice(maxFileSize);
  if (payloadPrice < minRequiredPrice) {
    throw new Error(
      `❌ SMOKE_TEST_PAYLOAD_PRICE_USDC (${payloadPriceStr} USDC) jest poniżej minimalnej ceny dla ` +
        `maxFileSize=${maxFileSize}: wymagane ${ethers.formatUnits(minRequiredPrice, 6)} USDC.`
    );
  }

  const systemFee = (payloadPrice * systemFeeBps) / bpsDenominator;
  const buyerDeposit = payloadPrice + systemFee;
  const sellerCollateral = (payloadPrice * collateralBps) / bpsDenominator;
  const percentageBond = (payloadPrice * disputeBondBps) / bpsDenominator;
  const disputeBond = percentageBond > minDisputeBond ? percentageBond : minDisputeBond;

  console.log(`\n📋 Parametry testowego escrow:`);
  console.log(`   payloadPrice:      ${ethers.formatUnits(payloadPrice, 6)} USDC`);
  console.log(`   maxFileSize:       ${maxFileSize.toString()} bajtów (MAX_ALLOWED_FILE_SIZE)`);
  console.log(`   disputeWindow:     ${disputeWindow.toString()}s (MIN_DISPUTE_WINDOW) — NIE czekamy na niego w tym teście`);
  console.log(`   systemFee:         ${ethers.formatUnits(systemFee, 6)} USDC (${Number(systemFeeBps) / 100}% z payloadPrice)`);
  console.log(`   buyerDeposit:      ${ethers.formatUnits(buyerDeposit, 6)} USDC (payloadPrice + systemFee)`);
  console.log(`   sellerCollateral:  ${ethers.formatUnits(sellerCollateral, 6)} USDC (200%)`);
  console.log(`   disputeBond:       ${ethers.formatUnits(disputeBond, 6)} USDC (hybrid: max(5%, min 0.20 USDC))`);

  // --- Sprawdzenie sald PRZED zrobieniem czegokolwiek on-chain ------------
  const [buyerBalance, sellerBalance] = await Promise.all([
    usdc.balanceOf(buyer.address),
    usdc.balanceOf(seller.address),
  ]);
  const buyerTotalNeeded = buyerDeposit + disputeBond; // Buyer płaci depozyt ORAZ (w tym teście) kaucję za spór
  if (buyerBalance < buyerTotalNeeded) {
    throw new Error(
      `❌ Buyer (${buyer.address}) ma za mało testowego USDC: ${ethers.formatUnits(buyerBalance, 6)}, ` +
        `potrzeba ${ethers.formatUnits(buyerTotalNeeded, 6)} (depozyt + kaucja za spór). ` +
        `Doładuj z faucetu Circle: https://faucet.circle.com/`
    );
  }
  if (sellerBalance < sellerCollateral) {
    throw new Error(
      `❌ Seller (${seller.address}) ma za mało testowego USDC: ${ethers.formatUnits(sellerBalance, 6)}, ` +
        `potrzeba ${ethers.formatUnits(sellerCollateral, 6)}. Doładuj z faucetu Circle: https://faucet.circle.com/`
    );
  }

  // --- Krok 1: approve -----------------------------------------------------
  await ensureApproval(usdc, buyer, contractAddress, buyerDeposit, "Buyer (deposit)", chainId);
  await ensureApproval(usdc, seller, contractAddress, sellerCollateral, "Seller (collateral)", chainId);

  // --- Krok 2: createEscrow ------------------------------------------------
  console.log("\n📦 Buyer: createEscrow(seller, payloadPrice, maxFileSize, disputeWindow)...");
  const createTx = await contract
    .connect(buyer)
    .createEscrow(seller.address, payloadPrice, maxFileSize, disputeWindow);
  const createReceipt = await createTx.wait();
  console.log(`   ↳ tx: ${explorerTxUrl(chainId, createReceipt.hash)}`);

  // Odczyt escrowId z EVENTU tej samej transakcji (100% pewne, z tego
  // samego receipta) — NIE osobnym zapytaniem nextEscrowId() zaraz po
  // tx.wait(), bo to może trafić na "spóźniony" node RPC (load-balancowany
  // sepolia.base.org bez sticky session) i zwrócić escrowId JUŻ ZAJĘTY
  // przez wcześniejszy test, prowadząc do rewertu w sellerLock/raiseDispute
  // poniżej. Fallback na nextEscrowId() tylko jeśli parsowanie eventu
  // zawiedzie (nie powinno, ale nie chcemy twardo się wywalić bez próby).
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

  // --- Krok 3: sellerLock z PRAWDZIWYM payloadem --------------------------
  // Realny, poprawny JSON — nie ethers.id(losowy string) jak w smoke teście —
  // żeby Oracle miał coś sensownego do zwalidowania (Steps 1-4 + LLM), a nie
  // tylko odczytać status DISPUTED.
  const payloadObject = {
    dataset: "sepolia-dispute-test",
    escrowId: escrowId.toString(),
    generatedAt: new Date().toISOString(),
    records: [
      { id: 1, label: "example-record-one", value: 42 },
      { id: 2, label: "example-record-two", value: 7 },
    ],
  };
  // JSON.stringify SANS indent — bajty które faktycznie hashujemy i wysyłamy
  // muszą być identyczne z tym co zapisujemy do pliku i co Oracle zahashuje.
  const payloadText = JSON.stringify(payloadObject);
  const payloadHash = `0x${createHash("sha256").update(payloadText, "utf-8").digest("hex")}`;

  const payloadFilePath = path.join(__dirname, "..", `dispute_test_payload_${escrowId}.json`);
  fs.writeFileSync(payloadFilePath, payloadText); // BEZ końcowego "\n" — inaczej hash się rozjedzie

  console.log("\n🔒 Seller: sellerLock(escrowId, payloadHash)...");
  console.log(`   payloadHash (SHA-256): ${payloadHash}`);
  console.log(`   payload zapisany do:  ${payloadFilePath}`);
  const lockTx = await contract.connect(seller).sellerLock(escrowId, payloadHash);
  const lockReceipt = await lockTx.wait();
  console.log(`   ↳ tx: ${explorerTxUrl(chainId, lockReceipt.hash)}`);

  // --- Krok 4: Buyer OD RAZU raiseDispute(escrowId) — bez czekania -------
  await ensureApproval(usdc, buyer, contractAddress, disputeBond, "Buyer (dispute bond)", chainId);

  console.log("\n⚔️  Buyer: raiseDispute(escrowId) — OD RAZU, bez czekania na disputeWindow...");
  const disputeTx = await contract.connect(buyer).raiseDispute(escrowId);
  const disputeReceipt = await disputeTx.wait();
  console.log(`   ↳ tx: ${explorerTxUrl(chainId, disputeReceipt.hash)}`);

  console.log("   ↳ czekam na potwierdzenie świeżego odczytu stanu (RPC może być kilka sekund w tyle)...");
  const { escrow: finalEscrow, fresh } = await waitForFreshEscrow(contract, escrowId, EscrowState.DISPUTED);
  console.log(
    `\n✅ Escrow ${escrowId} jest teraz w stanie: ${finalEscrow.state.toString()} (2 = DISPUTED)` +
      (fresh ? "" : "  [ODCZYT MOŻE BYĆ STALE — sprawdź na Basescan]")
  );

  // --- STOP. Piłka po Twojej stronie. -------------------------------------
  console.log("\n" + "=".repeat(78));
  console.log("🛑 SKRYPT ZATRZYMANY — spór jest na chainie, teraz Twoja kolej.");
  console.log("=".repeat(78));
  console.log(`
Escrow ID:        ${escrowId}
Stan on-chain:     DISPUTED (sprawdź: ${explorerAddressUrl(chainId, contractAddress)})
Payload (do wysłania Oracle'owi), zapisany też w pliku:
  ${payloadFilePath}

---- KROK A: odpal prawdziwy Python Oracle (PowerShell, Windows) ------------
  cd oracle
  .\\venv\\Scripts\\python.exe -m uvicorn main:app --reload --port 8000

  (venv już ma zainstalowane fastapi/uvicorn/web3 — nic nie trzeba doinstalowywać.
   Wymaga wypełnionego oracle/.env: RPC_URL, CONTRACT_ADDRESS, ORACLE_PRIVATE_KEY
   — już ustawione — ORAZ OPENAI_API_KEY lub ANTHROPIC_API_KEY, żeby Step 5
   (LLM) też przeszedł. BRAK klucza LLM w oracle/.env w tej chwili! Bez niego:
   Steps 1-4 i tak przejdą, Step 5 zwróci czytelny błąd, a escrow bezpiecznie
   ZOSTAJE w stanie DISPUTED — to jest oczekiwane zero-trust zachowanie, nie
   bug, ale jeśli chcesz zobaczyć PEŁNY werdykt LLM, dodaj klucz przed tym krokiem.)

---- KROK B: sprawdź, czy Oracle widzi spór (przed wysłaniem payloadu) ------
  Invoke-RestMethod -Uri "http://localhost:8000/disputes/${escrowId}/status" -Method Get

  Oczekiwany wynik: "on_chain_state": "DISPUTED" — to jest właśnie to, o co
  pytałeś: potwierdzenie, że Oracle CZYTA stan bezpośrednio z chaina (nie z
  cache'u/eventu), niezależnie od tego czy event listener złapał zdarzenie
  (mógł nie złapać, jeśli Oracle wystartował PO tym skrypcie — to nieistotne,
  Oracle i tak re-fetchuje escrow on-chain przy każdym żądaniu).

---- KROK C: wyślij payload do walidacji + rozstrzygnięcia ------------------
  (wymaga nagłówka X-Oracle-Secret = ORACLE_HTTP_SECRET z oracle/.env)

  curl.exe -X POST "http://localhost:8000/disputes/${escrowId}/payload" ^
    -H "X-Oracle-Secret: TWOJ_SEKRET_Z_ENV" ^
    --data-binary "@${payloadFilePath}"

  (PowerShell — podstaw $secret z oracle/.env):
  $h = @{ "X-Oracle-Secret" = $secret; "Content-Type" = "application/json" }
  Invoke-RestMethod -Uri "http://localhost:8000/disputes/${escrowId}/payload" -Method Post -InFile "${payloadFilePath}" -Headers $h

  To wywołanie: (1) zweryfikuje hash/rozmiar/składnię, (2) jeśli wszystko
  gra, wyśle payload do LLM po werdykt, (3) wywoła resolveDispute() on-chain
  z portfela Oracle. Odpowiedź JSON powie Ci werdykt i tx_hash.

---- KROK D: po rozstrzygnięciu — odbierz środki -----------------------------
  Escrow trafi w stan RESOLVED. Ktokolwiek (buyer/seller/Ty) może teraz
  wywołać claimResolved(${escrowId}) na kontrakcie, żeby faktycznie
  przelać USDC zgodnie z werdyktem.
`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("\n❌ Test ścieżki sporu nie powiódł się:", error.message || error);
    process.exit(1);
  });
