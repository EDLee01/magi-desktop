import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";
import { Familiar } from "./Familiar";
import "./styles.css";

const mode = new URLSearchParams(window.location.search).get("mode");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {mode === "familiar" ? <Familiar /> : <App />}
  </StrictMode>
);
