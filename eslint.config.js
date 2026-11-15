import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", ".backtest-cache/**", "coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: { globals: { console: "readonly", process: "readonly" } },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  {
    // Shared test helpers must never end up in the bundle.
    files: ["src/**/*.ts"],
    ignores: ["src/**/*.test.ts", "src/testing/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [{ group: ["**/testing/*", "./testing/*", "../testing/*"], message: "src/testing is for tests only." }] },
      ],
    },
  },
);
