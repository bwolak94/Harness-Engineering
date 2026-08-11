import type { HarnessEvent } from "@harness/contracts";
import { cn } from "../../../shared/lib/cn.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ToolSpan {
  callId: string;
  toolName: string;
  startAt: number; // ms epoch
  endAt: number | null; // null = still running
  status: "running" | "done" | "error";
}

// ---------------------------------------------------------------------------
// Build spans from events (tool.called → tool.succeeded / tool.failed)
// ---------------------------------------------------------------------------

function buildSpans(events: readonly HarnessEvent[]): ToolSpan[] {
  const spans = new Map<string, ToolSpan>();

  for (const event of events) {
    if (event.type === "tool.called") {
      const p = event.payload as { callId: string; toolName: string };
      spans.set(p.callId, {
        callId: p.callId,
        toolName: p.toolName,
        startAt: new Date(event.at).getTime(),
        endAt: null,
        status: "running",
      });
    } else if (event.type === "tool.succeeded") {
      const p = event.payload as { callId: string };
      const span = spans.get(p.callId);
      if (span) {
        span.endAt = new Date(event.at).getTime();
        span.status = "done";
      }
    } else if (event.type === "tool.failed") {
      const p = event.payload as { callId: string };
      const span = spans.get(p.callId);
      if (span) {
        span.endAt = new Date(event.at).getTime();
        span.status = "error";
      }
    }
  }

  return [...spans.values()].sort((a, b) => a.startAt - b.startAt);
}

// ---------------------------------------------------------------------------
// SpanBar — horizontal bar representing a single tool call
// ---------------------------------------------------------------------------

function SpanBar({
  span,
  minMs,
  totalMs,
  now,
}: {
  span: ToolSpan;
  minMs: number;
  totalMs: number;
  now: number;
}) {
  const endMs = span.endAt ?? now;
  const left = ((span.startAt - minMs) / totalMs) * 100;
  const width = Math.max(((endMs - span.startAt) / totalMs) * 100, 0.5);
  const durationMs = endMs - span.startAt;

  const barColor =
    span.status === "done"
      ? "bg-ev-success/70"
      : span.status === "error"
        ? "bg-ev-error/70"
        : "bg-accent/70 animate-pulse";

  return (
    <div className="flex items-center gap-2 group">
      {/* Tool name label */}
      <span className="w-28 shrink-0 truncate text-right text-[11px] font-mono text-[#52525b] group-hover:text-[#a1a1aa] transition-colors">
        {span.toolName}
      </span>

      {/* Bar track */}
      <div className="relative flex-1 h-5">
        <div
          className={cn("absolute top-0.5 h-4 rounded", barColor)}
          style={{ left: `${left}%`, width: `${width}%` }}
          title={`${span.toolName} — ${durationMs}ms`}
        />
      </div>

      {/* Duration label */}
      <span className="w-14 shrink-0 text-[11px] font-mono text-[#3f3f46] text-right">
        {span.endAt !== null ? `${durationMs}ms` : "…"}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// WaterfallTimeline — Gantt-style chart of tool call timings
// ---------------------------------------------------------------------------

interface WaterfallTimelineProps {
  events: readonly HarnessEvent[];
  className?: string;
}

export function WaterfallTimeline({ events, className }: WaterfallTimelineProps) {
  const spans = buildSpans(events);

  if (spans.length === 0) {
    return (
      <div
        className={cn("flex items-center justify-center text-xs text-[#3f3f46] py-6", className)}
      >
        No tool calls yet
      </div>
    );
  }

  const now = Date.now();
  const minMs = spans[0]?.startAt ?? now;
  const maxMs = Math.max(...spans.map((s) => s.endAt ?? now), minMs + 1);
  const totalMs = maxMs - minMs || 1;

  // Tick marks: up to 5 evenly spaced labels on the time axis.
  const tickCount = Math.min(5, Math.ceil(totalMs / 500));
  const ticks = Array.from({ length: tickCount + 1 }, (_, i) =>
    Math.round((totalMs / tickCount) * i),
  );

  return (
    <div className={cn("flex flex-col gap-1 px-3 py-3", className)}>
      {/* Time axis */}
      <div className="flex items-center gap-2 mb-1">
        <span className="w-28 shrink-0" />
        <div className="relative flex-1 h-4">
          {ticks.map((ms) => (
            <span
              key={ms}
              className="absolute text-[10px] font-mono text-[#3f3f46] -translate-x-1/2"
              style={{ left: `${(ms / totalMs) * 100}%` }}
            >
              {ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`}
            </span>
          ))}
        </div>
        <span className="w-14 shrink-0" />
      </div>

      {/* Span bars */}
      {spans.map((span) => (
        <SpanBar key={span.callId} span={span} minMs={minMs} totalMs={totalMs} now={now} />
      ))}

      {/* Summary footer */}
      <div className="mt-2 flex items-center gap-2 text-[10px] font-mono text-[#3f3f46]">
        <span className="w-28 shrink-0" />
        <span className="flex-1">
          {spans.length} call{spans.length !== 1 ? "s" : ""} · {Math.round(totalMs)}ms total
        </span>
      </div>
    </div>
  );
}
