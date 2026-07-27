# BlackSwanOS MCP — 5-minute Agent Demo

Canonical M2M interface for Buyer / Seller AI agents on **Base Sepolia**.

**Contract:** `0xfB68d3f08F1398d110Bd600F44CFe8Bd63381Fa4`  
**Tools:** `create_escrow` → `seller_lock` → (`raise_dispute`) → `claim_funds` | `claim_resolved` + `check_status`

**Live grant evidence (tx hashes):** [`GRANT_LIVE_DEMO_LOG.md`](./GRANT_LIVE_DEMO_LOG.md) — happy path `#8`, MCP dispute `#6`, Plan B emergency `#7`.

---

## 0. Prerequisites

1. Oracle running (`cd oracle && python main.py`) — health shows new contract.
2. LM Studio up (only needed for dispute path).
3. MCP built: `cd mcp_server && npm run build`
4. Two agent wallets with Base Sepolia ETH + test USDC (Circle faucet).

Suggested wallets (already used in tests):

| Role | Address | Env for that MCP instance |
|------|---------|---------------------------|
| Buyer | `0xF8D925c76d543a5992D06DE510c4a6b59BC27053` | `AGENT_PRIVATE_KEY=<SEPOLIA_BUYER…>` |
| Seller | `0x8d99f6ab2D76e59Bc6d7C821d7a1df543696C7fB` | `AGENT_PRIVATE_KEY=<SEPOLIA_SELLER…>` |

Or keep the dedicated MCP agent key in `mcp_server/.env` and fund **that** address.

`ORACLE_HTTP_SECRET` must match `oracle/.env` (auto-fallback reads oracle/.env if missing).

### Cursor MCP config (project file)

**Where:** `blackswanos/.cursor/mcp.json`  
(already filled for this repo — Cursor merges it when the workspace is open)

Secrets live in gitignored env files, **not** in `mcp.json`:

```powershell
cd C:\Users\CAD-CAM\OneDrive\Pulpit\blackswanos\mcp_server
copy .env.buyer.example .env.buyer
copy .env.seller.example .env.seller
# edit both files: AGENT_PRIVATE_KEY + ORACLE_HTTP_SECRET (same as oracle/.env)
```

| File | Role |
|------|------|
| `.cursor/mcp.json` | public config (paths, contract, RPC) |
| `mcp_server/.env.buyer` | Buyer key + Oracle secret |
| `mcp_server/.env.seller` | Seller key + Oracle secret |

Then: **Cursor → Settings → MCP** → reload / restart Cursor, check green dots on `blackswan-buyer` and `blackswan-seller`.

Alternate (global): `%USERPROFILE%\.cursor\mcp.json` — same JSON, but prefer the project file so paths stay with the repo.

---

## A. Happy path (no dispute) — grant demo

Use a **tiny** declared file size so 0.15–0.5 USDC clears the price floor.

**Buyer agent**

1. `create_escrow`
   - `sellerAddress`: seller wallet
   - `payloadPriceUsdc`: `"0.5"`
   - `maxFileSizeBytes`: `2048`
   - (optional) `disputeWindowSeconds`: `3600`
2. Note `escrowId` from the result.

**Seller agent** (same payload string you will “deliver”)

```json
{"dataset":"demo_temps","records":[{"sensor_id":"A1","ts":"2026-07-25T12:00:00Z","celsius":4.2},{"sensor_id":"A1","ts":"2026-07-25T12:05:00Z","celsius":4.1}]}
```

3. `seller_lock` with `escrowId` + that exact `payload` string.
4. Off-chain: tell Buyer the same JSON (chat / HTTP / whatever).
5. Wait until `lockTime + disputeWindow` (1h on Sepolia) **or** for a faster demo temporarily use a local Hardhat deploy with shorter window.
6. Either agent: `claim_funds` with `escrowId`.
7. `check_status` → `CLAIMED`.

**Grant one-liner:** *“Two agents escrow a JSON dataset in USDC; after the window, funds auto-release without a human UI.”*

---

## B. Dispute path (Oracle + Llama)

1–3 as above (`create_escrow` → `seller_lock`).

4. Buyer (or Seller): `raise_dispute` with the **exact** payload string.
   - Pays dispute bond on-chain.
   - Oracle validates + `resolveDispute`.
5. Result should include Oracle status e.g. `RESOLVED_SELLER_VALID` or `RESOLVED_SELLER_CHEATED`.
6. Either agent: `claim_resolved`.
7. `check_status` → `CLAIMED` + outcome.

Injection / garbage payloads should land on `SELLER_CHEATED` (see `npm run security:oracle`).

---

## C. Agent decision cheat-sheet

| State | Buyer tools | Seller tools |
|-------|-------------|--------------|
| — | `create_escrow` | — |
| `AWAITING_SELLER` | `check_status` | `seller_lock` |
| `LOCKED` (in window) | `raise_dispute` / wait | `raise_dispute` / deliver |
| `LOCKED` (window over) | `claim_funds` | `claim_funds` |
| `DISPUTED` | wait Oracle / `check_status` | same |
| `RESOLVED` | `claim_resolved` | `claim_resolved` |
| `CLAIMED` | done | done |

---

## D. Smoke without Cursor

```bash
cd mcp_server
npm run build
# optional: node -e "import('./dist/index.js')"  # starts stdio MCP — use with MCP host
```

Hardhat still works for humans:

```bash
npm run happy:sepolia
npm run security:sepolia
```

---

## E. What’s intentionally out of MCP

- `resolveDispute` — Oracle wallet only (Python Oracle).
- `emergencyResolve` / `setFees` — owner ops, not agent commerce.
- Telegram watcher — ops alerts, not the M2M product surface.
