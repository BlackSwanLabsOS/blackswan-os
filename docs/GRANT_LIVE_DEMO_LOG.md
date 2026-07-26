# BlackSwanOS — live demo log (grant evidence)

**Network:** Base Sepolia (`84532`)  
**Contract:** [`0xfB68d3f08F1398d110Bd600F44CFe8Bd63381Fa4`](https://sepolia.basescan.org/address/0xfB68d3f08F1398d110Bd600F44CFe8Bd63381Fa4)  
**Interface:** Hardhat scripts + Cursor MCP agents → local Oracle (dispute path) → on-chain settle  

Testnet proof-of-flow for grant reviewers. Not a mainnet audit.

---

## Primary A — Escrow `#8` (happy path, no dispute)

**Narrative:** Buyer and seller lock USDC; after the dispute window with **no** `raiseDispute`, anyone calls `claimFunds` — seller is paid, system fee settles. No Oracle judgment.

**Script:** `npm run happy:full` → `scripts/test_happy_path.js`

| Step | Action | Result | Tx |
|------|--------|--------|-----|
| 1 | Buyer `createEscrow` | escrow `#8`, 0.5 USDC + fee | [`0x5a77979f…e5add6`](https://sepolia.basescan.org/tx/0x5a77979f858c77a23cce52bcbfdc96328cb42157cb8da9636e0c9dd3ade5add6) |
| 2 | Seller `sellerLock` | collateral 1.0 USDC, `LOCKED` | [`0xa39927d3…a9a973`](https://sepolia.basescan.org/tx/0xa39927d32d5d3e7023abe2bcbd9ddee12f903199209762d9a617f003bda9a973) |
| 3 | Wait `disputeWindow` (1h) | no dispute raised | — |
| 4 | `claimFunds` | **`CLAIMED`**, outcome `NONE` | [`0x83ddb584…aa8f9c`](https://sepolia.basescan.org/tx/0x83ddb584423d158a658901204f7efe6a66f6b928f284eaa9a7ad3834f0aa8f9c) |

**Final state:** `CLAIMED` / `NONE` (happy path)  
**payloadHash:** `0x6abffcd7777b2a4fc5910175a0c98c3fc35c110f7038d1aefe2366bbd61409ec`  
**Buyer:** `0xF8D925c76d543a5992D06DE510c4a6b59BC27053`  
**Seller:** `0x8d99f6ab2D76e59Bc6d7C821d7a1df543696C7fB`

---

## Primary B — Escrow `#6` (MCP + Oracle dispute, seller valid)

**Narrative:** Two MCP agents escrow a machine-telemetry JSON payload, raise a dispute, Oracle validates, funds settle via `claim_resolved`.

**Payload (off-chain; on-chain only SHA-256):**

```json
{
  "schema": "blackswanos.m2m.v1",
  "dataset": "machine_telemetry",
  "seller": "agent-seller",
  "records": [
    {"device_id": "CNC-01", "ts": "2026-07-25T21:00:00Z", "metric": "spindle_temp_c", "value": 42.1},
    {"device_id": "CNC-01", "ts": "2026-07-25T21:05:00Z", "metric": "spindle_temp_c", "value": 42.4}
  ]
}
```

| Step | Tool | Result | Tx |
|------|------|--------|-----|
| 1 | Buyer `create_escrow` | escrow `#6`, 0.5 USDC + 0.0025 fee | [`0x2ef4e6ad…e99f7a`](https://sepolia.basescan.org/tx/0x2ef4e6ad1ef0895af31b027939ab248900c1820a2e8bbd81105d13577be99f7a) |
| 2 | Seller `seller_lock` | 1.0 USDC collateral, `LOCKED` | [`0x60cbae68…052db7a`](https://sepolia.basescan.org/tx/0x60cbae68a2128b3e1ed01db346341b86b04255090ac20e821104dd9fa052db7a) |
| 3 | Buyer `raise_dispute` | 0.2 USDC bond | [`0x3111428e…a68be35`](https://sepolia.basescan.org/tx/0x3111428e34e95a3b6ed3650a717718774c2fc60f3a636c185d0e562c7a68be35) |
| 4 | Oracle `resolveDispute` | **`SELLER_VALID`** | [`0xb5189d0b…a51f307`](https://sepolia.basescan.org/tx/0xb5189d0b72d51817e876823f4217f76eb2eef8b883b678c1a09392a14a51f307) |
| 5 | Buyer `claim_resolved` | **`CLAIMED`** | [`0x9012e9fc…613b0b3`](https://sepolia.basescan.org/tx/0x9012e9fcfd7144e5bc53c4993e3171342830a913e5cc7b3221dff4c05613b0b3) |

**Final state:** `CLAIMED` / `SELLER_VALID`  
**payloadHash:** `0x966f0a5c543025b1218770a75775a4b7f7ba2573af7e3a3912f7f7c6a8c36544`

---

## Secondary — Escrow `#5` (invalid delivery / negative path)

Same MCP stack; non-JSON payload → Oracle **`SELLER_CHEATED`**. Useful as “bad payload loses” evidence.

Claim tx: [`0x42a50bf9…38ac0ec`](https://sepolia.basescan.org/tx/0x42a50bf969ae899f1fa0e1451c7333d036306b63c7f96585763328e4038ac0ec)

Note: raw payload bytes are **not** stored on-chain (only the hash).

---

## Grant form blurb (copy-paste)

> Live Base Sepolia demos on contract `0xfB68d3f08F1398d110Bd600F44CFe8Bd63381Fa4`: (A) happy path escrow **#8** — `createEscrow` → `sellerLock` → window → `claimFunds` → `CLAIMED` with no dispute; (B) MCP + Oracle escrow **#6** — dispute → `SELLER_VALID` → `claim_resolved`. Tx log: `docs/GRANT_LIVE_DEMO_LOG.md`. Agent interface: `docs/MCP_AGENT_DEMO.md`.

---

## Optional appendix

- Screenshot: Cursor MCP servers green + Agent tool calls  
- Contract page: [BaseScan](https://sepolia.basescan.org/address/0xfB68d3f08F1398d110Bd600F44CFe8Bd63381Fa4)  
- Flow docs: `docs/M2M_AGENT_FLOW.md`, `docs/MCP_AGENT_DEMO.md`  
- Happy-path script: `npm run happy:full`
