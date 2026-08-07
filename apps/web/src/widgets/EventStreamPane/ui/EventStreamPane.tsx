import type { HarnessEvent } from "@harness/contracts";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef, useState } from "react";
import { cn } from "../../../shared/lib/cn.js";
import { Badge } from "../../../shared/ui/badge.js";
import type { ConnectionStatus } from "../../../shared/transport/harness-socket.js";

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
};

function getEventMeta(type: string): EventMeta {
  return EVENT_META[type] ?? { label: type, variant: "neutral" };
}

// ---------------------------------------------------------------------------
// EventRow — single row in the list
// ---------------------------------------------------------------------------

function EventRow({ event, style }: { event: HarnessEvent; style: React.CSSProperties }) {
  const [expanded, setExpanded] = useState(false);
  const meta = getEventMeta(event.type);

  return (
    <div style={style} className="flex flex-col border-b border-border px-3 py-2 animate-fade-in">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-2 text-left w-full hover:bg-surface-2 -mx-3 px-3 py-1 rounded transition-colors"
      >
        <span className="font-mono text-xs tabular-nums text-[#52525b] w-10 shrink-0">
          {event.seq}
        </span>
        <Badge variant={meta.variant}>{meta.label}</Badge>
        <span className="font-mono text-xs text-[#a1a1aa] truncate flex-1">
          {event.type}
        </span>
        <span className="font-mono text-xs text-[#3f3f46] shrink-0">
          {new Date(event.at).toLocaleTimeString("en-US", { hour12: false, fractionalSecondDigits: 3 })}
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
}

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
  const parentRef = useRef<HTMLDivElement>(null);

  const filtered = filter === ALL_TYPES ? events : events.filter((e) => e.type === filter);

  // TanStack Virtual — only DOM nodes for visible rows.
  const rowVirtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 42,
    overscan: 10,
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
          <StatusDot status={status} />
        </div>
      </div>

      {/* Filters */}
      {eventTypes.length > 0 && (
        <div className="flex flex-wrap gap-1 border-b border-border px-3 py-1.5 shrink-0">
          <button
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
          <div
            style={{ height: `${rowVirtualizer.getTotalSize()}px`, position: "relative" }}
          >
            {rowVirtualizer.getVirtualItems().map((virtualRow) => {
              const event = filtered[virtualRow.index];
              if (!event) return null;
              return (
                <EventRow
                  key={event.id}
                  event={event}
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
