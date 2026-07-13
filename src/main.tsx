import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { DesignSystemProvider } from "./components/DesignSystemProvider";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <DesignSystemProvider>
      <App />
    </DesignSystemProvider>
  </StrictMode>,
);
