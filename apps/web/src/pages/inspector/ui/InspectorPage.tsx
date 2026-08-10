import { useWorkflowStore } from "../../../entities/workflow/index.js";
import { ChatPane } from "../../../widgets/ChatPane/index.js";
import { EventStreamPane } from "../../../widgets/EventStreamPane/index.js";

// ---------------------------------------------------------------------------
// InspectorPage — two-panel layout: chat (left) · events (right)
// ---------------------------------------------------------------------------

export function InspectorPage() {
  const { state, events, allEvents, status, lagged, subscribe, reset } = useWorkflowStore();

  const handleWorkflowStarted = (workflowId: string) => {
    subscribe(workflowId);
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-canvas text-white">
      {/* Chat panel — 40% */}
      <ChatPane
        state={state}
        events={allEvents}
        onWorkflowStarted={handleWorkflowStarted}
        onClearHistory={reset}
        className="w-[40%] min-w-[280px]"
      />

      {/* Event stream panel — 60% */}
      <EventStreamPane events={events} status={status} lagged={lagged} className="flex-1 min-w-0" />
    </div>
  );
}
