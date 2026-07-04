import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite root = repo root; index.html is the viewer entry.
export default defineConfig({
  plugins: [react()],
});
