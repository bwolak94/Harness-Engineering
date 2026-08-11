import type { HarnessEvent } from "@harness/contracts";
import type { WorkflowState } from "@harness/core";
import { useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { SubmitForm } from "../../../features/submit-task/index.js";
import { cn } from "../../../shared/lib/cn.js";
import { downloadMarkdown, toMarkdown } from "../../../shared/lib/to-markdown.js";
import { Badge } from "../../../shared/ui/badge.js";
import { ApprovalPanel } from "../../ApprovalPanel/index.js";
import { BudgetGauge, extractBudgetLimits } from "../../BudgetGauge/ui/BudgetGauge.js";

// ---------------------------------------------------------------------------
// Transcript model — converts raw HarnessEvents into chat turns
// ---------------------------------------------------------------------------

interface UserTurn {
  kind: "user";
  id: string;
  content: string;
}

interface AssistantTurn {
  kind: "assistant";
  id: string;
  content: string;
  streaming: boolean;
}

interface ToolTurn {
  kind: "tool";
  id: string;
  callId: string;
  toolName: string;
  status: "running" | "done" | "error";
  result?: unknown;
  error?: string;
}

type ChatTurn = UserTurn | AssistantTurn | ToolTurn;

function toTranscript(events: readonly HarnessEvent[]): ChatTurn[] {
  const turns: ChatTurn[] = [];
  const toolIndex = new Map<string, number>();
  let deltaText = "";
  let streamingIdx = -1;

  for (const event of events) {
    switch (event.type) {
      case "workflow.started":
        turns.push({ kind: "user", id: event.id, content: event.payload.task.goal });
        break;

      case "model.delta": {
        deltaText += event.payload.text;
        if (streamingIdx === -1) {
          streamingIdx = turns.length;
          turns.push({ kind: "assistant", id: event.id, content: deltaText, streaming: true });
        } else {
          turns[streamingIdx] = {
            kind: "assistant",
            id: event.id,
            content: deltaText,
            streaming: true,
          };
        }
        break;
      }

      case "model.completed": {
        const finalText = event.payload.text || deltaText;
        if (streamingIdx !== -1) {
          turns[streamingIdx] = {
            kind: "assistant",
            id: event.id,
            content: finalText,
            streaming: false,
          };
          streamingIdx = -1;
        } else if (finalText) {
          turns.push({ kind: "assistant", id: event.id, content: finalText, streaming: false });
        }
        deltaText = "";
        break;
      }

      case "tool.called": {
        // Finalize any in-progress streaming turn before a tool call
        if (streamingIdx !== -1) {
          const t = turns[streamingIdx] as AssistantTurn;
          turns[streamingIdx] = { ...t, streaming: false };
          streamingIdx = -1;
          deltaText = "";
        }
        const idx = turns.length;
        toolIndex.set(event.payload.callId, idx);
        turns.push({
          kind: "tool",
          id: event.id,
          callId: event.payload.callId,
          toolName: event.payload.toolName,
          status: "running",
        });
        break;
      }

      case "tool.succeeded": {
        const idx = toolIndex.get(event.payload.callId);
        if (idx !== undefined) {
          const t = turns[idx] as ToolTurn;
          turns[idx] = { ...t, status: "done", result: event.payload.result };
        }
        break;
      }

      case "tool.failed": {
        const idx = toolIndex.get(event.payload.callId);
        if (idx !== undefined) {
          const t = turns[idx] as ToolTurn;
          turns[idx] = { ...t, status: "error", error: event.payload.message };
        }
        break;
      }

      case "workflow.completed": {
        // If the LLM never streamed text, surface the result as an assistant turn
        const hasAssistant = turns.some((t) => t.kind === "assistant");
        if (!hasAssistant && typeof event.payload.result === "string" && event.payload.result) {
          turns.push({
            kind: "assistant",
            id: event.id,
            content: event.payload.result,
            streaming: false,
          });
        }
        break;
      }

      default:
        break;
    }
  }

  return turns;
}

// ---------------------------------------------------------------------------
// Turn renderers
// ---------------------------------------------------------------------------

function UserBubble({ turn }: { turn: UserTurn }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-accent/20 border border-accent/30 px-4 py-2.5">
        <p className="text-sm text-white whitespace-pre-wrap break-words leading-relaxed">
          {turn.content}
        </p>
      </div>
    </div>
  );
}

function AssistantBubble({ turn }: { turn: AssistantTurn }) {
  return (
    <div className="flex justify-start">
      <div className="max-w-[90%] rounded-2xl rounded-bl-sm bg-surface-2 border border-border px-4 py-2.5">
        <div className="prose prose-invert prose-sm max-w-none text-[#e4e4e7] leading-relaxed [&_code]:bg-canvas [&_code]:px-1 [&_code]:rounded [&_code]:text-xs [&_pre]:bg-canvas [&_pre]:rounded-lg [&_pre]:p-3 [&_pre]:overflow-x-auto [&_a]:text-accent [&_a]:underline">
          <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
            {turn.content}
          </ReactMarkdown>
          {turn.streaming && (
            <span className="inline-block w-0.5 h-4 ml-0.5 bg-accent animate-pulse align-text-bottom" />
          )}
        </div>
      </div>
    </div>
  );
}

