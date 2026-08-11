import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { API_BASE, DEV_TOKEN } from "../../../shared/config.js";

// ---------------------------------------------------------------------------
// MCP Registry API
// ---------------------------------------------------------------------------

export interface RegisteredServer {
  url: string;
  tenantId: string;
  toolNames: string[];
  registeredAt: string;
}

export interface DiscoveredTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface DiscoverResult {
  url: string;
  count: number;
  tools: DiscoveredTool[];
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (DEV_TOKEN) h.authorization = `Bearer ${DEV_TOKEN}`;
  return h;
}

async function fetchServers(): Promise<RegisteredServer[]> {
  const res = await fetch(`${API_BASE}/mcp/servers`, { headers: headers() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { servers: RegisteredServer[] };
  return body.servers;
}

async function discoverServer(url: string): Promise<DiscoverResult> {
  const res = await fetch(`${API_BASE}/mcp/discover`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ url }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { detail?: string };
    throw new Error(body.detail ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<DiscoverResult>;
}

async function registerServer(url: string): Promise<{ registered: string[] }> {
  const res = await fetch(`${API_BASE}/mcp/register`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ url }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { detail?: string };
    throw new Error(body.detail ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<{ registered: string[] }>;
}

export function useMcpServers() {
  return useQuery({ queryKey: ["mcp-servers"], queryFn: fetchServers, staleTime: 10_000 });
}

export function useDiscoverServer() {
  return useMutation({ mutationFn: discoverServer });
}

export function useRegisterServer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: registerServer,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["mcp-servers"] }),
  });
}
