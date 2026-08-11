import { useMutation, useQuery } from "@tanstack/react-query";
import { API_BASE, DEV_TOKEN } from "../../../shared/config.js";

// ---------------------------------------------------------------------------
// Flow API types (mirror the server's FlowSpec / FlowRunResult)
// ---------------------------------------------------------------------------

export interface FlowAgentStep {
  agentName: string;
  goalTemplate: string;
}

export interface FlowSpec {
  id: string;
  name: string;
  description: string;
  pattern: "parallel" | "sequential";
  steps: FlowAgentStep[];
}

export interface FlowStepOutcome {
  stepId: string;
  agentName: string;
  workflowId: string;
  status: "success" | "failed";
  result?: string;
  reason?: string;
}

export interface FlowRunResult {
  flowId: string;
  pattern: "parallel" | "sequential";
  parentWorkflowId: string;
  steps: FlowStepOutcome[];
  partial: boolean;
}

// ---------------------------------------------------------------------------
// API calls
// ---------------------------------------------------------------------------

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = {};
  if (DEV_TOKEN) h.authorization = `Bearer ${DEV_TOKEN}`;
  return h;
}

async function fetchFlows(): Promise<FlowSpec[]> {
  const res = await fetch(`${API_BASE}/flows`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { flows: FlowSpec[] };
  return body.flows;
}

async function runFlow(flowId: string, goal: string): Promise<FlowRunResult> {
  const res = await fetch(`${API_BASE}/flows/${flowId}/run`, {
    method: "POST",
    headers: { ...authHeaders(), "content-type": "application/json" },
    body: JSON.stringify({ goal }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { detail?: string };
    throw new Error(body.detail ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<FlowRunResult>;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export function useFlows() {
  return useQuery({ queryKey: ["flows"], queryFn: fetchFlows, staleTime: 300_000 });
}

export function useRunFlow() {
  return useMutation({
    mutationFn: ({ flowId, goal }: { flowId: string; goal: string }) => runFlow(flowId, goal),
  });
}
