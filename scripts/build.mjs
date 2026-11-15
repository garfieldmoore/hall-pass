// Bundles the Action and the backtest CLI into single files under dist/, so a
// consumer run installs nothing. dist/ is committed; CI fails if it drifts.
import { build } from "esbuild";
import { writeFile } from "node:fs/promises";

// Some transitive deps still call require(); give the ESM bundle one.
const banner = {
  js: "import { createRequire as __pcCreateRequire } from 'node:module'; const require = __pcCreateRequire(import.meta.url);",
};

const common = {
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  banner,
  legalComments: "none",
  logLevel: "info",
};

await build({ ...common, entryPoints: ["src/main.ts"], outfile: "dist/index.js" });
await build({ ...common, entryPoints: ["src/backtest.ts"], outfile: "dist/backtest.js" });

// The repo's package.json says "type": "module", but the Action runner loads
// dist/index.js on its own; pin the module type next to the bundle as well.
await writeFile("dist/package.json", JSON.stringify({ type: "module" }, null, 2) + "\n");
