import { useState } from "react";
import { useSubmitTask } from "../../../features/submit-task/index.js";
import { cn } from "../../../shared/lib/cn.js";
import { Button } from "../../../shared/ui/button.js";

// ---------------------------------------------------------------------------
// Tool demo catalog
// ---------------------------------------------------------------------------

interface ToolDemo {
  name: string;
  label: string;
  category: string;
  description: string;
  exampleGoal: string;
}

const TOOL_DEMOS: ToolDemo[] = [
  {
    name: "analyzeInvestment",
    label: "Real Estate IRR",
    category: "Finance",
    description: "NOI, cap rate, IRR, NPV and DSCR for a property investment.",
    exampleGoal:
      "Analyze a real estate investment: purchase price €450,000, annual gross rent €36,000, operating expenses €9,000/year, 70% LTV mortgage at 5.5% over 25 years, 3% annual rent growth, 5-year hold. What's the IRR, cap rate, and DSCR?",
  },
  {
    name: "optimizeRoute",
    label: "Route Optimizer",
    category: "Logistics",
    description: "Nearest-neighbour + 2-opt route with time windows and capacity.",
    exampleGoal:
      "Optimize a delivery route from warehouse [0,0] to four stops: A at [2,3] (8–10 AM, 200 kg), B at [5,1] (8 AM–12 PM, 350 kg), C at [-1,4] (9–11 AM, 150 kg), D at [3,-2] (any time, 300 kg). Vehicle capacity 1,000 kg.",
  },
  {
    name: "calculateLandedCost",
    label: "Landed Cost",
    category: "Trade",
    description: "Duty, VAT, excise and freight for an international shipment.",
    exampleGoal:
      "Calculate the landed cost for importing 500 kg of roasted coffee beans (HS code 0901.21) from Brazil to Poland. CIF value €3,200, freight €180, insurance €25. Show the applied tariff rules.",
  },
  {
    name: "backtestRules",
    label: "Backtest Rules",
    category: "Trading",
    description: "Entry/exit rules on historical candle data with aggregate stats.",
    exampleGoal:
      "Backtest a strategy on AAPL: buy when the 10-day SMA crosses above the 30-day SMA, sell when it crosses below. Use the last 3 years of daily candles. Show win rate, average R-multiple, and max drawdown.",
  },
  {
    name: "assessClaim",
    label: "Insurance Claim",
    category: "Insurance",
    description: "Deductible, depreciation, under-insurance factor and policy limits.",
    exampleGoal:
      "Assess an insurance claim: item replacement value €2,400, item age 3 years, annual depreciation 15%, policy deductible €200, declared value €1,800, actual value €2,400, policy limit €5,000. Should the claim be approved?",
  },
  {
    name: "screenCandidates",
    label: "Screen Candidates",
    category: "HR",
    description: "Weighted rubric scoring — no protected characteristics accepted.",
    exampleGoal:
      "Screen two candidates for a senior backend engineer role. Required skills: TypeScript (weight 5), PostgreSQL (weight 4), system design (weight 4). Nice-to-have: Kubernetes (weight 2), Rust (weight 1). Candidate A: TypeScript 5/5, PostgreSQL 4/5, system design 3/5, Kubernetes 2/5. Candidate B: TypeScript 4/5, PostgreSQL 5/5, system design 5/5, Rust 3/5.",
  },
  {
    name: "explodeRecipeCost",
    label: "Recipe BOM Cost",
    category: "F&B",
    description: "Recursive BOM explosion to leaf ingredients with purchase list.",
    exampleGoal:
      "Explode the cost of pizza margherita for 4 portions. Flour costs 0.002 PLN/g, mozzarella 0.04 PLN/g, canned tomatoes 0.005 PLN/g, olive oil 0.02 PLN/ml, basil 0.08 PLN/g. I have 500g of flour in stock. What's the total cost and purchase list?",
  },
  {
    name: "simulatePVPayback",
    label: "Solar Payback",
    category: "Energy",
    description: "8760-step hourly photovoltaic simulation with payback period.",
    exampleGoal:
      "Simulate a 6 kWp rooftop PV system in Warsaw (latitude 52.2°N). Annual irradiance 1,050 kWh/m², panel efficiency 20%, system losses 14%. Electricity price €0.22/kWh, grid export price €0.08/kWh, self-consumption 40%. Installation cost €7,200. What's the payback period?",
  },
  {
    name: "calculateNetSalary",
    label: "Net Salary (PL)",
    category: "HR",
    description: "Polish net salary for UoP, zlecenie or B2B by year.",
    exampleGoal:
      "Calculate the net salary for a gross monthly salary of 12,000 PLN under a standard employment contract (UoP) in 2024. The employee is under 26 (no PIT relief), has a standard cost of obtaining income, and lives in a different city from their employer.",
  },
  {
    name: "proposeRepricing",
    label: "Repricing Proposal",
    category: "Retail",
    description: "Optimal prices using demand elasticity and competitor data.",
    exampleGoal:
      "Propose repricing for product SKU-001 (current price €29.99, cost €12.00, min margin 30%). Demand elasticity -1.8, competitor price €27.50. Cooldown 7 days, last price change was 10 days ago. What price maximises revenue without going below margin floor?",
  },
  {
    name: "runCode",
    label: "Run JS Code",
    category: "Dev",
    description: "Execute JavaScript in an isolated sandbox — no network access.",
    exampleGoal:
      "Write and run JavaScript code to compute the first 20 Fibonacci numbers and return them as a JSON array. Then calculate the ratio between consecutive terms and show how it converges to the golden ratio (1.618...).",
  },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type Step = "pick" | "configure" | "done";

interface TutorialPageProps {
  onRun: (workflowId: string) => void;
}

export function TutorialPage({ onRun }: TutorialPageProps) {
  const [step, setStep] = useState<Step>("pick");
  const [selected, setSelected] = useState<ToolDemo | null>(null);
  const [goal, setGoal] = useState("");
  const { mutate, isPending, error } = useSubmitTask();

  const handlePick = (demo: ToolDemo) => {
    setSelected(demo);
    setGoal(demo.exampleGoal);
    setStep("configure");
  };

  const handleSubmit = () => {
    if (!goal.trim()) return;
    mutate(
      { goal: goal.trim() },
      {
        onSuccess: ({ workflowId }) => {
          setStep("done");
          onRun(workflowId);
        },
      },
    );
  };

  if (step === "pick") {
    return (
      <div className="h-full overflow-y-auto">
        <div className="mx-auto max-w-4xl px-6 py-5">
          <h1 className="mb-1 text-sm font-semibold text-white">Interactive Tutorial</h1>
          <p className="mb-5 text-xs text-[#52525b]">
            Pick a tool to see an example workflow in action.
          </p>

          <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
            {TOOL_DEMOS.map((demo) => (
              <button
                key={demo.name}
                type="button"
                onClick={() => handlePick(demo)}
                className={cn(
                  "group flex flex-col items-start gap-1.5 rounded-md border border-border",
                  "bg-surface px-4 py-3 text-left transition-colors",
                  "hover:border-accent/40 hover:bg-surface-2",
                )}
              >
                <div className="flex w-full items-center justify-between">
                  <span className="text-xs font-semibold text-white">{demo.label}</span>
                  <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-[#52525b]">
                    {demo.category}
                  </span>
                </div>
                <p className="text-xs leading-relaxed text-[#71717a] group-hover:text-[#a1a1aa]">
                  {demo.description}
                </p>
                <span className="mt-0.5 font-mono text-[10px] text-[#3f3f46] group-hover:text-accent/60">
                  {demo.name}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (step === "configure" && selected) {
    return (
      <div className="h-full overflow-y-auto">
        <div className="mx-auto max-w-2xl px-6 py-5">
          <button
            type="button"
            onClick={() => setStep("pick")}
            className="mb-4 flex items-center gap-1.5 text-xs text-[#52525b] transition-colors hover:text-white"
          >
            <span>←</span> Back to tool list
          </button>

          <div className="mb-4 rounded-md border border-border bg-surface px-4 py-3">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-white">{selected.label}</span>
              <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-[#52525b]">
                {selected.category}
              </span>
            </div>
            <p className="mt-1 text-xs text-[#71717a]">{selected.description}</p>
          </div>

          <label className="mb-1.5 block text-xs font-medium text-[#a1a1aa]" htmlFor="goal-editor">
            Task goal
          </label>
          <p className="mb-2 text-xs text-[#3f3f46]">
            Edit the example or write your own. The agent will use{" "}
            <span className="font-mono text-accent/70">{selected.name}</span> to answer.
          </p>
          <textarea
            id="goal-editor"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            rows={8}
            className={cn(
              "mb-3 w-full resize-none rounded border bg-surface-2 px-3 py-2.5",
              "font-sans text-sm leading-relaxed text-white placeholder-[#3f3f46]",
              "border-border-2 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent",
              "transition-colors",
            )}
          />
          {error && (
            <p className="mb-2 text-xs text-ev-error">
              {error instanceof Error ? error.message : "Submission failed"}
            </p>
          )}
          <div className="flex items-center justify-between">
            <p className="text-xs text-[#3f3f46]">
              After submitting, the Inspector tab opens automatically.
            </p>
            <Button type="button" onClick={handleSubmit} loading={isPending} size="sm">
              Run workflow
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // step === "done" — transient state, onRun navigates away immediately
  return (
    <div className="flex h-full items-center justify-center">
      <p className="text-sm text-[#52525b]">Launching…</p>
    </div>
  );
}
