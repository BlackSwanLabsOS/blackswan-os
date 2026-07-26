#!/usr/bin/env node
/**
 * Orchestrator pełnej lokalnej symulacji sporu BlackSwanOS.
 *
 *   node scripts/orchestrator.js
 *
 * Co robi automatycznie:
 *   1. Sprawdza, czy lokalny węzeł Hardhat (127.0.0.1:8545) już działa.
 *      Jeśli nie — startuje `npx hardhat node --fork <Base RPC>`.
 *   2. Wdraża świeży kontrakt BlackSwanOS (scripts/deploy.js) i zapisuje
 *      jego adres do deployment.json + wszystkich plików .env serwisów.
 *   3. Startuje wyrocznię (watcher.js) w tle, żeby nasłuchiwała zdarzeń.
 *   4. Odpala pełną symulację sporu (simulate.js): zastrzyk USDC ->
 *      approve -> createEscrow -> sellerLock -> raiseDispute.
 *   5. Zostawia węzeł + wyrocznię działające, żeby widzieć zdarzenia na
 *      żywo. Ctrl+C zamyka wszystko czysto (węzeł Hardhat + watcher).
 *
 * Zmienne środowiskowe (opcjonalne):
 *   RPC_URL  - domyślnie http://127.0.0.1:8545
 *   FORK_URL - domyślnie https://mainnet.base.org
 */

const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");

const ROOT_DIR = path.join(__dirname, "..");
const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8545";
const FORK_URL = process.env.FORK_URL || "https://mainnet.base.org";

const children = [];
let shuttingDown = false;

function log(tag, msg) {
    console.log(`[${tag}] ${msg}`);
}

function isNodeUp() {
    return new Promise((resolve) => {
        let url;
        try {
            url = new URL(RPC_URL);
        } catch (_err) {
            return resolve(false);
        }

        const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] });
        const req = http.request(
            {
                hostname: url.hostname,
                port: url.port || 80,
                path: "/",
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Content-Length": Buffer.byteLength(body),
                },
                timeout: 1500,
            },
            (res) => {
                res.on("data", () => {});
                res.on("end", () => resolve(res.statusCode === 200));
            }
        );
        req.on("error", () => resolve(false));
        req.on("timeout", () => {
            req.destroy();
            resolve(false);
        });
        req.write(body);
        req.end();
    });
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(conditionFn, { intervalMs = 500, timeoutMs = 90000, label = "warunek" } = {}) {
    const start = Date.now();
    while (!(await conditionFn())) {
        if (Date.now() - start > timeoutMs) {
            throw new Error(`⏱️  Przekroczono czas oczekiwania na: ${label}`);
        }
        await sleep(intervalMs);
    }
}

/** Odpala proces, czeka na jego zakończenie i rzuca błąd przy exit code != 0. */
function runToCompletion(args, tag) {
    return new Promise((resolve, reject) => {
        log(tag, `npx ${args.join(" ")}`);
        const child = spawn("npx", args, { cwd: ROOT_DIR, stdio: "inherit", shell: true });
        child.on("exit", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`Proces "${tag}" zakończył się kodem ${code}`));
        });
        child.on("error", reject);
    });
}

/** Odpala proces w tle (np. węzeł Hardhat, wyrocznia) i zwraca uchwyt do niego. */
function spawnBackground(args, tag) {
    log(tag, `(tło) npx ${args.join(" ")}`);
    const child = spawn("npx", args, { cwd: ROOT_DIR, stdio: "inherit", shell: true });
    child.tag = tag;
    children.push(child);
    child.on("exit", (code) => {
        if (!shuttingDown && code !== 0 && code !== null) {
            log(tag, `⚠️  proces w tle zakończył się nieoczekiwanie (kod ${code})`);
        }
    });
    return child;
}

function cleanup() {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const child of children) {
        if (child.killed || child.exitCode !== null) continue;
        log(child.tag ?? "proc", "🧹 zatrzymuję...");
        try {
            if (process.platform === "win32") {
                spawn("taskkill", ["/pid", String(child.pid), "/f", "/t"], { stdio: "ignore" });
            } else {
                child.kill("SIGTERM");
            }
        } catch (_err) {
            // best-effort cleanup
        }
    }
}

process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
});
process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
});

async function main() {
    log("orchestrator", "🔎 Sprawdzam, czy lokalny węzeł Hardhat już działa...");
    const nodeAlreadyRunning = await isNodeUp();

    if (!nodeAlreadyRunning) {
        log("orchestrator", `🟢 Startuję węzeł Hardhat (fork: ${FORK_URL})...`);
        spawnBackground(["hardhat", "node", "--fork", FORK_URL], "hardhat-node");
        await waitFor(isNodeUp, { timeoutMs: 90000, label: "start węzła Hardhat" });
        log("orchestrator", "✅ Węzeł Hardhat wystartował i odpowiada na " + RPC_URL);
    } else {
        log("orchestrator", `✅ Węzeł Hardhat już działa na ${RPC_URL} — używam go.`);
    }

    log("orchestrator", "🚀 Wdrażam świeży kontrakt BlackSwanOS (scripts/deploy.js)...");
    await runToCompletion(["hardhat", "run", "scripts/deploy.js", "--network", "localhost"], "deploy");

    log("orchestrator", "👀 Startuję wyrocznię (watcher.js) w tle, żeby nasłuchiwała zdarzeń...");
    spawnBackground(["hardhat", "run", "watcher.js", "--network", "localhost"], "watcher");

    // Krótka pauza, żeby watcher.js na pewno zdążył zarejestrować listenery
    // zanim simulate.js wygeneruje zdarzenia.
    await sleep(2500);

    log("orchestrator", "🧪 Odpalam pełną symulację sporu (simulate.js)...");
    await runToCompletion(["hardhat", "run", "simulate.js", "--network", "localhost"], "simulate");

    // simulate.js wysyła 3 transakcje w ciągu 1-2 sekund, ale watcher.js
    // wykrywa zdarzenia przez polling RPC (co ~1s) i dopiero PO wykryciu
    // wysyła wiadomość na Telegram (kolejne ~1s). Bez tej pauzy orchestrator
    // kończy się i zachęca do Ctrl+C zanim alerty dla SellerLocked i
    // DisputeRaised zdążą wyjść — w efekcie widać tylko część wiadomości
    // na Telegramie (albo żadnej dla sporu).
    log("orchestrator", "⏳ Czekam, aż wyrocznia dogoni i wyśle wszystkie alerty na Telegram (10s)...");
    await sleep(10000);

    log(
        "orchestrator",
        "🎉 Symulacja zakończona sukcesem! Wszystkie alerty (EscrowCreated, SellerLocked, DisputeRaised) powinny być już na Telegramie. Wyrocznia (watcher.js) nasłuchuje dalej — Ctrl+C, aby zakończyć wszystko."
    );
}

main().catch((error) => {
    console.error("❌ Orchestrator zakończony błędem:", error.message ?? error);
    cleanup();
    process.exit(1);
});
