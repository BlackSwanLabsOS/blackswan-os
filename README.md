# BlackSwanOS

Trustless **M2M USDC escrow** on Base, with an **MCP server** so AI agents can create locks, dispute, and claim funds without a custom wallet UI.

- **Contract (Base Sepolia):** [`0xfB68d3f08F1398d110Bd600F44CFe8Bd63381Fa4`](https://sepolia.basescan.org/address/0xfB68d3f08F1398d110Bd600F44CFe8Bd63381Fa4)
- **USDC (Base Sepolia):** `0x036CbD53842c5426634e7929541eC2318f3dCF7e`
- **License:** MIT

This public tree is the **SDK / MCP plugin** surface (Solidity + agent tools + docs). The AI Oracle operator service is **not** included here — see [docs/OPEN_SOURCE_SCOPE.md](docs/OPEN_SOURCE_SCOPE.md).

## MCP tools

| Tool | Who | What |
|------|-----|------|
| `create_escrow` | Buyer | Lock price + fee, set payload size / dispute window |
| `seller_lock` | Seller | Lock collateral + commit `payloadHash` |
| `check_status` | Either | Read on-chain escrow state |
| `raise_dispute` | Buyer | Open dispute + post bond; upload payload to Oracle HTTP API |
| `claim_funds` | Either | Happy path after dispute window (no dispute) |
| `claim_resolved` | Either | Claim after Oracle `resolveDispute` |

## Quick Start (Cursor + MCP)

### 1. Clone and install

```bash
git clone https://github.com/YOUR_ORG/blackswanos.git
cd blackswanos
npm install
cd mcp_server && npm install && npm run build && cd ..
```

### 2. Env files (never commit real keys)

```bash
# Hardhat / scripts (optional for MCP-only)
cp .env.example .env

# Buyer + Seller MCP agents
cp mcp_server/.env.buyer.example mcp_server/.env.buyer
cp mcp_server/.env.seller.example mcp_server/.env.seller
```

Edit `mcp_server/.env.buyer` and `mcp_server/.env.seller`:

- `AGENT_PRIVATE_KEY` — funded Base Sepolia wallet (ETH for gas + test USDC)
- `RPC_URL` — your RPC endpoint
- `ORACLE_HTTP_SECRET` — shared secret if you use a dispute Oracle HTTP API
- `CONTRACT_ADDRESS` / `USDC_ADDRESS` — defaults point at the public Sepolia deploy

Fund test USDC from the [Circle faucet](https://faucet.circle.com/) (Base Sepolia).

### 3. Wire Cursor MCP

```bash
mkdir -p .cursor
cp .cursor/mcp.json.example .cursor/mcp.json
```

Reload MCP in Cursor (**Settings → MCP**). You should see `blackswan-buyer` and `blackswan-seller` healthy.

### 4. Run a happy-path demo with your agent

1. Buyer: `create_escrow` (seller address, e.g. `0.5` USDC, small `maxFileSizeBytes`)
2. Seller: `seller_lock` with the exact JSON payload string
3. Wait until `lockTime + disputeWindow` (1h on the public Sepolia deploy)
4. Either side: `claim_funds`
5. `check_status` → `CLAIMED`

Full walkthrough: [docs/MCP_AGENT_DEMO.md](docs/MCP_AGENT_DEMO.md)  
Flow overview: [docs/M2M_AGENT_FLOW.md](docs/M2M_AGENT_FLOW.md)  
Live tx log: [docs/GRANT_LIVE_DEMO_LOG.md](docs/GRANT_LIVE_DEMO_LOG.md)

## Dispute path

`raise_dispute` / `claim_resolved` need a running Oracle at `ORACLE_BASE_URL` (default `http://localhost:8000`) that implements the HTTP payload API and can call `resolveDispute` on-chain.

The reference Oracle is **operator-private** and is not shipped in this public repository. Point `ORACLE_BASE_URL` at your own Oracle, or use happy path (`claim_funds`) without disputes.

## Deploy your own contract (optional)

```bash
cp .env.example .env
# set PRIVATE_KEY, BASE_SEPOLIA_RPC_URL
npm install
npx hardhat compile
npm run deploy:sepolia
```

Update `CONTRACT_ADDRESS` in your MCP env files and `.cursor/mcp.json`.

## Security

- **Never commit** `.env`, `.env.buyer`, `.env.seller`, or private keys.
- Testnet keys are still secrets — rotate if exposed.
- On-chain only the **payload hash** is stored; raw JSON stays off-chain.

## Docs map

| Doc | Contents |
|-----|----------|
| [docs/OPEN_SOURCE_SCOPE.md](docs/OPEN_SOURCE_SCOPE.md) | Public vs private paths |
| [docs/MCP_AGENT_DEMO.md](docs/MCP_AGENT_DEMO.md) | Agent demo (happy + dispute) |
| [docs/M2M_AGENT_FLOW.md](docs/M2M_AGENT_FLOW.md) | Architecture / flow |
| [docs/GRANT_LIVE_DEMO_LOG.md](docs/GRANT_LIVE_DEMO_LOG.md) | Base Sepolia evidence |
