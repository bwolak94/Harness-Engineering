import type { ReactNode } from "react";
import { useState } from "react";
import { cn } from "../shared/lib/cn.js";

export type AppTab = "inspector" | "history" | "tutorial" | "analytics";

const TABS: { id: AppTab; label: string }[] = [
  { id: "inspector", label: "Inspector" },
  { id: "history", label: "History" },
  { id: "tutorial", label: "Tutorial" },
  { id: "analytics", label: "Analytics" },
];

interface AppShellProps {
  children: (tab: AppTab, navigate: (tab: AppTab) => void) => ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const [tab, setTab] = useState<AppTab>("inspector");

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-canvas text-white">
      <nav className="flex h-9 shrink-0 items-center gap-0.5 border-b border-border bg-surface px-3">
        <span className="mr-4 font-mono text-[10px] font-bold tracking-[0.2em] text-accent">
          HARNESS
        </span>
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={cn(
              "rounded px-2.5 py-1 text-xs font-medium transition-colors",
              tab === t.id
                ? "bg-accent/10 text-accent"
                : "text-[#71717a] hover:bg-surface-2 hover:text-white",
            )}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <div className="min-h-0 flex-1">{children(tab, setTab)}</div>
    </div>
  );
}