function ToolCard({ turn }: { turn: ToolTurn }) {
  return (
    <div className="flex justify-start">
      <div className="rounded-xl border border-border bg-canvas px-3 py-2 text-xs font-mono max-w-[90%]">
        <div className="flex items-center gap-2 mb-1">
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full shrink-0",
              turn.status === "done" && "bg-ev-success",
              turn.status === "error" && "bg-ev-error",
              turn.status === "running" && "bg-accent animate-pulse",
            )}
          />
          <span className="text-ev-tool font-semibold">{turn.toolName}</span>
          <span className="text-[#52525b]">
            {turn.status === "running" ? "running…" : turn.status === "done" ? "done" : "failed"}
          </span>
        </div>
        {turn.status === "done" && turn.result !== undefined && (
          <pre className="text-[#a1a1aa] overflow-x-auto max-h-24 text-[11px]">
            {typeof turn.result === "string"
              ? turn.result.slice(0, 300)
              : JSON.stringify(turn.result, null, 2).slice(0, 300)}
            {JSON.stringify(turn.result).length > 300 && "…"}
          </pre>
        )}
        {turn.status === "error" && turn.error && <p className="text-ev-error">{turn.error}</p>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ChatPane — left panel: chat transcript + task submission
// ---------------------------------------------------------------------------

interface ChatPaneProps {
  state: WorkflowState | null;
  events: HarnessEvent[];
  onWorkflowStarted: (workflowId: string) => void;
  onClearHistory: () => void;
  className?: string;
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

export function ChatPane({
  state,
  events,
  onWorkflowStarted,
  onClearHistory,
  className,
}: ChatPaneProps) {
  const transcript = toTranscript(events);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom as new turns arrive.
  // events.length is the stable proxy for "transcript changed"; bottomRef is a stable ref object.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — events.length drives scroll
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [events.length]);

  const error = state?.status === "failed" || state?.status === "halted" ? state.error : null;

  return (
    <div className={cn("flex flex-col h-full bg-surface border-r border-border", className)}>
      {/* Header */}
      <div className="border-b border-border px-4 py-3 shrink-0 flex items-center justify-between">
        <div>
          <h1 className="text-sm font-semibold text-white tracking-tight">Harness Inspector</h1>
          <p className="text-xs text-[#52525b] mt-0.5">AI agent execution trace</p>
        </div>
        <div className="flex items-center gap-2">
          {state && <StatusBadge status={state.status} />}
          {events.length > 0 && (
            <>
              <button
                type="button"
                onClick={() => {
                  const md = toMarkdown(events);
                  const slug = new Date().toISOString().slice(0, 10);
                  downloadMarkdown(md, `harness-${slug}.md`);
                }}
                className="text-[10px] font-mono text-[#3f3f46] hover:text-[#a1a1aa] transition-colors"
                title="Export transcript as Markdown"
              >
                export
              </button>
              <button
                type="button"
                onClick={onClearHistory}
                className="text-[10px] font-mono text-[#3f3f46] hover:text-[#a1a1aa] transition-colors"
                title="Clear conversation history"
              >
                clear
              </button>
            </>
          )}
        </div>
      </div>

      {/* Workflow ID strip */}
      {state && (
        <div className="border-b border-border px-4 py-1.5 shrink-0 flex items-center gap-3 text-xs text-[#52525b]">
          <span className="font-mono truncate max-w-[160px]">{state.workflowId.slice(0, 8)}…</span>
        </div>
      )}

      {/* Live budget gauge — four progress bars, updates on each state.checkpointed event */}
      {state && <BudgetGauge state={state} limits={extractBudgetLimits(events)} />}

      {/* Chat transcript */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {transcript.length === 0 && (
          <div className="flex h-full items-center justify-center text-xs text-[#3f3f46]">
            Submit a task to start a conversation
          </div>
        )}
        {transcript.map((turn) => {
          if (turn.kind === "user") return <UserBubble key={turn.id} turn={turn} />;
          if (turn.kind === "assistant") return <AssistantBubble key={turn.id} turn={turn} />;
          return <ToolCard key={turn.id} turn={turn} />;
        })}
        {error && (
          <div className="rounded-xl border border-ev-error/30 bg-ev-error/10 px-4 py-2.5 text-sm text-ev-error">
            {error}
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Approval panel — appears when approval.requested events are pending */}
      <ApprovalPanel events={events} workflowId={state?.workflowId ?? null} />

      {/* Submit form */}
      <div className="border-t border-border px-4 py-3 shrink-0">
        <SubmitForm onSubmitted={onWorkflowStarted} />
      </div>
    </div>
  );
}
