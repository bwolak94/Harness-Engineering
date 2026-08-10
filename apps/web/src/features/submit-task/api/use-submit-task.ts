import { useMutation } from "@tanstack/react-query";
import { API_BASE, DEV_TOKEN } from "../../../shared/config.js";

interface SubmitTaskArgs {
  goal: string;
  budget?: {
    maxTokens?: number;
    maxSteps?: number;
    maxWallClockMs?: number;
    maxCostUsd?: number;
  };
}

interface SubmitTaskResult {
  workflowId: string;
}

async function submitTask(args: SubmitTaskArgs): Promise<SubmitTaskResult> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (DEV_TOKEN) headers["authorization"] = `Bearer ${DEV_TOKEN}`;

  const res = await fetch(`${API_BASE}/workflows`, {
    method: "POST",
    headers,
    body: JSON.stringify(args),
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { detail?: string };
    throw new Error(body.detail ?? `HTTP ${res.status}`);
  }

  return res.json() as Promise<SubmitTaskResult>;
}

export function useSubmitTask() {
  return useMutation({ mutationFn: submitTask });
}
