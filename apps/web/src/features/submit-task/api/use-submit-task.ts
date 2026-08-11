import { useMutation } from "@tanstack/react-query";
import { API_BASE, DEV_TOKEN } from "../../../shared/config.js";

interface SubmitTaskArgs {
  goal: string;
  multiAgent?: boolean;
  budget?: {
    maxTokens?: number;
    maxSteps?: number;
    maxWallClockMs?: number;
    maxCostUsd?: number;
  };
}

interface SubmitTaskResult {
  workflowId: string;
  selectedAgent?: string;
  routedBy?: "rule" | "llm" | "escalation";
}

async function submitTask(args: SubmitTaskArgs): Promise<SubmitTaskResult> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (DEV_TOKEN) headers.authorization = `Bearer ${DEV_TOKEN}`;

  const endpoint = args.multiAgent ? "/workflows/multi" : "/workflows";
  const { multiAgent: _, ...body } = args;

  const res = await fetch(`${API_BASE}${endpoint}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as { detail?: string };
    throw new Error(errBody.detail ?? `HTTP ${res.status}`);
  }

  return res.json() as Promise<SubmitTaskResult>;
}

export function useSubmitTask() {
  return useMutation({ mutationFn: submitTask });
}
