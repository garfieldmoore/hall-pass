import { describe, expect, it } from "vitest";
import { BEHAVIOURAL_DENY, pathCategory, pathCategoryConfigSchema } from "../../src/classifiers/path-category.js";
import type { PrFile } from "../../src/types.js";
import { added, docsOnly, modified, prContext, removed, renamed } from "../fixtures/context.js";

const cfg = pathCategoryConfigSchema.parse(docsOnly);
const run = (files: PrFile[], c = cfg) => pathCategory.run(prContext({ files }), c);

describe("path-category: core cases", () => {
  it("only docs/guide.md changed: eligible, docs-only", async () => {
    expect(await run([modified("docs/guide.md")])).toMatchObject({ result: "eligible", category: "docs-only" });
  });

  it("docs/guide.md and src/index.ts changed: abstain", async () => {
    const v = await run([modified("docs/guide.md"), modified("src/index.ts")]);
    expect(v.result).toBe("abstain");
    expect(v.result === "abstain" && v.note).toContain("src/index.ts: not in allow list");
  });

  it("packages/agent/CLAUDE.md changed: abstain, because it's denied", async () => {
    expect((await run([modified("packages/agent/CLAUDE.md")])).result).toBe("abstain");
  });

  it(".github/pull_request_template.md changed: abstain, because .github/** is denied", async () => {
    expect((await run([modified(".github/pull_request_template.md")])).result).toBe("abstain");
  });

  it("src/a.ts renamed to docs/a.md: abstain, because the old path doesn't match", async () => {
    const v = await run([renamed("src/a.ts", "docs/a.md")]);
    expect(v.result).toBe("abstain");
    expect(v.result === "abstain" && v.note).toContain("src/a.ts");
  });

  it("a deleted docs file: eligible", async () => {
    expect((await run([removed("docs/old.md")])).result).toBe("eligible");
  });

  it("no changed files: abstain", async () => {
    expect(await run([])).toEqual({ result: "abstain", note: "no changed files" });
  });
});

describe("path-category: markdown that is behaviour, not docs", () => {
  // Every one of these is markdown, so it matches the **/*.md allow glob.
  // Each must still abstain. None of them is in the config's deny list:
  // the built-in behavioural deny list has to catch them on its own.
  const behavioural = [
    "SKILL.md",
    ".cursor/skills/tdd-red-green-refactor/SKILL.md",
    "skills/release/SKILL.md",
    "skills.md",
    "docs/Skills.md",
    "tools/skill.md",
    "packages/x/skills/deploy/notes.md",
    ".claude/commands/review.md",
    ".claude/agents/reviewer.md",
    ".cursor/rules/security-api-design.md",
    ".agents/skills/find-skills/SKILL.md",
    "AGENT.md",
    "GEMINI.md",
    "CLAUDE.local.md",
    "claude.md",
    "services/api/agents.md",
    "agents/catan/instructions.md",
    "agents/catan/assets/catan-official-rules.md",
    "docs/copilot-instructions.md",
    "src/reviewer.instructions.md",
    "app/review.prompt.md",
    "lib/prompts/system.md",
    "SOUL.md",
    "IDENTITY.md",
    "MEMORY.md",
    ".github/copilot-instructions.md",
    "services/api/.github/ISSUE_TEMPLATE/bug.md",
    ".windsurf/rules/style.md",
    ".clinerules/style.md",
    ".kiro/steering/product.md",
  ];

  const noBuiltInDenyInConfig = pathCategoryConfigSchema.parse({
    categories: { "docs-only": { allow: ["**/*.md", "**/*.mdx", "docs/**"] } },
  });

  it.each(behavioural)("%s: abstain", async (path) => {
    const v = await run([modified(path)], noBuiltInDenyInConfig);
    expect(v.result).toBe("abstain");
    expect(v.result === "abstain" && v.note).toContain("behavioural file");
  });

  it("one behavioural file sinks an otherwise docs-only PR", async () => {
    const v = await run([modified("docs/guide.md"), modified("README.md"), added(".claude/skills/new/SKILL.md")]);
    expect(v.result).toBe("abstain");
  });

  it("renaming a skill into docs/ is still a skill change", async () => {
    expect((await run([renamed(".cursor/skills/x/SKILL.md", "docs/x.md")])).result).toBe("abstain");
  });

  it("a config cannot allow its way past the built-in list", async () => {
    const permissive = pathCategoryConfigSchema.parse({
      categories: { "docs-only": { allow: ["**"], deny: [] } },
    });
    expect((await run([modified(".cursor/skills/a/SKILL.md")], permissive)).result).toBe("abstain");
    expect((await run([modified(".github/workflows/ci.yml")], permissive)).result).toBe("abstain");
  });

  it("plain docs that only mention skills or agents still qualify", async () => {
    const v = await run([modified("docs/writing-skills.md"), modified("docs/agent-architecture.md"), modified("README.md")]);
    expect(v.result).toBe("eligible");
  });

  it("built-in list always covers .github/**", () => {
    expect(BEHAVIOURAL_DENY).toContain(".github/**");
  });
});

describe("path-category: other negatives and edges", () => {
  it("non-markdown outside docs/: abstain", async () => {
    expect((await run([modified("package.json")])).result).toBe("abstain");
  });

  it("CHANGELOG.md is denied by config", async () => {
    expect((await run([modified("packages/a/CHANGELOG.md")])).result).toBe("abstain");
  });

  it("deny globs are case-insensitive", async () => {
    expect((await run([modified("packages/a/changelog.md")])).result).toBe("abstain");
  });

  it("allow globs are case-sensitive: README.MD is not **/*.md", async () => {
    expect((await run([modified("README.MD")])).result).toBe("abstain");
  });

  it("dotfiles under docs/ match (dot: true)", async () => {
    expect((await run([modified("docs/.vitepress/notes.md")])).result).toBe("eligible");
  });

  it("an added image under docs/ qualifies", async () => {
    expect((await run([added("docs/img/diagram.png"), modified("docs/guide.md")])).result).toBe("eligible");
  });

  it("several matching categories: reports the first, lists the rest", async () => {
    const two = pathCategoryConfigSchema.parse({
      categories: { "docs-only": { allow: ["docs/**"] }, "any-markdown": { allow: ["**/*.md"] } },
    });
    const v = await run([modified("docs/guide.md")], two);
    expect(v).toMatchObject({ result: "eligible", category: "docs-only" });
    expect(v.result === "eligible" && v.evidence.join(" ")).toContain("also matches: any-markdown");
  });

  it("long abstain notes are capped", async () => {
    const files = Array.from({ length: 50 }, (_, i) => modified(`src/f${i}.ts`));
    const v = await run(files);
    expect(v.result === "abstain" && v.note).toContain("and 40 more");
  });
});

describe("path-category config schema", () => {
  it("rejects a category without an allow list", () => {
    expect(pathCategoryConfigSchema.safeParse({ categories: { "docs-only": { deny: [] } } }).success).toBe(false);
  });
  it("rejects unknown keys", () => {
    expect(pathCategoryConfigSchema.safeParse({ ...docsOnly, extra: 1 }).success).toBe(false);
  });
  it("rejects no categories", () => {
    expect(pathCategoryConfigSchema.safeParse({ categories: {} }).success).toBe(false);
  });
});
