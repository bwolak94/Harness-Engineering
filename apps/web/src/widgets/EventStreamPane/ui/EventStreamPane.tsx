import type { HarnessEvent } from "@harness/contracts";
import { initialWorkflowState, rehydrate } from "@harness/core";
import { useVirtualizer } from "@tanstack/react-virtual";
import { forwardRef, useRef, useState } from "react";
import { cn } from "../../../shared/lib/cn.js";
import type { ConnectionStatus } from "../../../shared/transport/harness-socket.js";
import { Badge } from "../../../shared/ui/badge.js";
import { WaterfallTimeline } from "../../WaterfallTimeline/index.js";

// ---------------------------------------------------------------------------
// Event type → display metadata
// ---------------------------------------------------------------------------

type BadgeVariant = NonNullable<React.ComponentProps<typeof Badge>["variant"]>;
type EventMeta = { label: string; variant: BadgeVariant };

const EVENT_META: Record<string, EventMeta> = {
  "workflow.started": { label: "started", variant: "default" },
  "workflow.completed": { label: "completed", variant: "success" },
  "workflow.failed": { label: "failed", variant: "error" },
  "workflow.suspended": { label: "suspended", variant: "warn" },
  "workflow.resumed": { label: "resumed", variant: "info" },
  "step.planned": { label: "step", variant: "step" },
  "tool.called": { label: "tool.call", variant: "tool" },
  "tool.succeeded": { label: "tool.ok", variant: "success" },
  "tool.failed": { label: "tool.err", variant: "error" },
  "state.checkpointed": { label: "checkpoint", variant: "neutral" },
  "context.hydrated": { label: "ctx.hydrated", variant: "neutral" },
  "context.summarized": { label: "ctx.summarized", variant: "neutral" },
  "model.delta": { label: "stream.δ", variant: "info" },
  "model.completed": { label: "stream.done", variant: "info" },
};

// Streaming events are noisy (one per token, all seq=1) — hide from "all" by default.
const STREAMING_TYPES = new Set(["model.delta", "model.completed"]);

function getEventMeta(type: string): EventMeta {
  return EVENT_META[type] ?? { label: type, variant: "neutral" };
}

// ---------------------------------------------------------------------------
// EventRow — single row in the list
// ---------------------------------------------------------------------------

const EventRow = forwardRef<
  HTMLDivElement,
  { event: HarnessEvent; style: React.CSSProperties; "data-index": number }
>(function EventRow({ event, style, "data-index": dataIndex }, ref) {
  const [expanded, setExpanded] = useState(false);
  const meta = getEventMeta(event.type);

  return (
    <div
      ref={ref}
      data-index={dataIndex}
      style={style}
      className="flex flex-col border-b border-border px-3 py-2 animate-fade-in"
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-2 text-left w-full hover:bg-surface-2 -mx-3 px-3 py-1 rounded transition-colors"
      >
        <span className="font-mono text-xs tabular-nums text-[#52525b] w-10 shrink-0">
          {event.seq}
        </span>
        <Badge variant={meta.variant}>{meta.label}</Badge>
        <span className="font-mono text-xs text-[#a1a1aa] truncate flex-1">{event.type}</span>
        <span className="font-mono text-xs text-[#3f3f46] shrink-0">
          {new Date(event.at).toLocaleTimeString("en-US", {
            hour12: false,
            fractionalSecondDigits: 3,
          })}
        </span>
        <span className="text-xs text-[#3f3f46]">{expanded ? "▴" : "▾"}</span>
      </button>

      {expanded && (
        <pre className="mt-1 rounded bg-canvas p-2 text-xs font-mono text-[#c4c4d4] overflow-x-auto">
          {JSON.stringify(event.payload, null, 2)}
        </pre>
      )}
    </div>
  );
});

// ---------------------------------------------------------------------------
// EventStreamPane — virtualized list (Pattern: Virtualization)
// ---------------------------------------------------------------------------

const ALL_TYPES = "all";

interface EventStreamPaneProps {
  events: HarnessEvent[];
  status: ConnectionStatus;
  lagged: boolean;
  className?: string;
}

