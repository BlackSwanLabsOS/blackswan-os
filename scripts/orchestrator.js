#!/usr/bin/env node
/**
 * Orchestrator for the full local BlackSwanOS dispute simulation.
 *
 *   node scripts/orchestrator.js
 *
 * Automatically:
 *   1. Checks whether the local Hardhat node (127.0.0.1:8545) is already running.
 *      If not — starts `npx hardhat node --fork <Base RPC>`.
 *   2. Deploys a fresh BlackSwanOS contract (scripts/deploy.js) and writes its
 *      address to deployment.json and all service .env files.
 *   3. Starts the oracle (watcher.js) in the background to listen for events.
 *   4. Runs the full dispute simulation (simulate.js): USDC injection ->
 *      approve -> createEscrow -> sellerLock -> raiseDispute.
 *   5. Leaves the node and oracle running so you can watch live events. Ctrl+C
 *      shuts everything down cleanly (Hardhat node + watcher).
 *
 * Environment variables (optional):
 *   RPC_URL  - default http://127.0.0.1:8545
 *   FORK_URL - default https://mainnet.base.org
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

async function waitFor(conditionFn, { intervalMs = 500, timeoutMs = 90000, label = "condition" } = {}) {
    const start = Date.now();
    while (!(await conditionFn())) {
        if (Date.now() - start > timeoutMs) {
            throw new Error(`⏱️  Timed out waiting for: ${label}`);
        }
        await sleep(intervalMs);
    }
}

/** Run a process, wait for exit, throw if exit code != 0. */
function runToCompletion(args, tag) {
    return new Promise((resolve, reject) => {
        log(tag, `npx ${args.join(" ")}`);
        const child = spawn("npx", args, { cwd: ROOT_DIR, stdio: "inherit", shell: true });
        child.on("exit", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`Process "${tag}" exited with code ${code}`));
        });
        child.on("error", reject);
    });
}

/** Run a process in the background (e.g. Hardhat node, oracle) and return its handle. */
function spawnBackground(args, tag) {
    log(tag, `(background) npx ${args.join(" ")}`);
    const child = spawn("npx", args, { cwd: ROOT_DIR, stdio: "inherit", shell: true });
    child.tag = tag;
    children.push(child);
    child.on("exit", (code) => {
        if (!shuttingDown && code !== 0 && code !== null) {
            log(tag, `⚠️  background process exited unexpectedly (code ${code})`);
        }
    });
    return child;
}

function cleanup() {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const child of children) {
        if (child.killed || child.exitCode !== null) continue;
        log(child.tag ?? "proc", "🧹 stopping...");
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
    log("orchestrator", "🔎 Checking whether the local Hardhat node is already running...");
    const nodeAlreadyRunning = await isNodeUp();

    if (!nodeAlreadyRunning) {
        log("orchestrator", `🟢 Starting Hardhat node (fork: ${FORK_URL})...`);
        spawnBackground(["hardhat", "node", "--fork", FORK_URL], "hardhat-node");
        await waitFor(isNodeUp, { timeoutMs: 90000, label: "Hardhat node startup" });
        log("orchestrator", "✅ Hardhat node is up and responding at " + RPC_URL);
    } else {
        log("orchestrator", `✅ Hardhat node already running at ${RPC_URL} — reusing it.`);
    }

    log("orchestrator", "🚀 Deploying fresh BlackSwanOS (scripts/deploy.js)...");
    await runToCompletion(["hardhat", "run", "scripts/deploy.js", "--network", "localhost"], "deploy");

    log("orchestrator", "👀 Starting oracle (watcher.js) in the background to listen for events...");
    spawnBackground(["hardhat", "run", "watcher.js", "--network", "localhost"], "watcher");

    // Short pause so watcher.js can register listeners before simulate.js emits events.
    await sleep(2500);

    log("orchestrator", "🧪 Running full dispute simulation (simulate.js)...");
    await runToCompletion(["hardhat", "run", "simulate.js", "--network", "localhost"], "simulate");

    // simulate.js sends 3 transactions within 1–2 seconds, but watcher.js
    // detects events via RPC polling (~every 1s) and only then sends Telegram
    // (~another 1s). Without this pause the orchestrator finishes and prompts
    // Ctrl+C before SellerLocked and DisputeRaised alerts go out — you may only
    // see part of the Telegram messages (or none for the dispute).
    log("orchestrator", "⏳ Waiting for the oracle to catch up and send all Telegram alerts (10s)...");
    await sleep(10000);

    log(
        "orchestrator",
        "🎉 Simulation finished successfully! All alerts (EscrowCreated, SellerLocked, DisputeRaised) should be on Telegram. Oracle (watcher.js) keeps listening — Ctrl+C to shut everything down."
    );
}

main().catch((error) => {
    console.error("❌ Orchestrator failed:", error.message ?? error);
    cleanup();
    process.exit(1);
});
