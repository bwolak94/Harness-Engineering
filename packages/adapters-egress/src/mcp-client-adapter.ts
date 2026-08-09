/**
 * MCP client adapter — discovers tools from an MCP server and wraps them
 * as standard `Tool<unknown, unknown>` implementations.
 *
 * Pattern: Adapter (structural)
 * The MCP JSON-RPC 2.0 protocol is an external concern. This adapter translates
 * it into `ToolDefinition` + `Tool` so HarnessRuntime never needs to know about MCP.
 *
 * The MCP server is contacted through EgressPort so all SSRF/secret/claim-check
 * protections apply automatically.
 */

import type { ToolDefinition } from "@harness/contracts";
import type { EgressPort } from "@harness/core";
import type { Tool } from "@harness/core";
import { z } from "zod";

// ---------------------------------------------------------------------------
// MCP JSON-RPC types
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse<T = unknown> {
  jsonrpc: "2.0";
  id: number;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

interface McpToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

interface McpToolsListResult {
  tools: McpToolDescriptor[];
}

// ---------------------------------------------------------------------------
// Server config
// ---------------------------------------------------------------------------

export interface McpServerConfig {
  /** Base URL of the MCP JSON-RPC endpoint (e.g. https://tools.example.com/mcp). */
  url: string;
  /** Static headers (e.g. Authorization with {{secrets.X}} already resolved by EgressService). */
  headers?: Record<string, string>;
  /** Tenant ID for egress secret resolution. */
  tenantId: string;
  /** Allowlist for SSRF guard — should match the URL's hostname. */
  allowedHosts: string[];
}

// ---------------------------------------------------------------------------
// JSON-RPC helper
// ---------------------------------------------------------------------------

let idCounter = 1;

async function jsonRpc<T>(
  method: string,
  params: unknown,
  config: McpServerConfig,
  egress: EgressPort,
): Promise<T> {
  const id = idCounter++;
  const body: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
  const response = await egress.fetch({
    method: "POST",
    url: config.url,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...config.headers,
    },
    body: JSON.stringify(body),
    allowedHosts: config.allowedHosts,
    tenantId: config.tenantId,
    timeoutMs: 10_000,
  });

  let parsed: JsonRpcResponse<T>;
  try {
    parsed = JSON.parse(response.body) as JsonRpcResponse<T>;
  } catch {
    throw new Error(`MCP server returned non-JSON response: ${response.body.slice(0, 200)}`);
  }

  if (parsed.error) {
    throw new Error(`MCP error ${parsed.error.code}: ${parsed.error.message}`);
  }

  if (parsed.result === undefined) {
    throw new Error(`MCP response missing result for method '${method}'`);
  }

  return parsed.result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Discover tools from an MCP server and return them as `Tool[]`.
 *
 * Calls `tools/list`, maps each descriptor to a `ToolDefinition`, and returns
 * `Tool` implementations that call `tools/call` through the provided EgressPort.
 *
 * Zero changes to HarnessRuntime are needed — register the returned tools with
 * `InMemoryToolRegistry` (or any `ToolRegistryPort`) as normal.
 */
export async function createMcpTools(
  config: McpServerConfig,
  egress: EgressPort,
): Promise<Tool<unknown, unknown>[]> {
  const result = await jsonRpc<McpToolsListResult>("tools/list", {}, config, egress);

  return result.tools.map((descriptor) => mcpToolToTool(descriptor, config, egress));
}

function mcpToolToTool(
  descriptor: McpToolDescriptor,
  config: McpServerConfig,
  egress: EgressPort,
): Tool<unknown, unknown> {
  const definition: ToolDefinition = {
    name: descriptor.name,
    description: descriptor.description ?? descriptor.name,
    dangerous: false,
    idempotent: false, // conservative default
    costHint: "moderate",
    inputSchema: (descriptor.inputSchema as ToolDefinition["inputSchema"]) ?? { type: "object" },
    outputSchema: (descriptor.outputSchema as ToolDefinition["outputSchema"]) ?? { type: "object" },
  };

  return {
    definition,
    // Accept any object — MCP tools define their own schemas server-side
    inputSchema: z.unknown(),

    async execute(input: unknown): Promise<unknown> {
      interface McpCallResult {
        content: unknown[];
      }
      const result = await jsonRpc<McpCallResult>(
        "tools/call",
        { name: descriptor.name, arguments: input },
        config,
        egress,
      );

      // MCP tools/call returns content array; extract first text/json item
      if (Array.isArray(result.content) && result.content.length > 0) {
        const first = result.content[0] as { type?: string; text?: string; json?: unknown };
        if (first.type === "text" && first.text !== undefined) {
          try {
            return JSON.parse(first.text) as unknown;
          } catch {
            return first.text;
          }
        }
        if (first.type === "json") return first.json;
        return result.content;
      }

      return result;
    },
  };
}
