import type { HarnessEvent } from "@harness/contracts";

// ---------------------------------------------------------------------------
// toMarkdown — convert a workflow's event stream to a Markdown transcript.
//
// Groups events from allEvents by workflowId. If workflowId is provided,
// only that workflow is exported; otherwise all workflows are included.
// ---------------------------------------------------------------------------

function fmtIso(iso: string): string {
  return new Date(iso).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "medium",
  });
}

function jsonBlock(value: unknown): string {
  return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

interface WorkflowMeta {
  workflowId: string;
  goal: string;
  status: string;
  startAt: string;
  totalCostUsd?: number;
  tokensUsed?: number;
  durationMs?: number;
  stepsCompleted?: number;
}

function exportWorkflow(events: readonly HarnessEvent[]): string {
  const meta: WorkflowMeta = {
    workflowId: events[0]?.workflowId ?? "unknown",
    goal: "",
    status: "running",
    startAt: events[0]?.at ?? new Date().toISOString(),
  };

  const sections: string[] = [];
  const toolArgs = new Map<string, unknown>();

  for (const e of events) {
    switch (e.type) {
      case "workflow.started":
        meta.goal = e.payload.task.goal;
        meta.startAt = e.at;
        break;

      case "workflow.completed":
        meta.status = "completed";
        meta.totalCostUsd = e.payload.totalCostUsd;
        meta.tokensUsed = e.payload.tokensUsed;
        meta.durationMs = e.payload.durationMs;
        meta.stepsCompleted = e.payload.stepsCompleted;
        break;

      case "workflow.failed":
        meta.status = e.payload.budgetExceeded !== undefined ? "halted" : "failed";
        break;

      case "model.completed":
        if (e.payload.text) {
          sections.push(`**Assistant** *(${fmtIso(e.at)})*\n\n${e.payload.text}`);
        }
        break;

      case "tool.called":
        toolArgs.set(e.payload.callId, e.payload.args);
        sections.push(
          `**Tool call**: \`${e.payload.toolName}\` *(${fmtIso(e.at)})*\n\n` +
            `Input:\n${jsonBlock(e.payload.args)}`,
        );
        break;

      case "tool.succeeded": {
        const last = sections.at(-1);
        if (last?.includes("Tool call")) {
          sections[sections.length - 1] =
            `${last ?? ""}\n\nOutput:\n${jsonBlock(e.payload.result)}`;
        } else {
          sections.push(`Tool result:\n${jsonBlock(e.payload.result)}`);
        }
        break;
      }

      case "tool.failed":
        sections.push(`**Tool failed**: ${e.payload.code} — ${e.payload.message}`);
        break;

      default:
        break;
    }
  }

  const durationSec = meta.durationMs !== undefined ? (meta.durationMs / 1_000).toFixed(1) : "—";

  const header = [
    "# Workflow Transcript",
    "",
    "| Field | Value |",
    "|---|---|",
    `| **ID** | \`${meta.workflowId}\` |`,
    `| **Status** | ${meta.status} |`,
    `| **Started** | ${fmtIso(meta.startAt)} |`,
    meta.durationMs !== undefined ? `| **Duration** | ${durationSec}s |` : null,
    meta.tokensUsed !== undefined ? `| **Tokens** | ${meta.tokensUsed.toLocaleString()} |` : null,
    meta.totalCostUsd !== undefined ? `| **Cost** | $${meta.totalCostUsd.toFixed(6)} |` : null,
    meta.stepsCompleted !== undefined ? `| **Steps** | ${meta.stepsCompleted} |` : null,
  ]
    .filter(Boolean)
    .join("\n");

  const goal = `## Goal\n\n${meta.goal}`;
  const conversation =
    sections.length > 0 ? `## Conversation\n\n${sections.join("\n\n---\n\n")}` : "";

  return [header, "", goal, "", conversation].filter(Boolean).join("\n\n");
}

export function toMarkdown(allEvents: readonly HarnessEvent[], workflowId?: string): string {
  const target = workflowId ? allEvents.filter((e) => e.workflowId === workflowId) : allEvents;

  if (target.length === 0) return "# Empty transcript\n\nNo events recorded.";

  // Group by workflowId preserving order
  const groups = new Map<string, HarnessEvent[]>();
  for (const e of target) {
    const list = groups.get(e.workflowId) ?? [];
    list.push(e);
    groups.set(e.workflowId, list);
  }

  return [...groups.values()].map(exportWorkflow).join("\n\n---\n\n");
}

export function downloadMarkdown(content: string, filename: string): void {
  const blob = new Blob([content], { type: "text/markdown; charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
