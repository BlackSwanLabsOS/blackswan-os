/**
 * Thin HTTP client forwarding raw dispute payloads to the Python Oracle
 * (Phase 2). The MCP server never validates payloads itself — the Oracle
 * independently re-fetches escrow state on-chain and runs the full
 * zero-trust validation pipeline.
 */

import { config } from "./config.js";

export interface OracleDisputeResult {
  escrow_id: number;
  status: string;
  tx_hash?: string;
  step_failed?: string | null;
  reason?: string;
  skipped?: boolean;
}

export async function submitPayloadToOracle(
  escrowId: number,
  rawPayload: string
): Promise<OracleDisputeResult> {
  const url = `${config.oracleBaseUrl}/disputes/${escrowId}/payload`;

  if (!config.oracleHttpSecret) {
    throw new Error(
      "ORACLE_HTTP_SECRET missing in mcp_server/.env — required for POST /disputes/.../payload"
    );
  }

  const response = await fetch(url, {
    method: "POST",
    // Sent as opaque bytes — the Oracle reads request.body() directly
    // and never trusts a Content-Type-driven parse.
    headers: {
      "Content-Type": "application/octet-stream",
      "X-Oracle-Secret": config.oracleHttpSecret,
    },
    body: rawPayload,
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Oracle returned HTTP ${response.status} for escrow ${escrowId}: ${text}`
    );
  }

  return JSON.parse(text) as OracleDisputeResult;
}
