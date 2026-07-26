# Open source scope

What belongs in the **public** GitHub SDK tree vs what stays **local / private**.

## Public (this repository)

| Path | Role |
|------|------|
| `contracts/` | Solidity escrow (`BlackSwanOS.sol`) + `MockUSDC` |
| `mcp_server/` | MCP plugin for AI agents (TypeScript source, ABI, env examples) |
| `scripts/` | Hardhat deploy / demo helpers |
| `hardhat.config.js`, `package.json` | Build & Sepolia network config |
| `docs/MCP_AGENT_DEMO.md` | Agent demo walkthrough |
| `docs/M2M_AGENT_FLOW.md` | M2M flow overview |
| `docs/GRANT_LIVE_DEMO_LOG.md` | Live Base Sepolia tx evidence |
| `docs/OPEN_SOURCE_SCOPE.md` | This file |
| `.env.example` | Root Hardhat env template (names only) |
| `.cursor/mcp.json.example` | Cursor MCP wiring template |
| `README.md`, `LICENSE` | Quick start + MIT |

## Private / local only (gitignored)

| Path | Why |
|------|-----|
| `oracle/` | Private AI Oracle operator stack (FastAPI + LLM) |
| `watcher.js`, `oracle_monitor.js`, `walletConnectService.js`, `lib/` | Telegram / ops monitoring |
| `.env`, `mcp_server/.env.buyer`, `mcp_server/.env.seller` | Private keys & RPC secrets |
| `oracle_state.db`, `venv/`, `node_modules/`, `artifacts/`, `cache/`, `mcp_server/dist/` | Local runtime / build output |
| `deployment.json`, `*_drill.json`, `*.log` | Local deploy / drill artifacts |
| `PRZED_MAINNETEM.md`, `AUDYT_*.md`, `SECURITY_AUDIT.md` | Personal Polish ops notes |
| `docs/MONITORING.md`, `docs/EMERGENCY_RESOLVE_RUNBOOK.md` | Operator runbooks |
| `.cursor/mcp.json` | Local Cursor config (copy from `.example`) |

## Dual-remote tip

- **Private remote:** comment out the “Operator stack” block in `.gitignore` so Oracle + watcher are versioned.
- **Public remote:** keep that block active (default) so only the SDK surface is pushed.
