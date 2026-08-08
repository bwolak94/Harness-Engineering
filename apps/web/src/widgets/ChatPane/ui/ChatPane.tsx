import type { HarnessEvent } from "@harness/contracts";
import type { WorkflowState } from "@harness/core";
import { SubmitForm } from "../../../features/submit-task/index.js";
import { cn } from "../../../shared/lib/cn.js";
import { Badge } from "../../../shared/ui/badge.js";

// ---------------------------------------------------------------------------
// ChatPane — left panel: task submission + status summary
// (Pattern: Container / Presentational — presentational, gets all data as props)
// ---------------------------------------------------------------------------

interface StepSummaryProps {
  events: HarnessEvent[];
}

function StepSummary({ events }: StepSummaryProps) {
  const toolCalls = events.filter((e) => e.type === "tool.called");
  const succeeded = events.filter((e) => e.type === "tool.succeeded").length;
  const failed = events.filter((e) => e.type === "tool.failed").length;

  if (toolCalls.length === 0) return null;

  return (
    <div className="space-y-1 mt-2">
      {toolCalls.map((e) => {
        if (e.type !== "tool.called") return null;
        const didSucceed = events.some(
          (x) => x.type === "tool.succeeded" && x.payload.callId === e.payload.callId,
        );
        const didFail = events.some(
          (x) => x.type === "tool.failed" && x.payload.callId === e.payload.callId,
        );
        const status: "running" | "done" | "error" = didSucceed
          ? "done"
          : didFail
            ? "error"
            : "running";

        return (
          <div key={e.id} className="flex items-center gap-2 text-xs">
            <span
              className={cn(
                "h-1.5 w-1.5 rounded-full shrink-0",
                status === "done" && "bg-ev-success",
                status === "error" && "bg-ev-error",
                status === "running" && "bg-accent animate-pulse",
              )}
            />
            <span className="font-mono text-[#a1a1aa] truncate">{e.payload.toolName}</span>
          </div>
        );
      })}
      <p className="text-xs text-[#52525b] mt-1">
        {succeeded} ok · {failed} err · {toolCalls.length - succeeded - failed} running
      </p>
    </div>
  );
}

interface ChatPaneProps {
  state: WorkflowState | null;
  events: HarnessEvent[];
  onWorkflowStarted: (workflowId: string) => void;
  className?: string;
}

export function ChatPane({ state, events, onWorkflowStarted, className }: ChatPaneProps) {
  const result = state?.status === "completed" ? (state.result as string | null | undefined) : null;
  const error = state?.status === "failed" || state?.status === "halted" ? state.error : null;

  return (
    <div className={cn("flex flex-col h-full bg-surface border-r border-border", className)}>
      {/* Header */}
      <div className="border-b border-border px-4 py-3 shrink-0">
        <h1 className="text-sm font-semibold text-white tracking-tight">Harness Inspector</h1>
        <p className="text-xs text-[#52525b] mt-0.5">AI agent execution trace</p>
      </div>

      {/* Status */}
      {state && (
        <div className="border-b border-border px-4 py-3 shrink-0 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-xs text-[#52525b]">Workflow</span>
            <span className="font-mono text-xs text-[#a1a1aa] truncate max-w-[160px]">
              {state.workflowId}
            </span>
            <StatusBadge status={state.status} />
          </div>

          <div className="grid grid-cols-3 gap-2 text-xs">
            <Stat label="Steps" value={state.budget.stepsCompleted} />
            <Stat label="Tokens" value={state.budget.tokensUsed} />
            <Stat label="Cost" value={`$${state.budget.costUsd.toFixed(4)}`} />
          </div>

          <StepSummary events={events} />
        </div>
      )}

      {/* Result / error */}
      {result && (
        <div className="border-b border-border px-4 py-3 shrink-0">
          <p className="text-xs font-medium text-ev-success mb-1">Result</p>
          <p className="text-sm text-[#e4e4e7] whitespace-pre-wrap break-words">{String(result)}</p>
        </div>
      )}
      {error && (
        <div className="border-b border-border px-4 py-3 shrink-0">
          <p className="text-xs font-medium text-ev-error mb-1">Error</p>
          <p className="text-sm text-[#e4e4e7]">{error}</p>
        </div>
      )}

      {/* Spacer */}
      <div className="flex-1" />

      {/* Submit form */}
      <div className="border-t border-border px-4 py-3 shrink-0">
        <SubmitForm onSubmitted={onWorkflowStarted} />
      </div>
    </div>
  );
}

type BadgeVariant = NonNullable<React.ComponentProps<typeof Badge>["variant"]>;

function StatusBadge({ status }: { status: WorkflowState["status"] }) {
  const map: Record<WorkflowState["status"], BadgeVariant> = {
    pending: "neutral",
    running: "default",
    completed: "success",
    completed_partial: "warn",
    failed: "error",
    halted: "warn",
    suspended: "warn",
  };
  return <Badge variant={map[status]}>{status}</Badge>;
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded bg-canvas px-2 py-1 text-center">
      <p className="text-[10px] text-[#52525b]">{label}</p>
      <p className="font-mono text-xs text-[#a1a1aa]">{value}</p>
    </div>
  );
}
