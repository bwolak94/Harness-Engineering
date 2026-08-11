import { create } from "zustand";
import { persist } from "zustand/middleware";

// ---------------------------------------------------------------------------
// WorkflowTemplate — a saved goal that can be re-used across sessions.
// Persisted to localStorage (key: harness:templates:v1).
// ---------------------------------------------------------------------------

export interface WorkflowTemplate {
  id: string;
  name: string;
  goal: string;
  createdAt: string;
}

export interface TemplateStore {
  templates: WorkflowTemplate[];
  save(name: string, goal: string): void;
  remove(id: string): void;
}

export const useTemplateStore = create<TemplateStore>()(
  persist(
    (set, get) => ({
      templates: [],

      save(name: string, goal: string) {
        const id = `tpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        set({
          templates: [...get().templates, { id, name, goal, createdAt: new Date().toISOString() }],
        });
      },

      remove(id: string) {
        set({ templates: get().templates.filter((t) => t.id !== id) });
      },
    }),
    { name: "harness:templates:v1" },
  ),
);