export function EventStreamPane({ events, status, lagged, className }: EventStreamPaneProps) {
  const [filter, setFilter] = useState<string>(ALL_TYPES);
  const [showWaterfall, setShowWaterfall] = useState(true);
  const [replayMode, setReplayMode] = useState(false);
  const [replaySeq, setReplaySeq] = useState(0);
  const parentRef = useRef<HTMLDivElement>(null);

  const maxSeq = events.reduce((m, e) => Math.max(m, e.seq), 0);
  const replayState = replayMode
    ? (() => {
        const wid = events[0]?.workflowId ?? "";
        const slice = events.filter((e) => e.seq <= replaySeq);
        return rehydrate(wid, slice, initialWorkflowState(wid));
      })()
    : null;

  const visibleEvents = replayMode ? events.filter((e) => e.seq <= replaySeq) : events;

  const filtered =
    filter === ALL_TYPES
      ? visibleEvents.filter((e) => !STREAMING_TYPES.has(e.type))
      : visibleEvents.filter((e) => e.type === filter);

  // TanStack Virtual — only DOM nodes for visible rows.
  // measureElement enables dynamic row heights so expanded rows don't overlap.
  const rowVirtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 42,
    overscan: 10,
    measureElement: (el) => el.getBoundingClientRect().height,
  });

  const eventTypes = [...new Set(events.map((e) => e.type))];

  return (
    <div className={cn("flex flex-col h-full bg-surface", className)}>
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-3 py-2 shrink-0">
        <span className="text-xs font-medium text-[#a1a1aa]">
          Event stream
          <span className="ml-2 font-mono text-[#52525b]">({filtered.length})</span>
        </span>
        <div className="flex items-center gap-2">
          {lagged && (
            <span className="rounded bg-ev-warn/15 px-2 py-0.5 text-xs text-ev-warn">
              lagged — some events may be missing
            </span>
          )}
          {events.length > 1 && (
            <button
              type="button"
              onClick={() => {
                const next = !replayMode;
                setReplayMode(next);
                if (next) setReplaySeq(maxSeq);
              }}
              className={cn(
                "rounded px-2 py-0.5 text-xs font-mono transition-colors",
                replayMode ? "bg-accent/20 text-accent" : "text-[#52525b] hover:text-[#a1a1aa]",
              )}
            >
              {replayMode ? "exit replay" : "replay"}
            </button>
          )}
          <StatusDot status={status} />
        </div>
      </div>

      {/* Replay slider */}
      {replayMode && (
        <div className="shrink-0 border-b border-border bg-surface-2 px-3 py-2">
          <div className="mb-1.5 flex items-center justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-[#52525b]">
              Replay
            </span>
            <span className="font-mono text-[10px] text-[#52525b]">
              seq {replaySeq} of {maxSeq}
              {replayState && ` · ${replayState.status}`}
            </span>
          </div>
          <input
            type="range"
            min={0}
            max={maxSeq}
            value={replaySeq}
            onChange={(e) => setReplaySeq(Number(e.target.value))}
            className="w-full accent-[#6366f1]"
          />
          {replayState && (
            <div className="mt-1.5 flex gap-3 font-mono text-[10px] text-[#3f3f46]">
              <span>steps: {replayState.budget.stepsCompleted}</span>
              <span>tokens: {replayState.budget.tokensUsed.toLocaleString()}</span>
              <span>cost: ${replayState.budget.costUsd.toFixed(4)}</span>
            </div>
          )}
        </div>
      )}

      {/* Waterfall timeline — collapsible */}
      {events.some((e) => e.type === "tool.called") && (
        <div className="border-b border-border shrink-0">
          <button
            type="button"
            onClick={() => setShowWaterfall((v) => !v)}
            className="flex w-full items-center justify-between px-3 py-1.5 text-xs text-[#52525b] hover:text-[#a1a1aa] transition-colors"
          >
            <span className="font-mono">Tool timeline</span>
            <span>{showWaterfall ? "▴" : "▾"}</span>
          </button>
          {showWaterfall && <WaterfallTimeline events={events} />}
        </div>
      )}

      {/* Filters */}
      {eventTypes.length > 0 && (
        <div className="flex flex-wrap gap-1 border-b border-border px-3 py-1.5 shrink-0">
          <button
            type="button"
            onClick={() => setFilter(ALL_TYPES)}
            className={cn(
              "rounded px-2 py-0.5 text-xs font-mono transition-colors",
              filter === ALL_TYPES
                ? "bg-accent/20 text-accent"
                : "text-[#52525b] hover:text-[#a1a1aa]",
            )}
          >
            all
          </button>
          {eventTypes.map((t) => {
            const meta = getEventMeta(t);
            return (
              <button
                type="button"
                key={t}
                onClick={() => setFilter(t)}
                className={cn(
                  "rounded px-2 py-0.5 text-xs font-mono transition-colors",
                  filter === t ? "bg-surface-2 text-white" : "text-[#52525b] hover:text-[#a1a1aa]",
                )}
              >
                {meta.label}
              </button>
            );
          })}
        </div>
      )}

      {/* Virtualized list */}
      <div ref={parentRef} className="flex-1 overflow-y-auto">
        {filtered.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-[#3f3f46]">
            {status === "connected" ? "Waiting for events…" : "No events yet"}
          </div>
        ) : (
          <div style={{ height: `${rowVirtualizer.getTotalSize()}px`, position: "relative" }}>
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const event = filtered[virtualRow.index];
              if (!event) return null;
              return (
                <EventRow
                  key={event.id}
                  event={event}
                  data-index={virtualRow.index}
                  ref={rowVirtualizer.measureElement}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: ConnectionStatus }) {
  const colorClass =
    status === "connected"
      ? "bg-ev-success animate-pulse"
      : status === "connecting"
        ? "bg-ev-warn animate-pulse"
        : "bg-ev-checkpoint";

  const label =
    status === "connected" ? "live" : status === "connecting" ? "connecting…" : "offline";

  return (
    <span className="flex items-center gap-1.5 text-xs text-[#52525b]">
      <span className={cn("h-2 w-2 rounded-full", colorClass)} />
      {label}
    </span>
  );
}
