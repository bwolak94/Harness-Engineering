import { useState } from "react";
import { useTemplateStore } from "../../../entities/template/index.js";
import { cn } from "../../../shared/lib/cn.js";
import { Button } from "../../../shared/ui/button.js";
import { useSubmitTask } from "../api/use-submit-task.js";

interface SubmitFormProps {
  onSubmitted: (workflowId: string) => void;
}

export function SubmitForm({ onSubmitted }: SubmitFormProps) {
  const [goal, setGoal] = useState("");
  const [saveName, setSaveName] = useState("");
  const [showSaveInput, setShowSaveInput] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [multiAgent, setMultiAgent] = useState(false);

  const { mutate, isPending, error } = useSubmitTask();
  const { templates, save: saveTemplate, remove: removeTemplate } = useTemplateStore();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!goal.trim()) return;
    mutate(
      { goal: goal.trim(), multiAgent },
      {
        onSuccess: ({ workflowId }) => {
          setGoal("");
          onSubmitted(workflowId);
        },
      },
    );
  };

  const handleSaveTemplate = () => {
    if (!saveName.trim() || !goal.trim()) return;
    saveTemplate(saveName.trim(), goal.trim());
    setSaveName("");
    setShowSaveInput(false);
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2">
      {/* Templates panel */}
      {templates.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowTemplates((v) => !v)}
            className="mb-1.5 flex items-center gap-1 text-[10px] font-medium text-[#52525b] transition-colors hover:text-[#a1a1aa]"
          >
            <span>{showTemplates ? "▴" : "▾"}</span>
            Templates ({templates.length})
          </button>
          {showTemplates && (
            <div className="mb-2 flex flex-col gap-1">
              {templates.map((t) => (
                <div
                  key={t.id}
                  className="flex items-center justify-between gap-2 rounded border border-border px-2 py-1.5"
                >
                  <button
                    type="button"
                    onClick={() => {
                      setGoal(t.goal);
                      setShowTemplates(false);
                    }}
                    className="min-w-0 flex-1 truncate text-left text-xs text-[#a1a1aa] transition-colors hover:text-white"
                    title={t.goal}
                  >
                    {t.name}
                  </button>
                  <button
                    type="button"
                    onClick={() => removeTemplate(t.id)}
                    className="shrink-0 text-[10px] text-[#3f3f46] transition-colors hover:text-ev-error"
                    title="Delete template"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <label className="text-xs font-medium text-[#a1a1aa]" htmlFor="goal-input">
        Task goal
      </label>
      <textarea
        id="goal-input"
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            handleSubmit(e as unknown as React.FormEvent);
          }
        }}
        placeholder="Describe the task for the agent…"
        rows={3}
        className={[
          "w-full resize-none rounded border bg-surface-2 px-3 py-2",
          "font-sans text-sm text-white placeholder-[#52525b]",
          "border-border-2 focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent",
          "transition-colors",
        ].join(" ")}
      />

      {/* Multi-agent toggle */}
      <label className="flex cursor-pointer items-center gap-2 self-start">
        <div className="relative">
          <input
            type="checkbox"
            className="sr-only"
            checked={multiAgent}
            onChange={(e) => setMultiAgent(e.target.checked)}
          />
          <div
            className={cn(
              "h-4 w-7 rounded-full transition-colors",
              multiAgent ? "bg-accent" : "bg-[#3f3f46]",
            )}
          />
          <div
            className={cn(
              "absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-transform",
              multiAgent ? "translate-x-3.5" : "translate-x-0.5",
            )}
          />
        </div>
        <span className="text-[11px] text-[#71717a]">Multi-agent routing</span>
      </label>

      {error && (
        <p className="text-xs text-ev-error">
          {error instanceof Error ? error.message : "Unknown error"}
        </p>
      )}

      <div className="flex items-center justify-between gap-2">
        {/* Save as template */}
        <div className="flex items-center gap-1.5">
          {!showSaveInput && goal.trim() && (
            <button
              type="button"
              onClick={() => setShowSaveInput(true)}
              className="text-[10px] text-[#3f3f46] transition-colors hover:text-[#a1a1aa]"
            >
              save template
            </button>
          )}
          {showSaveInput && (
            <>
              <input
                type="text"
                value={saveName}
                onChange={(e) => setSaveName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleSaveTemplate();
                  }
                  if (e.key === "Escape") setShowSaveInput(false);
                }}
                placeholder="Template name"
                className={cn(
                  "rounded border border-border-2 bg-canvas px-2 py-0.5",
                  "text-[11px] text-white placeholder-[#3f3f46]",
                  "focus:border-accent focus:outline-none",
                )}
              />
              <button
                type="button"
                onClick={handleSaveTemplate}
                className="text-[10px] text-accent transition-colors hover:text-white"
              >
                save
              </button>
              <button
                type="button"
                onClick={() => setShowSaveInput(false)}
                className="text-[10px] text-[#3f3f46] transition-colors hover:text-[#a1a1aa]"
              >
                cancel
              </button>
            </>
          )}
        </div>

        <Button type="submit" loading={isPending} size="sm" className="self-end">
          Run ⌘↵
        </Button>
      </div>
    </form>
  );
}
