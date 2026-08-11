import "./index.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppShell } from "./app/AppShell.js";
import { Providers } from "./app/providers.js";
import { useWorkflowStore } from "./entities/workflow/index.js";
import { AnalyticsPage } from "./pages/analytics/index.js";
import { FlowsPage } from "./pages/flows/index.js";
import { HistoryPage } from "./pages/history/index.js";
import { InspectorPage } from "./pages/inspector/index.js";
import { McpRegistryPage } from "./pages/mcp-registry/index.js";
import { SandboxPage } from "./pages/sandbox/index.js";
import { TutorialPage } from "./pages/tutorial/index.js";

function App() {
  const { subscribe } = useWorkflowStore();

  return (
    <AppShell>
      {(tab, navigate) => {
        if (tab === "inspector") return <InspectorPage />;
        if (tab === "history") return <HistoryPage />;
        if (tab === "tutorial") {
          return (
            <TutorialPage
              onRun={(workflowId) => {
                subscribe(workflowId);
                navigate("inspector");
              }}
            />
          );
        }
        if (tab === "analytics") return <AnalyticsPage />;
        if (tab === "sandbox") return <SandboxPage />;
        if (tab === "registry") return <McpRegistryPage />;
        if (tab === "flows") {
          return (
            <FlowsPage
              onInspectWorkflow={(workflowId) => {
                subscribe(workflowId);
                navigate("inspector");
              }}
            />
          );
        }
        return null;
      }}
    </AppShell>
  );
}

const root = document.getElementById("root");
if (!root) throw new Error("Root element #root not found");

createRoot(root).render(
  <StrictMode>
    <Providers>
      <App />
    </Providers>
  </StrictMode>,
);
