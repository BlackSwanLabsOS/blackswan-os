#!/usr/bin/env node
/**
 * BlackSwanOS MCP Server — Agent Interface
 *
 * Bridges autonomous AI agents to:
 *  - The BlackSwanOS escrow contract on Base / Base Sepolia
 *  - The Python Oracle for dispute payload validation
 *
 * Tools:
 *   - create_escrow   : buyer locks USDC
 *   - seller_lock     : seller locks 200% collateral + SHA-256 commitment
 *   - check_status    : read-only escrow state
 *   - raise_dispute   : on-chain dispute + Oracle POST (needs X-Oracle-Secret)
 *   - claim_funds     : happy-path release after disputeWindow
 *   - claim_resolved  : settle after Oracle verdict
 *
 * Run:
 *   npm run build && npm start
 *   npm run dev
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createEscrow } from "./tools/createEscrow.js";
import { sellerLock } from "./tools/sellerLock.js";
import { checkStatus } from "./tools/checkStatus.js";
import { raiseDispute } from "./tools/raiseDispute.js";
import { claimFunds } from "./tools/claimFunds.js";
import { claimResolved } from "./tools/claimResolved.js";

const server = new McpServer({
  name: "blackswanos-mcp-server",
  version: "1.1.0",
});

function jsonResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function jsonError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [
      { type: "text" as const, text: JSON.stringify({ error: message }, null, 2) },
    ],
    isError: true,
  };
}

server.tool(
  "create_escrow",
  "Create a BlackSwanOS escrow as Buyer. Locks payloadPrice + systemFee " +
    "(0.5% by default) in USDC and returns escrowId. Seller must call " +
    "seller_lock next. Price must meet on-chain minRequiredPrice(maxFileSize).",
  {
    sellerAddress: z
      .string()
      .describe("Seller wallet address (0x…, 20 bytes)"),
    payloadPriceUsdc: z
      .string()
      .describe('Trade price in USDC, e.g. "0.5" or "10.50"'),
    maxFileSizeBytes: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Max payload bytes (default = contract MAX 102400)"),
    disputeWindowSeconds: z
      .number()
      .int()
      .positive()
      .optional()
      .describe("Seconds after seller_lock for disputes (default MIN = 1h)"),
  },
  async ({
    sellerAddress,
    payloadPriceUsdc,
    maxFileSizeBytes,
    disputeWindowSeconds,
  }) => {
    try {
      return jsonResult(
        await createEscrow({
          sellerAddress,
          payloadPriceUsdc,
          maxFileSizeBytes,
          disputeWindowSeconds,
        })
      );
    } catch (error) {
      return jsonError(error);
    }
  }
);

server.tool(
  "seller_lock",
  "As Seller: lock 200% USDC collateral and commit SHA-256(raw payload bytes). " +
    "Payload string must be EXACT bytes you will deliver (no re-serialize). " +
    "After lock, parties may raise_dispute during disputeWindow, or anyone " +
    "may claim_funds once the window elapses.",
  {
    escrowId: z.string().describe("Escrow ID (decimal string)"),
    payload: z
      .string()
      .describe("Exact raw JSON payload text (byte-for-byte commitment)"),
  },
  async ({ escrowId, payload }) => {
    try {
      return jsonResult(await sellerLock({ escrowId, payload }));
    } catch (error) {
      return jsonError(error);
    }
  }
);

server.tool(
  "check_status",
  "Read on-chain escrow state (AWAITING_SELLER/LOCKED/DISPUTED/RESOLVED/CLAIMED), " +
    "outcome, amounts, payloadHash, disputeWindow. Read-only, no gas.",
  {
    escrowId: z.string().describe("Escrow ID (decimal string)"),
  },
  async ({ escrowId }) => {
    try {
      return jsonResult(await checkStatus({ escrowId }));
    } catch (error) {
      return jsonError(error);
    }
  }
);

server.tool(
  "raise_dispute",
  "Raise dispute on a LOCKED escrow (pays dispute bond) and POST the exact " +
    "raw payload to the Oracle for zero-trust validation + resolveDispute. " +
    "Requires Oracle running and ORACLE_HTTP_SECRET. After Oracle returns " +
    "RESOLVED_*, call claim_resolved to settle USDC.",
  {
    escrowId: z.string().describe("Escrow ID (decimal string)"),
    payload: z
      .string()
      .describe("Exact raw JSON bytes matching seller_lock commitment"),
  },
  async ({ escrowId, payload }) => {
    try {
      return jsonResult(await raiseDispute({ escrowId, payload }));
    } catch (error) {
      return jsonError(error);
    }
  }
);

server.tool(
  "claim_funds",
  "Happy-path release: call claimFunds after disputeWindow with no dispute. " +
    "Permissionless — this agent only needs ETH for gas. Pays seller + systemFee.",
  {
    escrowId: z.string().describe("Escrow ID (decimal string)"),
  },
  async ({ escrowId }) => {
    try {
      return jsonResult(await claimFunds({ escrowId }));
    } catch (error) {
      return jsonError(error);
    }
  }
);

server.tool(
  "claim_resolved",
  "After Oracle resolved a dispute (state RESOLVED), call claimResolved to " +
    "distribute USDC (includes always-on arbitrationFee to owner). Permissionless.",
  {
    escrowId: z.string().describe("Escrow ID (decimal string)"),
  },
  async ({ escrowId }) => {
    try {
      return jsonResult(await claimResolved({ escrowId }));
    } catch (error) {
      return jsonError(error);
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("BlackSwanOS MCP server running on stdio (v1.1.0)");
}

main().catch((error) => {
  console.error("Fatal error starting BlackSwanOS MCP server:", error);
  process.exit(1);
});
