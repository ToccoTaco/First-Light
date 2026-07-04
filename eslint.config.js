import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  { ignores: ["dist", "generated"] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
  },
  {
    // DHTMLX is isolated behind ui/gantt-adapter.ts so the renderer stays
    // swappable (CLAUDE.md architecture call). No other file may import it —
    // enforced here since there's no other mechanical guard. The adapter itself
    // is exempted by the block right after this one.
    files: ["**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "dhtmlx-gantt",
              message:
                "Import DHTMLX only from ui/gantt-adapter.ts — the renderer must stay isolated behind the adapter so it's swappable.",
            },
          ],
          patterns: [
            {
              group: ["dhtmlx-gantt", "dhtmlx-gantt/*"],
              message:
                "Import DHTMLX only from ui/gantt-adapter.ts — the renderer must stay isolated behind the adapter so it's swappable.",
            },
          ],
        },
      ],
    },
  },
  {
    // Engine purity (§3): the pure core imports NOTHING external, ever — no packages,
    // and nothing from the ui / storage / dashboard / scripts layers. Test files are
    // exempt so they may import vitest.
    files: ["engine/**/*.ts"],
    ignores: ["engine/**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "../ui",
                "../ui/**",
                "../storage",
                "../storage/**",
                "../dashboard",
                "../dashboard/**",
                "../scripts",
                "../scripts/**",
              ],
              message:
                "engine/ is a pure core — it must not import from other layers (ui, storage, dashboard, scripts).",
            },
            {
              regex: "^(?!\\.).+",
              message:
                "engine/ is a pure core — no external/package imports. Import only sibling engine modules via ./.",
            },
          ],
        },
      ],
    },
  },
  {
    // The one sanctioned home for the DHTMLX import (see the restriction above).
    files: ["ui/gantt-adapter.ts"],
    rules: {
      "no-restricted-imports": "off",
    },
  },
  prettier,
);
