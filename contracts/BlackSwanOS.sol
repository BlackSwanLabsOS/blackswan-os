// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title BlackSwanOS
 * @notice Trustless M2M escrow for JSON payload trades settled in USDC on Base.
 * @dev Payload delivery is off-chain; on-chain state commits to SHA-256(payload bytes).
 */
contract BlackSwanOS is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // -------------------------------------------------------------------------
    // Types
    // -------------------------------------------------------------------------

    /// @notice Escrow lifecycle states.
    /// @dev `AWAITING_SELLER` is intentionally first (index 0): a freshly
    ///      created `Escrow` struct always has its `state` set explicitly in
    ///      the same transaction as its creation (see `createEscrow`), so no
    ///      code path ever relies on the zero-value default meaning anything.
    enum EscrowState {
        AWAITING_SELLER,
        LOCKED,
        DISPUTED,
        RESOLVED,
        CLAIMED
    }

    /// @notice Oracle verdict after a dispute.
    enum DisputeOutcome {
        NONE,
        SELLER_CHEATED,
        BUYER_CHEATED,
        SELLER_VALID
    }

    /**
     * @notice Packed escrow record (O(1) per escrow, no iteration).
     * @dev Slot layout optimized: addresses + timestamps + amounts + hash + packed flags.
     */
    struct Escrow {
        address buyer;
        address seller;
        /// @notice Whoever called `raiseDispute` (buyer or seller); address(0) if never disputed.
        address disputeRaisedBy;
        uint64 createdAt;
        uint64 lockTime;
        uint64 disputeRaisedAt;
        uint128 payloadPrice;
        uint128 systemFeeSnapshot;
        uint128 arbitrationFeeSnapshot;
        uint128 sellerCollateral;
        /// @notice Hybrid dispute bond snapshotted at `raiseDispute` time — see
        ///         `_computeDisputeBond`. Refunded to `disputeRaisedBy` if their
        ///         claim is upheld, else forfeited.
        uint128 disputeBondSnapshot;
        /// @notice Buyer-declared ceiling (in bytes) for the payload the seller
        ///         may deliver, set at `createEscrow` time. Off-chain (Oracle)
        ///         uses this to reject oversized payload submissions BEFORE
        ///         buffering them into memory — see the DoS-mitigation audit
        ///         notes. Always in `(0, MAX_ALLOWED_FILE_SIZE]`.
        uint32 maxFileSize;
        /// @notice Buyer-chosen window (seconds) after `sellerLock` during which
        ///         either party may call `raiseDispute`; `claimFunds` (happy-path
        ///         auto-release, callable by ANYONE) only becomes available once
        ///         this window elapses with no dispute raised. Always in
        ///         `[MIN_DISPUTE_WINDOW, MAX_DISPUTE_WINDOW]` — set once at
        ///         `createEscrow` time and immutable afterwards.
        uint32 disputeWindow;
        bytes32 payloadHash;
        EscrowState state;
        DisputeOutcome outcome;
        /// @notice True if this escrow was settled by `emergencyResolve` (owner
        ///         fallback) instead of the normal oracle `resolveDispute` path.
        bool resolvedByFallbackArbiter;
    }

    // -------------------------------------------------------------------------
    // Constants
    // -------------------------------------------------------------------------

    /// @notice Bounds for the buyer-chosen, per-escrow `Escrow.disputeWindow`
    ///         (replaces the old fixed `DISPUTE_WINDOW = 5 minutes` constant —
    ///         see the audit notes on giving the buyer/AI oracle a realistic
    ///         amount of time to detect fraud before happy-path auto-release).
    uint256 public constant MIN_DISPUTE_WINDOW = 1 hours;
    uint256 public constant MAX_DISPUTE_WINDOW = 7 days;
    uint256 public constant UNMATCHED_TIMEOUT = 60 minutes;
    uint256 public constant EMERGENCY_TIMEOUT = 24 hours;
    uint256 public constant COLLATERAL_BPS = 20_000; // 200% = 2x payload price
    uint256 public constant BPS_DENOMINATOR = 10_000;
    /// @notice Initial `disputeBondBps` set in the constructor: 500 = 5%.
    uint256 public constant DEFAULT_DISPUTE_BOND_BPS = 500;
    /// @notice Initial `systemFeeBps` set in the constructor: 50 = 0.5%.
    uint256 public constant DEFAULT_SYSTEM_FEE_BPS = 50;
    /// @notice Initial `minDisputeBond` set in the constructor: 0.20 USDC (6 decimals).
    uint256 public constant DEFAULT_MIN_DISPUTE_BOND = 200_000;

    /// @notice Hard system-wide ceiling for `Escrow.maxFileSize` (DoS mitigation).
    ///         MUST match the Oracle's off-chain hard limit
    ///         (`oracle/config.py`: `max_payload_bytes`) — buyers can declare
    ///         a TIGHTER per-escrow cap via `createEscrow`, never a looser one.
    /// @dev Lowered from the original 500 KB: the raw payload is dumped whole
    ///      into a single LLM prompt (`oracle/llm/client.py`) with NO chunking.
    ///      500 KB of JSON is ~125-145k tokens — right at/over smaller models'
    ///      context windows (e.g. gpt-4o-mini's 128k) and needlessly expensive
    ///      on larger ones. 100 KB (~25-35k tokens) comfortably fits every
    ///      mainstream LLM context window with margin, and is still generous
    ///      for a structured JSON dataset.
    uint32 public constant MAX_ALLOWED_FILE_SIZE = 102_400; // 100 KB

    /// @notice Initial `minBasePrice` set in the constructor: 0.05 USDC (6 decimals).
    uint256 public constant DEFAULT_MIN_BASE_PRICE = 50_000;
    /// @notice Initial `pricePerKb` set in the constructor: 0.002 USDC per KB (6 decimals).
    uint256 public constant DEFAULT_PRICE_PER_KB = 2_000;

    // -------------------------------------------------------------------------
    // Immutable / config
    // -------------------------------------------------------------------------

    /// @notice Immutable USDC token (6 decimals on Base).
    IERC20 public immutable USDC;

    /// @notice Oracle backend authorized to resolve disputes.
    address public oracle;

    /// @notice System fee rate, in basis points of each escrow's `payloadPrice`
    ///         (10_000 = 100%; default 50 = 0.5%). Computed fresh per-escrow
    ///         at `createEscrow` time — see `_systemFeeSnapshot`-style
    ///         computation inline there — and snapshotted into
    ///         `Escrow.systemFeeSnapshot`, so a later `setFees` call NEVER
    ///         retroactively changes an already-created escrow's fee.
    ///         Configurable by the owner via `setFees`.
    uint256 public systemFeeBps;

    /// @notice Global arbitration fee (snapshotted per escrow at creation).
    uint128 public arbitrationFee;

    /// @notice Hybrid dispute-bond rate, in basis points of the DISPUTED escrow's
    ///         `payloadPrice` (10_000 = 100%). See `_computeDisputeBond`.
    ///         Configurable by the owner via `setDisputeBondParams`.
    uint256 public disputeBondBps;

    /// @notice Absolute floor for the dispute bond, in USDC base units — the
    ///         bond is never less than this, even for tiny-value escrows.
    ///         Configurable by the owner via `setDisputeBondParams`.
    uint256 public minDisputeBond;

    /// @notice Minimum flat price floor for ANY escrow, in USDC base units
    ///         (6 decimals) — see `_minRequiredPrice`. Configurable by the
    ///         owner via `setPricingParams`.
    uint256 public minBasePrice;

    /// @notice Per-declared-kilobyte surcharge added on top of `minBasePrice`,
    ///         in USDC base units — see `_minRequiredPrice`. Configurable by
    ///         the owner via `setPricingParams`.
    uint256 public pricePerKb;

    /// @notice Monotonic escrow identifier.
    uint256 public nextEscrowId;

    /// @notice Sum of all USDC currently locked in active (non-CLAIMED) escrows
    ///         — i.e. buyer deposits plus seller collateral not yet paid out.
    /// @dev Incremented in `createEscrow` (buyer deposit), `sellerLock` (seller
    ///      collateral), and `raiseDispute` (dispute bond, if any); decremented
    ///      back to the exact amount locked whenever an escrow reaches `CLAIMED`
    ///      (`claimFunds`, `claimResolved`, `emergencyResolve`, `cancelUnmatched`)
    ///      or whenever a dispute bond is settled (`_settleDisputeBond`).
    ///      Used by `sweepFees` to guarantee it can never touch funds that
    ///      belong to an active escrow.
    uint256 public totalLockedFunds;

    /// @notice escrowId => Escrow
    mapping(uint256 => Escrow) private escrows;

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error Unauthorized();
    error InvalidAddress();
    error InvalidAmount();
    error InvalidState();
    error DisputeWindowActive();
    error DisputeWindowExpired();
    error UnmatchedTimeoutNotReached();
    error EmergencyTimeoutNotReached();
    error AlreadyResolved();
    error EscrowNotFound();
    error NothingToSweep();
    error ExceedsFreeBalance();

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event EscrowCreated(
        uint256 indexed escrowId,
        address indexed buyer,
        address indexed seller,
        uint256 payloadPrice,
        uint256 systemFeeSnapshot,
        uint256 arbitrationFeeSnapshot,
        uint256 maxFileSize,
        uint256 disputeWindow
    );

    event SellerLocked(
        uint256 indexed escrowId,
        address indexed seller,
        bytes32 payloadHash,
        uint256 sellerCollateral,
        uint256 lockTime
    );

    event DisputeRaised(uint256 indexed escrowId, address indexed raisedBy, uint256 timestamp);

    event DisputeResolved(
        uint256 indexed escrowId,
        DisputeOutcome outcome,
        address indexed oracle
    );

    event Claimed(uint256 indexed escrowId, address indexed caller);

    /// @notice Emitted when the owner resolves a disputed escrow via the
    ///         fallback path (`emergencyResolve`) because the oracle missed
    ///         the 24h `EMERGENCY_TIMEOUT`. Distinct from `DisputeResolved` so
    ///         off-chain monitoring can always tell which arbiter actually decided.
    event EmergencyResolved(uint256 indexed escrowId, DisputeOutcome outcome, address indexed owner);

    event FeesUpdated(uint256 systemFee, uint256 arbitrationFee);

    event OracleUpdated(address indexed previousOracle, address indexed newOracle);

    event FeesSwept(address indexed token, address indexed to, uint256 amount);

    event DisputeBondParamsUpdated(uint256 previousBps, uint256 newBps, uint256 previousMinBond, uint256 newMinBond);

    /// @notice Emitted when the owner tunes the size-scaled minimum-price
    ///         formula (see `setPricingParams` / `_minRequiredPrice`).
    event PricingParamsUpdated(
        uint256 previousMinBasePrice,
        uint256 newMinBasePrice,
        uint256 previousPricePerKb,
        uint256 newPricePerKb
    );

    event DisputeBondPaid(uint256 indexed escrowId, address indexed payer, uint256 amount);

    /// @notice `refunded == true` => `payer` won their dispute and got the bond back.
    ///         `refunded == false` => bond forfeited to the platform (sweepable).
    event DisputeBondSettled(uint256 indexed escrowId, address indexed payer, bool refunded, uint256 amount);

    /// @notice Arbitration fee paid to `owner()` on EVERY dispute settlement
    ///         (`claimResolved` / `emergencyResolve`), regardless of verdict.
    ///         Sourced from forfeited dispute bond first, then seller collateral,
    ///         then payload price (capped to available escrow funds).
    event ArbitrationFeePaid(uint256 indexed escrowId, uint256 amount);

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    /**
     * @param usdc_ Immutable USDC token address on Base.
     * @param oracle_ Initial oracle (Python backend) address.
     * @param initialSystemFeeBps Initial system fee rate, in basis points of
     *        each escrow's `payloadPrice` (10_000 = 100%); e.g. 50 = 0.5%.
     * @param initialArbitrationFee Initial global arbitration fee (6-decimal USDC units).
     */
    constructor(
        address usdc_,
        address oracle_,
        uint256 initialSystemFeeBps,
        uint128 initialArbitrationFee
    ) Ownable(msg.sender) {
        if (usdc_ == address(0) || oracle_ == address(0)) revert InvalidAddress();
        if (initialSystemFeeBps > BPS_DENOMINATOR) revert InvalidAmount();

        USDC = IERC20(usdc_);
        oracle = oracle_;
        systemFeeBps = initialSystemFeeBps;
        arbitrationFee = initialArbitrationFee;
        disputeBondBps = DEFAULT_DISPUTE_BOND_BPS;
        minDisputeBond = DEFAULT_MIN_DISPUTE_BOND;
        minBasePrice = DEFAULT_MIN_BASE_PRICE;
        pricePerKb = DEFAULT_PRICE_PER_KB;
    }

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------

    /**
     * @notice Pause creation of NEW escrows. Existing withdrawals remain available.
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @notice Unpause escrow creation.
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @notice Update global fees for future escrows only. Already-created
     *         escrows keep whatever they snapshotted at `createEscrow` time
     *         — never affected retroactively (same non-retroactivity
     *         guarantee as `setDisputeBondParams`/`setPricingParams`).
     * @param newSystemFeeBps New system fee rate, in basis points of each
     *        escrow's `payloadPrice` (10_000 = 100%). Capped at
     *        `BPS_DENOMINATOR` to reject nonsensical values.
     * @param newArbitrationFee New arbitration fee amount.
     */
    function setFees(uint256 newSystemFeeBps, uint128 newArbitrationFee) external onlyOwner {
        if (newSystemFeeBps > BPS_DENOMINATOR) revert InvalidAmount();
        systemFeeBps = newSystemFeeBps;
        arbitrationFee = newArbitrationFee;
        emit FeesUpdated(newSystemFeeBps, newArbitrationFee);
    }

    /**
     * @notice Update the hybrid dispute-bond formula for FUTURE disputes only.
     *         Escrows already `DISPUTED` keep whatever bond they snapshotted
     *         in `raiseDispute` — never affected retroactively.
     * @dev Actual bond charged = `max(payloadPrice * newBps / 10_000, newMinBond)`,
     *      computed fresh per-escrow in `raiseDispute` (see `_computeDisputeBond`)
     *      — never a flat global amount.
     * @param newBps New rate in basis points of the escrow's `payloadPrice`
     *        (10_000 = 100%). Capped at `BPS_DENOMINATOR` (100%) to reject
     *        nonsensical values.
     * @param newMinBond New absolute floor, in USDC base units (6 decimals).
     */
    function setDisputeBondParams(uint256 newBps, uint256 newMinBond) external onlyOwner {
        if (newBps > BPS_DENOMINATOR) revert InvalidAmount();
        // Snapshotted into `Escrow.disputeBondSnapshot` (uint128) in `raiseDispute`.
        if (newMinBond > type(uint128).max) revert InvalidAmount();

        uint256 previousBps = disputeBondBps;
        uint256 previousMinBond = minDisputeBond;
        disputeBondBps = newBps;
        minDisputeBond = newMinBond;
        emit DisputeBondParamsUpdated(previousBps, newBps, previousMinBond, newMinBond);
    }

    /**
     * @notice Update the size-scaled minimum-price formula for FUTURE escrows
     *         only (see `_minRequiredPrice`). Escrows already created keep
     *         whatever `payloadPrice` they were created with — never affected
     *         retroactively.
     * @dev Anti-griefing economics: a buyer can declare up to
     *      `MAX_ALLOWED_FILE_SIZE` for the Oracle's off-chain size check, and
     *      a disputed payload of that size gets dumped whole into a single
     *      LLM prompt (`oracle/llm/client.py`) to reach a verdict — a real
     *      off-chain cost to whoever runs the Oracle. Without a floor, a
     *      near-zero `payloadPrice` escrow could still declare the full
     *      `maxFileSize` and force an expensive LLM call for a dispute bond
     *      of only `minDisputeBond` (see `_computeDisputeBond`) — cheap
     *      griefing of the Oracle's off-chain budget. This ties the minimum
     *      allowed `payloadPrice` to the declared `maxFileSize` instead.
     * @param newMinBasePrice New flat floor, in USDC base units (6 decimals),
     *        applied regardless of declared file size.
     * @param newPricePerKb New per-declared-kilobyte surcharge, in USDC base
     *        units, added on top of `newMinBasePrice`.
     */
    function setPricingParams(uint256 newMinBasePrice, uint256 newPricePerKb) external onlyOwner {
        uint256 previousMinBasePrice = minBasePrice;
        uint256 previousPricePerKb = pricePerKb;
        minBasePrice = newMinBasePrice;
        pricePerKb = newPricePerKb;
        emit PricingParamsUpdated(previousMinBasePrice, newMinBasePrice, previousPricePerKb, newPricePerKb);
    }

    /**
     * @notice Preview the minimum `payloadPrice` `createEscrow` will require
     *         for a given declared `maxFileSize`, using the CURRENT
     *         `minBasePrice`/`pricePerKb` — lets off-chain callers (wizard,
     *         MCP agent) quote a valid price to the user before sending a
     *         transaction that would otherwise revert.
     * @param maxFileSize Candidate declared ceiling (bytes) for `createEscrow`.
     */
    function minRequiredPrice(uint32 maxFileSize) external view returns (uint256) {
        return _minRequiredPrice(maxFileSize);
    }

    /**
     * @notice Rotate oracle address.
     * @param newOracle New oracle address.
     */
    function setOracleAddress(address newOracle) external onlyOwner {
        if (newOracle == address(0)) revert InvalidAddress();
        address previous = oracle;
        oracle = newOracle;
        emit OracleUpdated(previous, newOracle);
    }

    /**
     * @notice Sweep ERC20 tokens held by this contract to the Admin/Treasury.
     * @dev Under normal operation, fees are transferred directly to
     *      `owner()` at settlement time (see `_distributeHappyPath`,
     *      `_distributeResolved`) — this contract never accumulates a
     *      dedicated "fee balance" for those. `sweepFees` exists to rescue
     *      tokens that end up here outside that flow: USDC sent directly via
     *      raw `transfer` instead of through `createEscrow`/`sellerLock`,
     *      rounding dust, and — since the dispute-bond fix — forfeited
     *      dispute bonds from disputers who lost (see `_settleDisputeBond`),
     *      which are deliberately left in the contract rather than
     *      auto-transferred, and simply become part of the sweepable pool.
     *
     *      For `token == USDC`, the amount is hard-capped on-chain to
     *      `USDC.balanceOf(address(this)) - totalLockedFunds`, so the owner
     *      can never sweep USDC that belongs to an active (non-CLAIMED)
     *      escrow — regardless of what is assumed/known off-chain.
     *
     *      For any other token, `totalLockedFunds` does not apply (only
     *      USDC is ever locked into escrows), so the full balance remains
     *      sweepable — it can only be tokens sent here by mistake.
     *      Follows CEI and uses SafeERC20.
     * @param token ERC20 token address to sweep (typically USDC).
     * @param to Destination address for swept funds.
     * @param amount Amount to transfer, in the token's native decimals.
     */
    function sweepFees(address token, address to, uint256 amount)
        external
        onlyOwner
        nonReentrant
    {
        if (token == address(0) || to == address(0)) revert InvalidAddress();
        if (amount == 0) revert NothingToSweep();

        if (token == address(USDC)) {
            uint256 freeBalance = USDC.balanceOf(address(this)) - totalLockedFunds;
            if (amount > freeBalance) revert ExceedsFreeBalance();
        }

        IERC20(token).safeTransfer(to, amount);

        emit FeesSwept(token, to, amount);
    }

    // -------------------------------------------------------------------------
    // Escrow lifecycle
    // -------------------------------------------------------------------------

    /**
     * @notice Create a new escrow and lock buyer funds (payload price + snapshotted system fee).
     * @param seller Counterparty seller address.
     * @param payloadPrice Trade price in USDC base units (6 decimals).
     * @param maxFileSize Buyer-declared ceiling (bytes) for the payload the seller may deliver
     *        — DoS mitigation, enforced off-chain by the Oracle before it buffers a submitted
     *        payload into memory. Must be in `(0, MAX_ALLOWED_FILE_SIZE]`.
     * @param disputeWindow Seconds after `sellerLock` during which either party may
     *        `raiseDispute`; `claimFunds` only becomes callable once this elapses with
     *        no dispute. Must be in `[MIN_DISPUTE_WINDOW, MAX_DISPUTE_WINDOW]`.
     * @return escrowId New escrow identifier.
     */
    function createEscrow(address seller, uint128 payloadPrice, uint32 maxFileSize, uint32 disputeWindow)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 escrowId)
    {
        if (seller == address(0) || seller == msg.sender) revert InvalidAddress();
        if (payloadPrice == 0) revert InvalidAmount();
        if (maxFileSize == 0 || maxFileSize > MAX_ALLOWED_FILE_SIZE) revert InvalidAmount();
        if (disputeWindow < MIN_DISPUTE_WINDOW || disputeWindow > MAX_DISPUTE_WINDOW) {
            revert InvalidAmount();
        }
        // Size-scaled price floor — see `setPricingParams` NatSpec for the
        // anti-griefing rationale (cheap escrow + max declared file size
        // would otherwise force an expensive off-chain LLM judgment call
        // for a disproportionately small dispute bond).
        if (uint256(payloadPrice) < _minRequiredPrice(maxFileSize)) revert InvalidAmount();

        escrowId = nextEscrowId++;
        // BPS-based, computed fresh from THIS escrow's payloadPrice — never a
        // flat global amount. E.g. at the default 50 bps (0.5%), a 100 USDC
        // trade snapshots a 0.5 USDC fee. Cast to uint128 is always safe:
        // payloadPrice is itself uint128 and systemFeeBps is owner-capped at
        // BPS_DENOMINATOR (100%) in the constructor/setFees, so the product
        // can never exceed payloadPrice itself.
        uint128 feeSnapshot = uint128((uint256(payloadPrice) * systemFeeBps) / BPS_DENOMINATOR);
        uint128 arbSnapshot = arbitrationFee;
        uint256 buyerDeposit = uint256(payloadPrice) + uint256(feeSnapshot);

        Escrow storage e = escrows[escrowId];
        e.buyer = msg.sender;
        e.seller = seller;
        e.createdAt = uint64(block.timestamp);
        e.payloadPrice = payloadPrice;
        e.systemFeeSnapshot = feeSnapshot;
        e.arbitrationFeeSnapshot = arbSnapshot;
        e.maxFileSize = maxFileSize;
        e.disputeWindow = disputeWindow;
        e.state = EscrowState.AWAITING_SELLER;
        e.outcome = DisputeOutcome.NONE;

        totalLockedFunds += buyerDeposit;

        USDC.safeTransferFrom(msg.sender, address(this), buyerDeposit);

        emit EscrowCreated(
            escrowId,
            msg.sender,
            seller,
            payloadPrice,
            feeSnapshot,
            arbSnapshot,
            maxFileSize,
            disputeWindow
        );
    }

    /**
     * @notice Seller locks 200% collateral and commits SHA-256 hash of promised JSON bytes.
     * @param escrowId Target escrow.
     * @param payloadHash SHA-256 hash of raw payload bytes (pre-JSON-parse).
     */
    function sellerLock(uint256 escrowId, bytes32 payloadHash)
        external
        nonReentrant
    {
        Escrow storage e = escrows[escrowId];

        if (e.buyer == address(0)) revert EscrowNotFound();
        if (e.state != EscrowState.AWAITING_SELLER) revert InvalidState();
        if (msg.sender != e.seller) revert Unauthorized();
        if (payloadHash == bytes32(0)) revert InvalidAmount();

        uint128 collateral = _sellerCollateral(e.payloadPrice);
        uint64 currentTime = uint64(block.timestamp);

        e.payloadHash = payloadHash;
        e.sellerCollateral = collateral;
        e.lockTime = currentTime;
        e.state = EscrowState.LOCKED;

        totalLockedFunds += collateral;

        USDC.safeTransferFrom(msg.sender, address(this), collateral);

        emit SellerLocked(escrowId, msg.sender, payloadHash, collateral, currentTime);
    }

    /**
     * @notice Raise a dispute during the buyer-chosen `disputeWindow` after both parties lock.
     * @param escrowId Target escrow.
     */
    function raiseDispute(uint256 escrowId) external nonReentrant {
        Escrow storage e = escrows[escrowId];

        if (e.buyer == address(0)) revert EscrowNotFound();
        if (e.state != EscrowState.LOCKED) revert InvalidState();
        if (msg.sender != e.buyer && msg.sender != e.seller) revert Unauthorized();
        if (block.timestamp >= e.lockTime + e.disputeWindow) revert DisputeWindowExpired();

        uint128 bond = _computeDisputeBond(e.payloadPrice);

        e.state = EscrowState.DISPUTED;
        e.disputeRaisedAt = uint64(block.timestamp);
        e.disputeRaisedBy = msg.sender;
        e.disputeBondSnapshot = bond;

        if (bond > 0) {
            totalLockedFunds += bond;
        }

        emit DisputeRaised(escrowId, msg.sender, block.timestamp);

        // Interaction (token pull) last, per CEI — all state above is already committed.
        if (bond > 0) {
            USDC.safeTransferFrom(msg.sender, address(this), bond);
            emit DisputeBondPaid(escrowId, msg.sender, bond);
        }
    }

    /**
     * @notice Oracle records a dispute verdict (state → RESOLVED). Does NOT move
     *         USDC — settlement (including the always-on `arbitrationFee`) happens
     *         in `claimResolved` / `emergencyResolve` via `_distributeResolved`.
     * @param escrowId Target escrow.
     * @param outcome Verdict enum.
     */
    function resolveDispute(uint256 escrowId, DisputeOutcome outcome)
        external
        nonReentrant
    {
        if (msg.sender != oracle) revert Unauthorized();

        Escrow storage e = escrows[escrowId];
        if (e.buyer == address(0)) revert EscrowNotFound();
        if (e.state == EscrowState.RESOLVED || e.state == EscrowState.CLAIMED) {
            revert AlreadyResolved();
        }
        if (e.state != EscrowState.DISPUTED) revert InvalidState();
        if (
            outcome != DisputeOutcome.SELLER_CHEATED &&
            outcome != DisputeOutcome.BUYER_CHEATED &&
            outcome != DisputeOutcome.SELLER_VALID
        ) {
            revert InvalidState();
        }

        e.state = EscrowState.RESOLVED;
        e.outcome = outcome;

        emit DisputeResolved(escrowId, outcome, msg.sender);
    }

    /**
     * @notice Happy-path fund distribution after the buyer-chosen `disputeWindow`
     *         elapses with no dispute. Permissionless by design (callable by
     *         ANYONE, not just the seller) — this is the escrow's built-in
     *         auto-release: capital can never be held hostage waiting for the
     *         buyer, since the seller (or anyone else) can trigger payout
     *         themselves the instant the window closes.
     * @param escrowId Target escrow.
     */
    function claimFunds(uint256 escrowId) external nonReentrant {
        Escrow storage e = escrows[escrowId];

        if (e.buyer == address(0)) revert EscrowNotFound();
        if (e.state != EscrowState.LOCKED) revert InvalidState();
        if (block.timestamp < e.lockTime + e.disputeWindow) revert DisputeWindowActive();

        e.state = EscrowState.CLAIMED;
        totalLockedFunds -= uint256(e.payloadPrice) + uint256(e.systemFeeSnapshot) + uint256(e.sellerCollateral);

        _distributeHappyPath(e);

        emit Claimed(escrowId, msg.sender);
    }

    /**
     * @notice Claim funds after oracle resolution.
     * @param escrowId Target escrow.
     */
    function claimResolved(uint256 escrowId) external nonReentrant {
        Escrow storage e = escrows[escrowId];

        if (e.buyer == address(0)) revert EscrowNotFound();
        if (e.state != EscrowState.RESOLVED) revert InvalidState();

        e.state = EscrowState.CLAIMED;

        // `_distributeResolved` decrements `totalLockedFunds` for both the base
        // escrow amount and the dispute bond (see its NatSpec) — kept there so
        // `emergencyResolve` gets identical accounting for free.
        _distributeResolved(escrowId, e);

        emit Claimed(escrowId, msg.sender);
    }

    /**
     * @notice Fallback arbiter: dead man's switch for when the oracle (AI agent)
     *         fails to call `resolveDispute` within 24 hours of a dispute being
     *         raised (API outage, rate-limit exhaustion, or a deliberate DoS
     *         attempt by whichever party stands to gain from a stalled oracle).
     * @dev Deliberately performs the *exact same* verdict-based distribution as
     *      the normal oracle path (`resolveDispute` + `claimResolved`), via the
     *      shared `_distributeResolved` — including dispute-bond settlement.
     *      This replaces the old `emergencyUnlock`, which returned each party's
     *      own principal unconditionally regardless of fault. That made
     *      deliberately stalling the oracle *strictly more profitable* than
     *      losing a correctly-resolved dispute for whichever party was in the
     *      wrong — see the audit notes. `emergencyResolve` removes that
     *      incentive entirely: the outcome is identical whether the oracle
     *      answers in time or the owner has to step in.
     * @param escrowId Target escrow.
     * @param outcome Verdict enum — same semantics as `resolveDispute`.
     */
    function emergencyResolve(uint256 escrowId, DisputeOutcome outcome) external onlyOwner nonReentrant {
        Escrow storage e = escrows[escrowId];

        if (e.buyer == address(0)) revert EscrowNotFound();
        if (e.state != EscrowState.DISPUTED) revert InvalidState();
        if (block.timestamp < e.disputeRaisedAt + EMERGENCY_TIMEOUT) {
            revert EmergencyTimeoutNotReached();
        }
        if (
            outcome != DisputeOutcome.SELLER_CHEATED &&
            outcome != DisputeOutcome.BUYER_CHEATED &&
            outcome != DisputeOutcome.SELLER_VALID
        ) {
            revert InvalidState();
        }

        e.state = EscrowState.CLAIMED;
        e.outcome = outcome;
        e.resolvedByFallbackArbiter = true;

        _distributeResolved(escrowId, e);

        emit EmergencyResolved(escrowId, outcome, msg.sender);
        emit Claimed(escrowId, msg.sender);
    }

    /**
     * @notice Withdraw if counterparty never joins within 60 minutes.
     * @param escrowId Target escrow.
     */
    function cancelUnmatched(uint256 escrowId) external nonReentrant {
        Escrow storage e = escrows[escrowId];

        if (e.buyer == address(0)) revert EscrowNotFound();
        if (e.state != EscrowState.AWAITING_SELLER) revert InvalidState();
        if (block.timestamp < e.createdAt + UNMATCHED_TIMEOUT) revert UnmatchedTimeoutNotReached();

        e.state = EscrowState.CLAIMED;
        // Seller never locked in this state (AWAITING_SELLER), so only the
        // buyer's deposit — never any collateral — was ever added to totalLockedFunds.
        totalLockedFunds -= uint256(e.payloadPrice) + uint256(e.systemFeeSnapshot);

        USDC.safeTransfer(e.buyer, uint256(e.payloadPrice) + uint256(e.systemFeeSnapshot));

        emit Claimed(escrowId, msg.sender);
    }

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    function getEscrow(uint256 escrowId) external view returns (Escrow memory) {
        Escrow memory e = escrows[escrowId];
        if (e.buyer == address(0)) revert EscrowNotFound();
        return e;
    }

    // -------------------------------------------------------------------------
    // Internal distribution
    // -------------------------------------------------------------------------

    function _sellerCollateral(uint128 payloadPrice) internal pure returns (uint128) {
        return uint128((uint256(payloadPrice) * COLLATERAL_BPS) / BPS_DENOMINATOR);
    }

    /**
     * @dev `minBasePrice + pricePerKb * ceil(maxFileSize / 1024)` — "started
     *      kilobyte" billing (1 byte already counts as a full KB), computed
     *      fresh from the CURRENT `minBasePrice`/`pricePerKb` at
     *      `createEscrow` time. Unlike the dispute bond, this is never
     *      snapshotted per-escrow: once created, an escrow's `payloadPrice`
     *      is fixed anyway, so there is nothing to retroactively protect —
     *      `setPricingParams` only ever affects escrows created AFTER the change.
     */
    function _minRequiredPrice(uint32 maxFileSize) internal view returns (uint256) {
        uint256 kb = (uint256(maxFileSize) + 1023) / 1024;
        return minBasePrice + pricePerKb * kb;
    }

    /**
     * @dev Hybrid dispute bond: `max(payloadPrice * disputeBondBps / 10_000, minDisputeBond)`.
     *      Computed fresh at `raiseDispute` time from the CURRENT `disputeBondBps` /
     *      `minDisputeBond` and THIS escrow's `payloadPrice` — never a flat global
     *      amount — then immediately snapshotted into `Escrow.disputeBondSnapshot`
     *      so later owner changes via `setDisputeBondParams` never retroactively
     *      affect an already-open dispute.
     */
    function _computeDisputeBond(uint128 payloadPrice) internal view returns (uint128) {
        uint256 percentageBond = (uint256(payloadPrice) * disputeBondBps) / BPS_DENOMINATOR;
        uint256 bond = percentageBond > minDisputeBond ? percentageBond : minDisputeBond;
        // `payloadPrice` is uint128 and `disputeBondBps` is owner-capped at
        // `BPS_DENOMINATOR` (100%) in `setDisputeBondParams`, so `percentageBond`
        // can never exceed `payloadPrice` itself (already uint128) — this clamp
        // only guards against a pathologically large `minDisputeBond` setting.
        if (bond > type(uint128).max) bond = type(uint128).max;
        return uint128(bond);
    }

    function _distributeHappyPath(Escrow storage e) internal {
        USDC.safeTransfer(e.seller, uint256(e.payloadPrice));
        USDC.safeTransfer(e.seller, uint256(e.sellerCollateral));
        USDC.safeTransfer(owner(), uint256(e.systemFeeSnapshot));
    }

    /**
     * @dev Shared verdict-execution for `claimResolved` and `emergencyResolve`.
     *
     *      M2M economics (S-03 fix): `arbitrationFeeSnapshot` is ALWAYS paid to
     *      `owner()` on dispute settlement — every verdict costs Oracle work.
     *
     *      Funding order: forfeited dispute bond → seller collateral → payload price.
     *      `totalLockedFunds` unlocked for price+fee+collateral+bond up front;
     *      leftover forfeited bond (after arb skim) stays sweepable.
     */
    function _distributeResolved(uint256 escrowId, Escrow storage e) internal {
        DisputeOutcome outcome = e.outcome;
        if (
            outcome != DisputeOutcome.SELLER_CHEATED &&
            outcome != DisputeOutcome.BUYER_CHEATED &&
            outcome != DisputeOutcome.SELLER_VALID
        ) {
            revert InvalidState();
        }

        uint256 price = uint256(e.payloadPrice);
        uint256 systemFee = uint256(e.systemFeeSnapshot);
        uint256 collateral = uint256(e.sellerCollateral);
        uint256 bond = uint256(e.disputeBondSnapshot);

        totalLockedFunds -= price + systemFee + collateral;
        if (bond > 0) totalLockedFunds -= bond;

        bool raiserWon = _disputeRaiserWon(e, bond);
        (collateral, price) = _collectArbitrationFee(escrowId, e, collateral, price, bond, raiserWon);
        _payDisputeBond(escrowId, e, bond, raiserWon);
        _payDisputePrincipals(e, outcome, price, collateral);

        if (systemFee > 0) {
            USDC.safeTransfer(owner(), systemFee);
        }
    }

    function _disputeRaiserWon(Escrow storage e, uint256 bond) internal view returns (bool) {
        if (bond == 0) return false;
        bool sellerCheated = e.outcome == DisputeOutcome.SELLER_CHEATED;
        return (e.disputeRaisedBy == e.buyer) ? sellerCheated : !sellerCheated;
    }

    /**
     * @dev Always-on arb fee → owner. Returns residual collateral/price after skim.
     */
    function _collectArbitrationFee(
        uint256 escrowId,
        Escrow storage e,
        uint256 collateral,
        uint256 price,
        uint256 bond,
        bool raiserWon
    ) internal returns (uint256 collateralOut, uint256 priceOut) {
        uint256 arbDue = uint256(e.arbitrationFeeSnapshot);
        if (arbDue == 0) return (collateral, price);

        uint256 fromBond = 0;
        if (!raiserWon && bond > 0) {
            fromBond = arbDue > bond ? bond : arbDue;
            arbDue -= fromBond;
        }

        uint256 fromPool;
        (collateralOut, priceOut, fromPool) = _deductArbitration(collateral, price, arbDue);

        uint256 arbPaid = fromBond + fromPool;
        if (arbPaid > 0) {
            USDC.safeTransfer(owner(), arbPaid);
            emit ArbitrationFeePaid(escrowId, arbPaid);
        }
    }

    function _payDisputeBond(
        uint256 escrowId,
        Escrow storage e,
        uint256 bond,
        bool raiserWon
    ) internal {
        if (bond == 0) return;
        if (raiserWon) {
            USDC.safeTransfer(e.disputeRaisedBy, bond);
        }
        emit DisputeBondSettled(escrowId, e.disputeRaisedBy, raiserWon, bond);
    }

    function _payDisputePrincipals(
        Escrow storage e,
        DisputeOutcome outcome,
        uint256 price,
        uint256 collateral
    ) internal {
        address to = (outcome == DisputeOutcome.SELLER_CHEATED) ? e.buyer : e.seller;
        if (price > 0) USDC.safeTransfer(to, price);
        if (collateral > 0) USDC.safeTransfer(to, collateral);
    }

    /// @dev Deduct `arb` from `collateral` first, then `price`. Caps to available.
    function _deductArbitration(
        uint256 collateral,
        uint256 price,
        uint256 arb
    ) internal pure returns (uint256 collateralOut, uint256 priceOut, uint256 arbPaid) {
        if (arb == 0) return (collateral, price, 0);

        uint256 available = collateral + price;
        arbPaid = arb > available ? available : arb;

        if (arbPaid <= collateral) {
            return (collateral - arbPaid, price, arbPaid);
        }

        return (0, price - (arbPaid - collateral), arbPaid);
    }
}