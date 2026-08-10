import type { HarnessEvent } from "@harness/contracts";
import type { WorkflowState } from "@harness/core";
import { cn } from "../../../shared/lib/cn.js";

// ---------------------------------------------------------------------------
// BudgetGauge — four live progress bars driven by the WS event stream.
//
// Usage: used values come from WorkflowState.budget (updated by the reducer).
// Limits: extracted from the workflow.started event in the event log.
// ---------------------------------------------------------------------------

interface Budget {
  maxTokens: number;
  maxSteps: number;
  maxCostUsd: number;
  maxWallClockMs: number;
}

const DEFAULT_BUDGET: Budget = {
  maxTokens: 100_000,
  maxSteps: 20,
  maxCostUsd: 5.0,
  maxWallClockMs: 300_000,
};

export function extractBudgetLimits(events: readonly HarnessEvent[]): Budget {
  for (const e of events) {
    if (e.type === "workflow.started") {
      const b = (e.payload as { task?: { budget?: Partial<Budget> } }).task?.budget;
      if (b) {
        return {
          maxTokens: b.maxTokens ?? DEFAULT_BUDGET.maxTokens,
          maxSteps: b.maxSteps ?? DEFAULT_BUDGET.maxSteps,
          maxCostUsd: b.maxCostUsd ?? DEFAULT_BUDGET.maxCostUsd,
          maxWallClockMs: b.maxWallClockMs ?? DEFAULT_BUDGET.maxWallClockMs,
        };
      }
    }
  }
  return DEFAULT_BUDGET;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface GaugeDimension {
  label: string;
  used: number;
  limit: number;
  format: (v: number) => string;
}

function barColor(ratio: number): string {
  if (ratio >= 1) return "bg-ev-error";
  if (ratio >= 0.8) return "bg-ev-warn";
  return "bg-ev-success";
}

function GaugeRow({ dim }: { dim: GaugeDimension }) {
  const ratio = dim.limit > 0 ? Math.min(dim.used / dim.limit, 1) : 0;
  const pct = Math.round(ratio * 100);

  return (
    <div className="flex items-center gap-2">
      <span className="w-12 shrink-0 text-[10px] font-mono text-[#52525b] text-right">
        {dim.label}
      </span>
      <div className="flex-1 h-1.5 rounded-full bg-canvas overflow-hidden">
        <div
          className={cn("h-full rounded-full transition-all duration-300", barColor(ratio))}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="w-20 shrink-0 text-[10px] font-mono text-[#3f3f46] text-right">
        {dim.format(dim.used)} / {dim.format(dim.limit)}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// BudgetGauge
// ---------------------------------------------------------------------------

interface BudgetGaugeProps {
  state: WorkflowState;
  /** Budget limits — call extractBudgetLimits(events) to derive from event log. */
  limits: Budget;
  className?: string;
}

export function BudgetGauge({ state, limits, className }: BudgetGaugeProps) {
  const { budget } = state;

  const dims: GaugeDimension[] = [
    {
      label: "tokens",
      used: budget.tokensUsed,
      limit: limits.maxTokens,
      format: (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v)),
    },
    {
      label: "steps",
      used: budget.stepsCompleted,
      limit: limits.maxSteps,
      format: (v) => String(v),
    },
    {
      label: "cost",
      used: budget.costUsd,
      limit: limits.maxCostUsd,
      format: (v) => `$${v.toFixed(4)}`,
    },
    {
      label: "time",
      used: budget.wallClockMs,
      limit: limits.maxWallClockMs,
      format: (v) => (v >= 1000 ? `${(v / 1000).toFixed(0)}s` : `${v}ms`),
    },
  ];

  return (
    <div
      className={cn("flex flex-col gap-1.5 px-4 py-2 border-b border-border shrink-0", className)}
    >
      {dims.map((d) => (
        <GaugeRow key={d.label} dim={d} />
      ))}
    </div>
  );
}
