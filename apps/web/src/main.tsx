import "./index.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Providers } from "./app/providers.js";
import { InspectorPage } from "./pages/inspector/index.js";

const root = document.getElementById("root");
if (!root) throw new Error("Root element #root not found");

createRoot(root).render(
  <StrictMode>
    <Providers>
      <InspectorPage />
    </Providers>
  </StrictMode>,
);
