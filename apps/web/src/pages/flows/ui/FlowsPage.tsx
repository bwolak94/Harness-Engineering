import { useState } from "react";
import type {
  FlowRunResult,
  FlowSpec,
  FlowStepOutcome,
} from "../../../features/flows/api/use-flows.js";
import { useFlows, useRunFlow } from "../../../features/flows/api/use-flows.js";
import { cn } from "../../../shared/lib/cn.js";
import { Button } from "../../../shared/ui/button.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PATTERN_LABEL: Record<string, string> = {
  parallel: "Parallel",
  sequential: "Sequential",
};

const AGENT_COLOR: Record<string, string> = {
  "financial-analyst": "text-[#60a5fa]",
  "operational-analyst": "text-[#4ade80]",
  "commercial-analyst": "text-[#f59e0b]",
};

function agentLabel(name: string): string {
  return name.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// FlowCard
// ---------------------------------------------------------------------------

function FlowCard({
  flow,
  selected,
  onClick,
}: {
  flow: FlowSpec;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group flex flex-col gap-3 rounded-lg border p-4 text-left transition-all",
        selected
          ? "border-accent bg-accent/5"
          : "border-border bg-surface hover:border-border-2 hover:bg-surface-2",
      )}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <span className="font-mono text-sm font-semibold text-white">{flow.name}</span>
        <span
          className={cn(
            "shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider",
            flow.pattern === "parallel"
              ? "bg-[#7c3aed]/20 text-[#a78bfa]"
              : "bg-[#0369a1]/20 text-[#38bdf8]",
          )}
        >
          {PATTERN_LABEL[flow.pattern]}
        </span>
      </div>

      {/* Description */}
      <p className="text-xs leading-relaxed text-[#71717a]">{flow.description}</p>

      {/* Steps */}
      <div className="flex flex-wrap gap-1.5">
        {flow.steps.map((step, i) => (
          <span
            key={`${step.agentName}-${i}`}
            className={cn(
              "rounded bg-canvas px-2 py-0.5 text-[10px] font-medium",
              AGENT_COLOR[step.agentName] ?? "text-[#a1a1aa]",
            )}
          >
            {agentLabel(step.agentName)}
          </span>
        ))}
      </div>
    </button>
  );
}

// ---------------------------------------------------------------------------
// StepResult
// ---------------------------------------------------------------------------

