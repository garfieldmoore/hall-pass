import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { classifiers as registry } from "./classifiers/index.js";
import { parseConfig } from "./config.js";
import { DOCS_CONFIG } from "./testing/configs.js";

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------


describe("config", () => {
  it("the shipped examples/hall-pass.yml is valid", () => {
    const text = readFileSync(new URL("../examples/hall-pass.yml", import.meta.url), "utf8");
    const r = parseConfig(text, registry);
    expect(r.kind).toBe("ok");
    expect(r.kind === "ok" && r.config.actions.mergeWhenClean).toBe(false);
  });

  it("accepts the example config", () => {
    expect(parseConfig(DOCS_CONFIG("shadow"), registry).kind).toBe("ok");
  });

  it.each([
    ["unknown top-level key", DOCS_CONFIG("active", "surprise: true")],
    ["unknown classifier id", DOCS_CONFIG("active", "  not-a-classifier:\n    mode: active")],
    ["bad mode", DOCS_CONFIG("sometimes")],
    ["wrong version", DOCS_CONFIG().replace("version: 1", "version: 2")],
    ["bad merge method", DOCS_CONFIG().replace("mergeMethod: squash", "mergeMethod: yolo")],
    ["classifier schema failure", DOCS_CONFIG().replace('allow: ["docs/**", "adr/**", "**/*.md", "**/*.mdx"]', "allow: []")],
    ["not YAML", "version: [1"],
  ])("%s is a config error", (_, text) => {
    const r = parseConfig(text, registry);
    expect(r.kind).toBe("error");
  });

  it("names the problem", () => {
    const r = parseConfig(DOCS_CONFIG("active", "  not-a-classifier:\n    mode: active"), registry);
    expect(r.kind === "error" && r.message).toContain('unknown classifier "not-a-classifier"');
  });

  it("approve and autoMerge default to off when omitted", () => {
    const r = parseConfig("version: 1\nclassifiers: {}\n", registry);
    expect(r.kind === "ok" && r.config.actions).toMatchObject({ approve: false, autoMerge: false });
  });
});
