import type {
  HarnessEvent,
  ModelCompletedEvent,
  WorkflowCompletedEvent,
  WorkflowFailedEvent,
  WorkflowStartedEvent,
} from "@harness/contracts";
import { Fragment, useState } from "react";
import { useWorkflowStore } from "../../../entities/workflow/index.js";
import { cn } from "../../../shared/lib/cn.js";
import { Badge } from "../../../shared/ui/badge.js";

// ---------------------------------------------------------------------------
// Data derivation
// ---------------------------------------------------------------------------

interface WorkflowSummary {
  workflowId: string;
  goal: string;
  status: "completed" | "failed" | "halted" | "running";
  startAt: string;
  costUsd: number;
  tokensUsed: number;
  steps: number;
  durationMs: number;
  lastResponseText: string;
}

function deriveHistory(allEvents: readonly HarnessEvent[]): WorkflowSummary[] {
  const byId = new Map<string, HarnessEvent[]>();
  for (const e of allEvents) {
    const list = byId.get(e.workflowId) ?? [];
    list.push(e);
    byId.set(e.workflowId, list);
  }

  const summaries: WorkflowSummary[] = [];
  for (const [workflowId, events] of byId) {
    const started = events.find((e): e is WorkflowStartedEvent => e.type === "workflow.started");
    if (!started) continue;

    const completed = events.find(
      (e): e is WorkflowCompletedEvent => e.type === "workflow.completed",
    );
    const failed = events.find((e): e is WorkflowFailedEvent => e.type === "workflow.failed");

    const modelEvents = events.filter(
      (e): e is ModelCompletedEvent => e.type === "model.completed",
    );

    let status: WorkflowSummary["status"] = "running";
    let costUsd = 0;
    let tokensUsed = 0;
    let durationMs = 0;

    if (completed) {
      status = "completed";
      costUsd = completed.payload.totalCostUsd;
      durationMs = completed.payload.durationMs;
      tokensUsed = completed.payload.tokensUsed;
    } else if (failed) {
      status = failed.payload.budgetExceeded !== undefined ? "halted" : "failed";
    }

    const steps = events.filter((e) => e.type === "tool.called").length;
    const lastResponseText = modelEvents.at(-1)?.payload.text ?? "";

    summaries.push({
      workflowId,
      goal: started.payload.task.goal,
      status,
      startAt: started.at,
      costUsd,
      tokensUsed,
      steps,
      durationMs,
      lastResponseText,
    });
  }

  return summaries.sort((a, b) => new Date(b.startAt).getTime() - new Date(a.startAt).getTime());
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtDuration(ms: number): string {
  if (ms === 0) return "—";
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1_000)}s`;
}

const STATUS_VARIANT: Record<WorkflowSummary["status"], "success" | "error" | "warn" | "default"> =
  {
    completed: "success",
    failed: "error",
    halted: "warn",
    running: "default",
  };

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function HistoryPage() {
  const { allEvents } = useWorkflowStore();
  const history = deriveHistory(allEvents);
  const [expanded, setExpanded] = useState<string | null>(null);

  if (history.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
        <span className="text-5xl opacity-20">📋</span>
        <p className="text-sm text-[#52525b]">No workflow runs yet.</p>
        <p className="text-xs text-[#3f3f46]">
          Submit a task in the Inspector tab — it will appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl px-6 py-5">
        <h1 className="mb-4 text-xs font-semibold uppercase tracking-wider text-[#52525b]">
          Workflow History
          <span className="ml-2 font-mono text-[#3f3f46]">({history.length})</span>
        </h1>

        <div className="overflow-hidden rounded-md border border-border">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border bg-surface">
                {["Time", "Goal", "Status", "Steps", "Tokens", "Cost", "Duration"].map((h) => (
                  <th
                    key={h}
                    className={cn(
                      "px-3 py-2 text-xs font-medium text-[#52525b]",
                      ["Steps", "Tokens", "Cost", "Duration"].includes(h)
                        ? "text-right"
                        : "text-left",
                    )}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {history.map((run) => (
                <Fragment key={run.workflowId}>
                  <tr
                    onClick={() => setExpanded(expanded === run.workflowId ? null : run.workflowId)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ")
                        setExpanded(expanded === run.workflowId ? null : run.workflowId);
                    }}
                    tabIndex={0}
                    className={cn(
                      "cursor-pointer border-b border-border text-xs transition-colors last:border-b-0",
                      expanded === run.workflowId ? "bg-surface" : "hover:bg-surface/50",
                    )}
                  >
                    <td className="whitespace-nowrap px-3 py-2.5 font-mono text-[#52525b]">
                      {fmtTime(run.startAt)}
                    </td>
                    <td className="max-w-[260px] px-3 py-2.5">
                      <span className="block truncate text-white">{run.goal}</span>
                    </td>
                    <td className="px-3 py-2.5">
                      <Badge variant={STATUS_VARIANT[run.status]}>{run.status}</Badge>
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-[#52525b]">{run.steps}</td>
                    <td className="px-3 py-2.5 text-right font-mono text-[#52525b]">
                      {run.tokensUsed > 0 ? run.tokensUsed.toLocaleString() : "—"}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-[#52525b]">
                      {run.costUsd > 0 ? `$${run.costUsd.toFixed(4)}` : "—"}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono text-[#52525b]">
                      {fmtDuration(run.durationMs)}
                    </td>
                  </tr>
                  {expanded === run.workflowId && (
                    <tr className="border-b border-border last:border-b-0">
                      <td colSpan={7} className="bg-surface-2 px-4 py-3">
                        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[#3f3f46]">
                          Goal
                        </p>
                        <p className="mb-2 text-xs text-[#a1a1aa]">{run.goal}</p>
                        {run.lastResponseText && (
                          <>
                            <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[#3f3f46]">
                              Response
                            </p>
                            <p className="text-xs leading-relaxed text-[#a1a1aa]">
                              {run.lastResponseText}
                            </p>
                          </>
                        )}
                        <p className="mt-2 font-mono text-[10px] text-[#27272a]">
                          {run.workflowId}
                        </p>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