function StepResult({
  step,
  onInspect,
}: { step: FlowStepOutcome; onInspect: (id: string) => void }) {
  return (
    <div
      className={cn(
        "rounded border p-3",
        step.status === "success"
          ? "border-ev-success/20 bg-ev-success/5"
          : "border-ev-error/20 bg-ev-error/5",
      )}
    >
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <span
          className={cn(
            "text-[10px] font-semibold uppercase tracking-wider",
            AGENT_COLOR[step.agentName] ?? "text-[#a1a1aa]",
          )}
        >
          {agentLabel(step.agentName)}
        </span>
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "text-[10px] font-medium uppercase",
              step.status === "success" ? "text-ev-success" : "text-ev-error",
            )}
          >
            {step.status}
          </span>
          {step.workflowId && step.status === "success" && (
            <button
              type="button"
              onClick={() => onInspect(step.workflowId)}
              className="rounded bg-accent/10 px-1.5 py-0.5 text-[10px] text-accent transition-colors hover:bg-accent/20"
            >
              Inspect
            </button>
          )}
        </div>
      </div>
      {step.status === "success" && step.result && (
        <p className="line-clamp-3 text-[11px] leading-relaxed text-[#c4c4d4]">{step.result}</p>
      )}
      {step.status === "failed" && step.reason && (
        <p className="text-[11px] text-ev-error">{step.reason}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// LaunchPanel
// ---------------------------------------------------------------------------

function LaunchPanel({
  flow,
  onResult,
}: {
  flow: FlowSpec;
  onResult: (result: FlowRunResult, inspectFn: (id: string) => void) => void;
  inspectWorkflow: (workflowId: string) => void;
}) {
  const { mutate, isPending, data, reset, error } = useRunFlow();
  const [goal, setGoal] = useState("");

  const handleRun = () => {
    if (!goal.trim()) return;
    mutate(
      { flowId: flow.id, goal: goal.trim() },
      { onSuccess: (result) => onResult(result, () => {}) },
    );
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Goal input */}
      <div>
        <label className="mb-1.5 block text-xs font-medium text-[#a1a1aa]" htmlFor="flow-goal">
          Describe the scenario
        </label>
        <textarea
          id="flow-goal"
          value={goal}
          onChange={(e) => {
            setGoal(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              handleRun();
            }
          }}
          rows={4}
          placeholder={`e.g. ${getPlaceholder(flow.id)}`}
          className={cn(
            "w-full resize-none rounded border bg-canvas px-3 py-2.5",
            "font-sans text-xs leading-relaxed text-white placeholder-[#3f3f46]",
            "border-border-2 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent transition-colors",
          )}
        />
      </div>

      <div className="flex items-center gap-3">
        <Button type="button" onClick={handleRun} loading={isPending} size="sm">
          Run Flow ⌘↵
        </Button>
        {data && (
          <button
            type="button"
            onClick={reset}
            className="text-xs text-[#3f3f46] transition-colors hover:text-[#71717a]"
          >
            Clear result
          </button>
        )}
      </div>

      {error && (
        <p className="text-xs text-ev-error">{error instanceof Error ? error.message : "Error"}</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Placeholder hints per flow
// ---------------------------------------------------------------------------

function getPlaceholder(flowId: string): string {
  switch (flowId) {
    case "supply-chain-audit":
      return "HS code 8471300000, imported from China to Poland, FOB, value $10,000, 50 kg, freight $800, delivery to 3 Warsaw stops";
    case "investment-due-diligence":
      return "Apartment block, purchase price PLN 1.2M, 6 units at PLN 3,500/month, 80% LTV mortgage at 7% for 20 years, investor on B2B PLN 15,000/month gross";
    case "business-launch-assessment":
      return "Launching a specialty coffee import business in Poland — arabica beans from Ethiopia, target 200 cafes, recipe: 7g per espresso";
    case "dynamic-pricing-pipeline":
      return "Laptop SKU LAPTOP-001 cost $700 current price $1,199, competitor Shop-A at $1,099; Mouse SKU MOUSE-002 cost $12 current price $39, competitor at $34";
    default:
      return "Describe your scenario in detail…";
  }
}

// ---------------------------------------------------------------------------
// FlowsPage
// ---------------------------------------------------------------------------

export function FlowsPage({
  onInspectWorkflow,
}: { onInspectWorkflow: (workflowId: string) => void }) {
  const { data: flows, isLoading, error } = useFlows();
  const [selected, setSelected] = useState<FlowSpec | null>(null);
  const [result, setResult] = useState<FlowRunResult | null>(null);

  const handleSelect = (flow: FlowSpec) => {
    setSelected(flow);
    setResult(null);
  };

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left — flow catalogue */}
      <div className="flex w-72 shrink-0 flex-col border-r border-border bg-surface">
        <div className="border-b border-border px-4 py-2.5">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-[#3f3f46]">
            Orchestration Flows
          </p>
        </div>
        <div className="flex-1 overflow-y-auto p-2.5 flex flex-col gap-2">
          {isLoading && <p className="px-2 py-2 text-xs text-[#3f3f46]">Loading…</p>}
          {error && <p className="px-2 py-2 text-xs text-ev-error">Server unavailable</p>}
          {flows?.map((f) => (
            <FlowCard
              key={f.id}
              flow={f}
              selected={selected?.id === f.id}
              onClick={() => handleSelect(f)}
            />
          ))}
        </div>
      </div>

      {/* Right — launch + result panel */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {!selected ? (
          <div className="flex h-full flex-col items-center justify-center gap-2">
            <span className="text-4xl opacity-20">⚡</span>
            <p className="text-xs text-[#3f3f46]">Select a flow to run it</p>
          </div>
        ) : (
          <div className="flex h-full flex-col overflow-hidden">
            {/* Flow header */}
            <div className="shrink-0 border-b border-border px-5 py-3">
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm font-semibold text-white">{selected.name}</span>
                <span
                  className={cn(
                    "rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider",
                    selected.pattern === "parallel"
                      ? "bg-[#7c3aed]/20 text-[#a78bfa]"
                      : "bg-[#0369a1]/20 text-[#38bdf8]",
                  )}
                >
                  {PATTERN_LABEL[selected.pattern]}
                </span>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-[#71717a]">{selected.description}</p>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto px-5 py-4">
              {/* Agent pipeline diagram */}
              <div className="mb-4 flex items-center gap-2 overflow-x-auto pb-1">
                {selected.steps.map((step, i) => (
                  <div key={`${step.agentName}-${i}`} className="flex items-center gap-2 shrink-0">
                    <div className="rounded bg-canvas px-2.5 py-1.5 text-center">
                      <p
                        className={cn(
                          "text-[10px] font-semibold",
                          AGENT_COLOR[step.agentName] ?? "text-[#a1a1aa]",
                        )}
                      >
                        {agentLabel(step.agentName)}
                      </p>
                    </div>
                    {i < selected.steps.length - 1 && (
                      <span className="text-[10px] text-[#3f3f46]">
                        {selected.pattern === "parallel" ? "∥" : "→"}
                      </span>
                    )}
                  </div>
                ))}
              </div>

              {/* Launch panel */}
              <LaunchPanel
                flow={selected}
                onResult={(r) => setResult(r)}
                inspectWorkflow={onInspectWorkflow}
              />

              {/* Results */}
              {result && (
                <div className="mt-5">
                  <div className="mb-3 flex items-center gap-2">
                    <p
                      className={cn(
                        "text-[10px] font-semibold uppercase tracking-wider",
                        result.partial ? "text-ev-error" : "text-ev-success",
                      )}
                    >
                      {result.partial ? "Partial result" : "Flow completed"}
                    </p>
                    <span className="text-[10px] text-[#3f3f46]">
                      {result.steps.filter((s) => s.status === "success").length}/
                      {result.steps.length} agents succeeded
                    </span>
                  </div>
                  <div className="flex flex-col gap-2">
                    {result.steps.map((step, i) => (
                      <StepResult
                        key={`${step.stepId}-${i}`}
                        step={step}
                        onInspect={onInspectWorkflow}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
