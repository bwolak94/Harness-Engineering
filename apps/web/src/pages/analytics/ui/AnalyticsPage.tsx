import type {
  HarnessEvent,
  ToolCalledEvent,
  WorkflowCompletedEvent,
  WorkflowStartedEvent,
} from "@harness/contracts";
import { useWorkflowStore } from "../../../entities/workflow/index.js";

// ---------------------------------------------------------------------------
// Data derivation
// ---------------------------------------------------------------------------

interface DayStat {
  date: string;
  runs: number;
  costUsd: number;
  tokensUsed: number;
}

interface ToolStat {
  toolName: string;
  calls: number;
}

interface Analytics {
  days: DayStat[];
  tools: ToolStat[];
  totalRuns: number;
  totalCostUsd: number;
  totalTokens: number;
  avgCostUsd: number;
}

function derive(allEvents: readonly HarnessEvent[]): Analytics {
  // Map workflowId → start date (YYYY-MM-DD)
  const startDates = new Map<string, string>();
  for (const e of allEvents) {
    if (e.type === "workflow.started") {
      const ev = e as WorkflowStartedEvent;
      startDates.set(ev.workflowId, ev.at.slice(0, 10));
    }
  }

  const dayMap = new Map<string, DayStat>();
  const toolMap = new Map<string, number>();

  for (const e of allEvents) {
    if (e.type === "workflow.completed") {
      const ev = e as WorkflowCompletedEvent;
      const date = startDates.get(ev.workflowId) ?? ev.at.slice(0, 10);
      const prev = dayMap.get(date) ?? { date, runs: 0, costUsd: 0, tokensUsed: 0 };
      dayMap.set(date, {
        date,
        runs: prev.runs + 1,
        costUsd: prev.costUsd + ev.payload.totalCostUsd,
        tokensUsed: prev.tokensUsed + ev.payload.tokensUsed,
      });
    }

    if (e.type === "tool.called") {
      const ev = e as ToolCalledEvent;
      toolMap.set(ev.payload.toolName, (toolMap.get(ev.payload.toolName) ?? 0) + 1);
    }
  }

  const days = [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date));
  const tools = [...toolMap.entries()]
    .map(([toolName, calls]) => ({ toolName, calls }))
    .sort((a, b) => b.calls - a.calls);

  const totalRuns = days.reduce((s, d) => s + d.runs, 0);
  const totalCostUsd = days.reduce((s, d) => s + d.costUsd, 0);
  const totalTokens = days.reduce((s, d) => s + d.tokensUsed, 0);
  const avgCostUsd = totalRuns > 0 ? totalCostUsd / totalRuns : 0;

  return { days, tools, totalRuns, totalCostUsd, totalTokens, avgCostUsd };
}

// ---------------------------------------------------------------------------
// KPI card
// ---------------------------------------------------------------------------

function KpiCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-md border border-border bg-surface px-4 py-3">
      <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[#3f3f46]">
        {label}
      </p>
      <p className="font-mono text-xl font-semibold text-white">{value}</p>
      {sub && <p className="mt-0.5 text-[10px] text-[#52525b]">{sub}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cost bar chart (SVG)
// ---------------------------------------------------------------------------

const CHART_W = 600;
const CHART_H = 100;
const BAR_GAP = 3;
const LABEL_H = 14;

function CostBarChart({ days }: { days: DayStat[] }) {
  if (days.length === 0) {
    return (
      <div className="flex h-24 items-center justify-center text-xs text-[#3f3f46]">
        No data yet
      </div>
    );
  }

  // Show at most 30 most recent days
  const visible = days.slice(-30);
  const maxCost = Math.max(...visible.map((d) => d.costUsd), 0.0001);

  const barW = (CHART_W - BAR_GAP * (visible.length - 1)) / visible.length;

  return (
    <svg
      viewBox={`0 0 ${CHART_W} ${CHART_H + LABEL_H}`}
      className="w-full"
      role="img"
      aria-labelledby="cost-chart-title"
    >
      <title id="cost-chart-title">Cost per day bar chart</title>
      {/* Faint grid lines */}
      {[0.25, 0.5, 0.75, 1].map((frac) => (
        <line
          key={frac}
          x1={0}
          y1={CHART_H * (1 - frac)}
          x2={CHART_W}
          y2={CHART_H * (1 - frac)}
          stroke="#1e1e2e"
          strokeWidth={1}
        />
      ))}

      {visible.map((d, i) => {
        const x = i * (barW + BAR_GAP);
        const barH = (d.costUsd / maxCost) * CHART_H;
        const y = CHART_H - barH;
        const showLabel = visible.length <= 15 || i % Math.ceil(visible.length / 10) === 0;
        const labelText = d.date.slice(5); // MM-DD

        return (
          <g key={d.date}>
            <rect
              x={x}
              y={y}
              width={barW}
              height={barH > 0 ? barH : 1}
              rx={1}
              fill={d.costUsd > 0 ? "#6366f1" : "#1e1e2e"}
              opacity={d.costUsd > 0 ? 0.85 : 1}
            />
            {showLabel && (
              <text
                x={x + barW / 2}
                y={CHART_H + LABEL_H - 2}
                textAnchor="middle"
                fontSize={9}
                fill="#3f3f46"
              >
                {labelText}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Tool usage horizontal bars
// ---------------------------------------------------------------------------

function ToolUsageChart({ tools }: { tools: ToolStat[] }) {
  if (tools.length === 0) {
    return (
      <div className="flex h-16 items-center justify-center text-xs text-[#3f3f46]">
        No tool calls yet
      </div>
    );
  }

  const top = tools.slice(0, 10);
  const maxCalls = top[0]?.calls ?? 1;

  return (
    <div className="flex flex-col gap-1.5">
      {top.map(({ toolName, calls }) => (
        <div key={toolName} className="flex items-center gap-2">
          <span className="w-36 shrink-0 truncate font-mono text-[10px] text-[#71717a]">
            {toolName}
          </span>
          <div className="flex flex-1 items-center gap-2">
            <div className="h-3 flex-1 overflow-hidden rounded-sm bg-surface-2">
              <div
                className="h-full rounded-sm bg-accent/70 transition-all"
                style={{ width: `${(calls / maxCalls) * 100}%` }}
              />
            </div>
            <span className="w-6 text-right font-mono text-[10px] text-[#52525b]">{calls}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function AnalyticsPage() {
  const { allEvents } = useWorkflowStore();
  const { days, tools, totalRuns, totalCostUsd, totalTokens, avgCostUsd } = derive(allEvents);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-6 py-5">
        <h1 className="mb-4 text-xs font-semibold uppercase tracking-wider text-[#52525b]">
          Cost Analytics
        </h1>

        {/* KPI row */}
        <div className="mb-5 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          <KpiCard label="Total runs" value={String(totalRuns)} />
          <KpiCard
            label="Total cost"
            value={`$${totalCostUsd.toFixed(4)}`}
            sub="sum of workflow.completed"
          />
          <KpiCard
            label="Total tokens"
            value={totalTokens > 0 ? totalTokens.toLocaleString() : "—"}
          />
          <KpiCard
            label="Avg cost / run"
            value={totalRuns > 0 ? `$${avgCostUsd.toFixed(4)}` : "—"}
          />
        </div>

        {/* Cost per day */}
        <div className="mb-5 rounded-md border border-border bg-surface px-4 py-3">
          <p className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-[#3f3f46]">
            Cost per day (USD)
          </p>
          <CostBarChart days={days} />
        </div>

        {/* Tool usage */}
        <div className="rounded-md border border-border bg-surface px-4 py-3">
          <p className="mb-3 text-[10px] font-semibold uppercase tracking-wider text-[#3f3f46]">
            Tool usage (call count)
          </p>
          <ToolUsageChart tools={tools} />
        </div>
      </div>
    </div>
  );
}
