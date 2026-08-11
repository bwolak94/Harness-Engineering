import { useMutation, useQuery } from "@tanstack/react-query";
import { API_BASE, DEV_TOKEN } from "../../../shared/config.js";

// ---------------------------------------------------------------------------
// Sandbox API — direct tool invocation without a workflow
// ---------------------------------------------------------------------------

export interface SandboxTool {
  name: string;
  description: string;
  dangerous: boolean;
  idempotent: boolean;
  costHint: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  exampleInput?: Record<string, unknown>;
}

async function fetchTools(): Promise<SandboxTool[]> {
  const headers: Record<string, string> = {};
  if (DEV_TOKEN) headers.authorization = `Bearer ${DEV_TOKEN}`;

  const res = await fetch(`${API_BASE}/sandbox/tools`, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { tools: SandboxTool[] };
  return body.tools;
}

export interface InvokeResult {
  ok: true;
  result: unknown;
}

export interface InvokeError {
  ok: false;
  error: { code: string; message: string };
}

async function invokeTool(toolName: string, args: unknown): Promise<InvokeResult | InvokeError> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (DEV_TOKEN) headers.authorization = `Bearer ${DEV_TOKEN}`;

  const res = await fetch(`${API_BASE}/sandbox/invoke`, {
    method: "POST",
    headers,
    body: JSON.stringify({ toolName, args }),
  });

  return res.json() as Promise<InvokeResult | InvokeError>;
}

export function useSandboxTools() {
  return useQuery({ queryKey: ["sandbox-tools"], queryFn: fetchTools, staleTime: 60_000 });
}

export function useInvokeTool() {
  return useMutation({
    mutationFn: ({ toolName, args }: { toolName: string; args: unknown }) =>
      invokeTool(toolName, args),
  });
}
