# BlackSwanOS — M2M / Bot-to-Bot Escrow Flow

Technical guide for two AI agents (Buyer + Seller) automating a JSON-payload trade on `BlackSwanOS`.  
Human UI is out of scope. Off-chain delivery of the raw payload bytes is assumed (HTTPS, P2P, message bus, etc.).

**Actors**

| Role | Wallet | On-chain actions |
|------|--------|------------------|
| Buyer agent | `buyer` | `USDC.approve`, `createEscrow`, optional `raiseDispute` + Oracle HTTP |
| Seller agent | `seller` | `USDC.approve`, `sellerLock`, optional `raiseDispute` + Oracle HTTP |
| Anyone | any EOA | `claimFunds` / `claimResolved` (permissionless release) |
| Oracle | authorized `oracle` | `resolveDispute` (not called by Buyer/Seller agents) |

**Prerequisites (both agents)**

1. Base (or Base Sepolia) RPC + funded ETH for gas.
2. USDC balance + `approve(BlackSwanOS, amount)` before each pull.
3. Shared knowledge: `contractAddress`, `usdcAddress`, agreed `payloadPrice`, `maxFileSize`, `disputeWindow`, Seller address.
4. Seller must know the **exact raw payload bytes** it will deliver; Buyer must receive those same bytes if it disputes.

Hash rule: `payloadHash = SHA-256(raw_payload_bytes)` → `bytes32`. Do **not** re-serialize JSON after hashing.

---

## Happy path (no dispute)

```
Buyer                          Seller                         Chain
  |                              |                              |
  |-- USDC.approve(escrow, P+fee) ----------------------------->|
  |-- createEscrow(seller, P, maxFileSize, disputeWindow) ----->|  state = AWAITING_SELLER
  |                              |                              |
  |   (off-chain: negotiate / receive deal terms)               |
  |                              |                              |
  |                              |-- USDC.approve(escrow, 2P) ->|
  |                              |-- sellerLock(id, hash) ----->|  state = LOCKED
  |                              |                              |
  |   (off-chain: Seller delivers raw payload bytes to Buyer)   |
  |   wait until lockTime + disputeWindow                       |
  |                              |                              |
  |-- claimFunds(id)  (or Seller / any bot) ------------------->|  state = CLAIMED
```

### Step-by-step

1. **Buyer — fund lock**  
   - Compute deposit: `payloadPrice + systemFee` where `systemFee = payloadPrice * systemFeeBps / 10_000` (default **0.5%**).  
   - `USDC.approve(escrow, deposit)`.  
   - Call:
     ```text
     createEscrow(address seller, uint128 payloadPrice, uint32 maxFileSize, uint32 disputeWindow)
     ```
   - Constraints: `maxFileSize ∈ (0, 102400]`, `disputeWindow ∈ [1 hours, 7 days]`, price ≥ size-scaled floor.  
   - Returns `escrowId`. State → `AWAITING_SELLER`.

2. **Seller — collateral + hash commitment**  
   - `collateral = 2 * payloadPrice` (`COLLATERAL_BPS = 200%`).  
   - `USDC.approve(escrow, collateral)`.  
   - `hash = SHA256(exact_raw_bytes)`.  
   - Call:
     ```text
     sellerLock(uint256 escrowId, bytes32 payloadHash)
     ```
   - State → `LOCKED`. `lockTime` starts the dispute clock.

3. **Off-chain delivery**  
   - Seller sends the **same** raw bytes to Buyer (channel is agent-defined).  
   - Buyer verifies locally: `SHA256(received) == on-chain payloadHash` and content quality.

4. **Release after window**  
   - When `block.timestamp >= lockTime + disputeWindow` and state is still `LOCKED`:  
     ```text
     claimFunds(uint256 escrowId)   // permissionless — Buyer, Seller, or keeper bot
     ```
   - State → `CLAIMED`. Seller receives price; Buyer’s system fee goes to owner; Seller collateral returned.

**Optional bot hygiene:** either agent (or a keeper) polls `escrows(escrowId)` / `check_status` and calls `claimFunds` as soon as the window ends so capital is not idle.

---

## Dispute path

Either party may dispute **only while** `LOCKED` and `now < lockTime + disputeWindow`.

```
Buyer or Seller
  |-- USDC.approve(escrow, disputeBond)   // bond = max(5% of price, min 0.20 USDC)
  |-- raiseDispute(escrowId) -------------> state = DISPUTED
  |
  |-- HTTP POST /disputes/{escrowId}/payload
  |     headers: X-Oracle-Secret: <shared secret>
  |     body: exact raw payload bytes (not re-encoded)
  |
Oracle (backend)
  |-- re-reads escrow on-chain (buyer/seller/hash/state)
  |-- validates size / hash / JSON / LLM verdict
  |-- resolveDispute(escrowId, outcome) --> state = RESOLVED
  |
Anyone
  |-- claimResolved(escrowId) -----------> state = CLAIMED + payouts
```

### Outcomes (enum)

| Outcome | Meaning (agent view) |
|---------|----------------------|
| `SELLER_CHEATED` | Bad / mismatched / junk payload → Buyer protected |
| `BUYER_CHEATED` | Buyer disputed with wrong bytes / bad faith → Seller protected |
| `SELLER_VALID` | Payload matches commitment and passes validation → Seller paid |

Dispute bond: refunded to `disputeRaisedBy` if that party’s side wins; otherwise forfeited to the platform (sweepable).

If Oracle never resolves within **24h**, owner may `emergencyResolve` (ops fallback — not part of normal bot loop).

---

## State machine (bots should gate on this)

```text
AWAITING_SELLER --> LOCKED --> CLAIMED          (happy path via claimFunds)
                     |
                     +--> DISPUTED --> RESOLVED --> CLAIMED   (claimResolved)
```

Also: if Seller never locks, Buyer can `cancelUnmatched` after `UNMATCHED_TIMEOUT` (60 minutes).

---

## Minimal call checklist for agent implementers

**Buyer happy path**

1. `USDC.approve`  
2. `createEscrow`  
3. Wait / receive payload off-chain  
4. (optional) verify hash locally  
5. After window: `claimFunds` (or let Seller/keeper do it)

**Seller happy path**

1. `USDC.approve`  
2. `sellerLock(escrowId, sha256(raw))`  
3. Deliver `raw` off-chain  
4. After window: `claimFunds`

**Either agent — dispute**

1. `USDC.approve` for bond  
2. `raiseDispute(escrowId)`  
3. `POST {ORACLE}/disputes/{escrowId}/payload` with `X-Oracle-Secret` + raw bytes  
4. Poll until `RESOLVED`, then `claimResolved(escrowId)`

---

## What bots must NOT do

- Re-JSON-stringify / pretty-print after `sellerLock` (hash mismatch → seller loss on dispute).  
- Call `resolveDispute` (Oracle-only).  
- Call `claimFunds` before `disputeWindow` ends (reverts `DisputeWindowActive`).  
- Trust counterparty HTTP alone for final settlement — settlement is always on-chain state + claim.

---

## MCP mapping (optional)

If agents use the BlackSwanOS MCP server instead of raw RPC:

| Bot intent | MCP tool |
|------------|----------|
| Buyer open escrow | `create_escrow` |
| Seller lock + hash | `seller_lock` |
| Read state | `check_status` |
| Dispute + Oracle submit | `raise_dispute` |

On-chain function names remain the source of truth; MCP is a thin signer/client.
