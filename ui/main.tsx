import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./tokens.css"; // color source of truth — must load before any component CSS
import App from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
