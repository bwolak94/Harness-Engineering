import { useState } from "react";
import { Button } from "../../../shared/ui/button.js";
import { useSubmitTask } from "../api/use-submit-task.js";

interface SubmitFormProps {
  onSubmitted: (workflowId: string) => void;
}

export function SubmitForm({ onSubmitted }: SubmitFormProps) {
  const [goal, setGoal] = useState("");
  const { mutate, isPending, error } = useSubmitTask();

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!goal.trim()) return;
    mutate(
      { goal: goal.trim() },
      {
        onSuccess: ({ workflowId }) => {
          setGoal("");
          onSubmitted(workflowId);
        },
      },
    );
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2">
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
      {error && (
        <p className="text-xs text-ev-error">
          {error instanceof Error ? error.message : "Unknown error"}
        </p>
      )}
      <Button type="submit" loading={isPending} size="sm" className="self-end">
        Run ⌘↵
      </Button>
    </form>
  );
}
