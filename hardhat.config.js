// UWAGA: `hardhat-toolbox` NIE wczytuje automatycznie .env — bez tej linii
// process.env.PRIVATE_KEY / BASE_SEPOLIA_RPC_URL / BASESCAN_API_KEY byłyby
// zawsze `undefined` przy realnym deployu (na `localhost` nikt tego nie
// zauważył, bo ta sieć nie potrzebuje kluczy — Hardhat bierze konta wprost
// z lokalnego node'a).
require("dotenv").config({ path: require("node:path").join(__dirname, ".env") });
require("@nomicfoundation/hardhat-toolbox");

/**
 * Hardhat waliduje format `accounts` dla WSZYSTKICH skonfigurowanych sieci
 * przy KAŻDEJ komendzie (nawet `hardhat compile`), niezależnie od tego, czy
 * dana sieć jest w ogóle używana. Bez tego filtra, placeholder w .env
 * (np. `PRIVATE_KEY=0xYOUR_DEPLOYER_PRIVATE_KEY_HERE`) wywaliłby błędem
 * config KAŻDĄ komendę, także zwykły lokalny `npm run simulate`. Traktujemy
 * więc każdy klucz, który nie jest poprawnym 32-bajtowym hexem, jak brak
 * klucza — realny błąd i tak wyjdzie dopiero przy próbie deployu na tę sieć.
 */
function resolvePrivateKey(rawValue, envVarName) {
  if (!rawValue) return [];
  // Częsta pomyłka: niektóre portfele (np. "copy private key" w MetaMask)
  // kopiują klucz BEZ prefiksu "0x" — normalizujemy, zamiast cichо odrzucać
  // poprawny klucz tylko z powodu brakującego prefiksu.
  const normalized = rawValue.startsWith("0x") ? rawValue : `0x${rawValue}`;
  if (/^0x[0-9a-fA-F]{64}$/.test(normalized)) return [normalized];
  console.warn(
    `⚠️  ${envVarName} w .env nie wygląda na poprawny klucz prywatny (oczekiwano 0x + 64 znaki hex) — ignoruję go.`
  );
  return [];
}

// Konfiguracja sieci testowej Base Sepolia — wydzielona do zmiennej, bo
// Hardhat dopasowuje nazwę sieci z `--network` DOKŁADNIE 1:1 (string match).
// Niektóre komendy/dokumentacja/przyzwyczajenia używają zapisu z myślnikiem
// (`base-sepolia`), inne camelCase (`baseSepolia`) — żeby `--network
// base-sepolia` (błąd HH100: "Network base-sepolia doesn't exist") ORAZ
// `--network baseSepolia` (używane przez npm run deploy:sepolia / smoke:sepolia)
// działały obie, rejestrujemy ten sam obiekt pod DWOMA kluczami poniżej.
const baseSepoliaNetwork = {
  url: process.env.BASE_SEPOLIA_RPC_URL || "https://sepolia.base.org",
  accounts: resolvePrivateKey(process.env.PRIVATE_KEY, "PRIVATE_KEY"),
  chainId: 84532,
};

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: "0.8.24",
  networks: {
    base: {
      url: "https://mainnet.base.org",
      accounts: resolvePrivateKey(process.env.PRIVATE_KEY, "PRIVATE_KEY"),
    },
    baseSepolia: baseSepoliaNetwork,
    "base-sepolia": baseSepoliaNetwork,
  },
  // Weryfikacja kodu źródłowego (plugin `@nomicfoundation/hardhat-verify`,
  // dołączony przez `hardhat-toolbox` jako peer dependency — patrz package.json).
  //
  // WAŻNE — migracja na Etherscan API V2 (maj 2025, BaseScan działa teraz na
  // tej samej, WSPÓLNEJ infrastrukturze co Etherscan):
  //   - `apiKey` MUSI być JEDNYM stringiem (jeden klucz z etherscan.io,
  //     działający dla WIELU sieci, w tym Base i Base Sepolia), NIE obiektem
  //     per-sieć ({ base: "...", baseSepolia: "..." }). Plugin patrzy na
  //     `typeof apiKey` — string => tryb V2 (poprawny endpoint
  //     https://api.etherscan.io/v2/api?chainid=...), obiekt => STARY tryb V1
  //     (per-explorer apiURL), który BaseScan już odrzuca z komunikatem
  //     "deprecated V1 endpoint" — to był dokładnie ten błąd.
  //   - `customChains` dla `base`/`baseSepolia` (chainId 8453/84532) NIE są
  //     już potrzebne — plugin ma je WBUDOWANE (patrz
  //     node_modules/@nomicfoundation/hardhat-verify/internal/chain-config.js)
  //     i w trybie V2 dopasowuje sieć po realnym chainId zwróconym przez RPC
  //     (eth_chainId), NIE po nazwie z `--network` — więc nasz alias
  //     `base-sepolia` (myślnik) też działa automatycznie, bez wpisu w
  //     customChains.
  //   - Klucz API generuj na https://etherscan.io/myapikey (NIE
  //     basescan.org — od V2 to jeden, wspólny dashboard/klucz).
  etherscan: {
    apiKey: process.env.BASESCAN_API_KEY || process.env.ETHERSCAN_API_KEY || "",
  },
};