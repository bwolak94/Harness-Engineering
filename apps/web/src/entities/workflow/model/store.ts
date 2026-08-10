import type { HarnessEvent } from "@harness/contracts";
import { initialWorkflowState, reduce } from "@harness/core";
import type { WorkflowState } from "@harness/core";
import { create } from "zustand";
import { HarnessSocket } from "../../../shared/transport/harness-socket.js";
import type { ConnectionStatus } from "../../../shared/transport/harness-socket.js";

// ---------------------------------------------------------------------------
// WorkflowStore — Zustand store for live workflow state (entities layer)
//
// State is computed using the SAME reducer from packages/core.
// The client has no separate state logic — divergence from the server
// is structurally impossible.
//
// TanStack Query handles HTTP requests (server state).
// This Zustand store handles the WS event stream (client-side live state).
// ---------------------------------------------------------------------------

export interface WorkflowStore {
  // Current workflow
  workflowId: string | null;
  // Events from the current workflow only (resets on subscribe)
  events: HarnessEvent[];
  // All events from all workflows since page load — drives the chat transcript
  allEvents: HarnessEvent[];
  // Workflow state computed incrementally by the reducer
  state: WorkflowState | null;
  // WS connection status
  status: ConnectionStatus;
  // Whether the server sent stream.lagged (client should show a warning)
  lagged: boolean;

  // Actions
  subscribe(workflowId: string): void;
  unsubscribe(): void;
  reset(): void;
}

// Single shared socket instance — one active workflow at a time.
const socket = new HarnessSocket();

export const useWorkflowStore = create<WorkflowStore>((set, get) => {
  // Wire socket callbacks once (outside state) to avoid re-registering on every render.
  socket.onEvent((event) => {
    const { workflowId, state, events, allEvents } = get();
    if (event.workflowId !== workflowId) return;

    const prevState = state ?? initialWorkflowState(event.workflowId);
    const nextState = reduce(prevState, event);

    set({ events: [...events, event], allEvents: [...allEvents, event], state: nextState });
  });

  socket.onStatus((status) => {
    set({ status });
  });

  socket.onLagged(() => {
    set({ lagged: true });
  });

  return {
    workflowId: null,
    events: [],
    allEvents: [],
    state: null,
    status: "disconnected",
    lagged: false,

    subscribe(workflowId: string) {
      set({
        workflowId,
        events: [],
        // allEvents intentionally NOT cleared — preserves chat history across workflows
        state: initialWorkflowState(workflowId),
        lagged: false,
      });
      socket.connect(workflowId, 0);
    },

    unsubscribe() {
      socket.disconnect();
      set({ status: "disconnected" });
    },

    reset() {
      socket.disconnect();
      set({
        workflowId: null,
        events: [],
        allEvents: [],
        state: null,
        status: "disconnected",
        lagged: false,
      });
    },
  };
});
