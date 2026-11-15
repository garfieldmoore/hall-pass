import { describe, expect, it } from "vitest";
import { z } from "zod";
import { classifiers as registry } from "../src/classifiers/index.js";
import { loadConfig, parseConfig, type ConfiguredClassifier } from "../src/config.js";
import type { PullLike } from "../src/context.js";
import { GitHubOps } from "../src/github.js";
import { aggregate, decisionText, runClassifiers, runPullRequest } from "../src/runner.js";
import type { Classifier, PrFile, Verdict } from "../src/types.js";
import { added, modified, prContext } from "./fixtures/context.js";
import { BOT, fakeOctokit } from "./fixtures/fake-octokit.js";

// ---------------------------------------------------------------------------
// Test classifiers
// ---------------------------------------------------------------------------

const empty = z.object({});
function fixed(id: string, kind: Classifier["kind"], verdict: Verdict | (() => Promise<Verdict>)): Classifier<object> {
  return {
    id,
    kind,
    description: id,
    configSchema: empty,
    run: typeof verdict === "function" ? verdict : async () => verdict,
  };
}

const eligible = fixed("always-eligible", "eligibility", { result: "eligible", category: "docs-only", evidence: ["ok"] });
const abstain = fixed("always-abstain", "eligibility", { result: "abstain", note: "nope" });
const veto = fixed("always-veto", "veto", { result: "veto", reason: "touches billing", evidence: [] });
const pass = fixed("always-pass", "veto", { result: "pass" });
const throws = fixed("throws", "eligibility", async () => {
  throw new Error("boom");
});
const hangs = fixed("hangs", "eligibility", () => new Promise<Verdict>(() => {}));
const wrongKind = fixed("wrong-kind", "veto", { result: "eligible", category: "docs-only", evidence: [] });
const malformed = fixed("malformed", "eligibility", async () => ({ nope: true }) as unknown as Verdict);

const as = (c: Classifier<object>, mode: ConfiguredClassifier["mode"] = "active"): ConfiguredClassifier => ({
  classifier: c as Classifier<unknown>,
  mode,
  cfg: {},
});

const decide = async (...cs: ConfiguredClassifier[]) => aggregate(await runClassifiers(cs, prContext(), 50));

// ---------------------------------------------------------------------------
// Decision rules
// ---------------------------------------------------------------------------

describe("decision rules", () => {
  it("eligible with no veto: qualifies", async () => {
    const d = await decide(as(eligible), as(pass));
    expect(d).toMatchObject({ eligible: true, categories: ["docs-only"], vetoes: [] });
  });

  it("eligible with a veto: does not qualify", async () => {
    const d = await decide(as(eligible), as(veto));
    expect(d.eligible).toBe(false);
    expect(d.categories).toEqual([]);
    expect(d.vetoes).toEqual([{ id: "always-veto", reason: "touches billing" }]);
  });

  it("no eligible classifier: does not qualify", async () => {
    expect((await decide(as(abstain), as(pass))).eligible).toBe(false);
  });

  it("no active eligibility classifier at all: does not qualify", async () => {
    expect((await decide(as(pass))).eligible).toBe(false);
    expect((await decide()).eligible).toBe(false);
  });

  it("shadow verdicts are ignored, but reported", async () => {
    const d = await decide(as(eligible, "shadow"));
    expect(d.eligible).toBe(false);
    expect(d.runs).toHaveLength(1);
    expect(d.runs[0]).toMatchObject({ mode: "shadow", verdict: { result: "eligible" } });
  });

  it("a shadow veto does not block", async () => {
    expect((await decide(as(eligible), as(veto, "shadow"))).eligible).toBe(true);
  });

  it("off classifiers do not run", async () => {
    const d = await decide(as(eligible), as(veto, "off"));
    expect(d.eligible).toBe(true);
    expect(d.runs.map((r) => r.id)).toEqual(["always-eligible"]);
  });

  it("a thrown error counts as a veto", async () => {
    const d = await decide(as(eligible), as(throws));
    expect(d.eligible).toBe(false);
    expect(d.vetoes).toEqual([{ id: "throws", reason: "boom" }]);
    expect(d.runs.find((r) => r.id === "throws")?.error).toBe("boom");
  });

  it("a thrown error in shadow mode is reported only", async () => {
    const d = await decide(as(eligible), as(throws, "shadow"));
    expect(d.eligible).toBe(true);
    expect(d.runs.find((r) => r.id === "throws")?.error).toBe("boom");
  });

  it("a timeout counts as a veto", async () => {
    const d = await decide(as(eligible), as(hangs));
    expect(d.eligible).toBe(false);
    expect(d.vetoes[0]?.reason).toMatch(/timed out/);
  });

  it("a result of the wrong kind counts as a veto", async () => {
    const d = await decide(as(eligible), as(wrongKind));
    expect(d.eligible).toBe(false);
    expect(d.vetoes[0]?.reason).toMatch(/veto classifier but returned "eligible"/);
  });

  it("wording: issued, touches, failed, not eligible", async () => {
    const apiContract = fixed("api-contract", "veto", { result: "veto", reason: "changes openapi.yaml", evidence: [] });
    expect(decisionText(await decide(as(eligible)))).toBe("Hall pass issued: docs-only");
    expect(decisionText(await decide(as(eligible), as(apiContract)))).toBe("No hall pass: touches api-contract");
    expect(decisionText(await decide(as(eligible), as(throws)))).toBe("No hall pass: throws failed");
    expect(decisionText(await decide(as(abstain)))).toBe("No hall pass: not in an eligible category");
    expect(decisionText(await decide(as(eligible, "shadow")))).toBe("No hall pass: no active eligibility classifier");
  });

  it("a malformed verdict counts as a veto", async () => {
    expect((await decide(as(eligible), as(malformed))).eligible).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Config validation
// ---------------------------------------------------------------------------

const DOCS_CONFIG = (mode = "active", extra = "") => `
version: 1
actions:
  approve: true
  autoMerge: true
  mergeMethod: squash
  labels: true
  comment: true
classifiers:
  path-category:
    mode: ${mode}
    categories:
      docs-only:
        allow: ["docs/**", "adr/**", "**/*.md", "**/*.mdx"]
        deny: [".github/**", "**/CLAUDE.md", "**/AGENTS.md", "**/prompts/**", "**/CHANGELOG.md"]
${extra}`;

describe("config", () => {
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

// ---------------------------------------------------------------------------
// The full run against a mocked Octokit
// ---------------------------------------------------------------------------

function pull(over: Partial<PullLike> = {}): PullLike {
  return {
    number: 7,
    title: "docs: guide",
    body: "",
    draft: false,
    state: "open",
    user: { login: "dev" },
    labels: [],
    head: { ref: "docs", sha: "head1", repo: { full_name: "example-org/sandbox" } },
    base: { ref: "main", sha: "base1", repo: { full_name: "example-org/sandbox" } },
    ...over,
  };
}

interface Scenario {
  files?: PrFile[];
  config?: string | null;
  dryRun?: boolean;
  pull?: Partial<PullLike>;
  reg?: Classifier<unknown>[];
}

function setup(init: Parameters<typeof fakeOctokit>[0] = {}) {
  const fake = fakeOctokit({ configText: DOCS_CONFIG(), ...init });
  const repo = { owner: "example-org", name: "sandbox" };
  const logs: string[] = [];
  const go = (sc: Scenario = {}) => {
    const p = pull(sc.pull);
    const reg = sc.reg ?? (registry as Classifier<unknown>[]);
    const text = sc.config === undefined ? fake.state.configText : sc.config;
    fake.state.configText = text;
    return runPullRequest({
      pull: p,
      repo,
      dryRun: sc.dryRun ?? false,
      ops: new GitHubOps(fake.octokit, repo),
      // The real loader, against the fake: proves config comes from the base SHA.
      loadConfig: (baseSha) => loadConfig(fake.octokit, repo, baseSha, ".github/hall-pass.yml", reg),
      buildContext: async () => prContext({ files: sc.files ?? [modified("docs/guide.md")], headSha: p.head.sha }),
      log: { info: (m) => logs.push(m), warning: (m) => logs.push(`WARN ${m}`) },
      timeoutMs: 50,
    });
  };
  return { ...fake, go, logs };
}

const WRITES = [
  "issues.createComment",
  "issues.updateComment",
  "issues.addLabels",
  "issues.removeLabel",
  "pulls.createReview",
  "pulls.dismissReview",
  "pulls.merge",
  "graphql.enableAutoMerge",
  "graphql.disableAutoMerge",
];
const writes = (calls: string[]) => calls.filter((c) => WRITES.includes(c));
const lastCheck = (s: { checkRuns: { conclusion?: string; title?: string; summary?: string }[] }) => s.checkRuns.at(-1);

describe("runPullRequest", () => {
  it("docs-only PR: approves, turns on auto-merge, labels, comments, check run success", async () => {
    const t = setup();
    const out = await t.go();
    expect(out.status).toBe("decided");
    expect(t.state.reviews).toHaveLength(1);
    expect(t.state.reviews[0]).toMatchObject({ state: "APPROVED", commit_id: "head1", body: "Hall pass issued: docs-only" });
    expect(t.state.autoMergeBy).toBe("merge-bot");
    expect(t.state.labels).toEqual(["hall-pass:docs-only"]);
    expect(t.state.comments).toHaveLength(1);
    expect(t.state.comments[0]?.body).toContain("<!-- hall-pass -->");
    expect(t.state.comments[0]?.body).toContain("**Hall pass issued:** docs-only");
    expect(lastCheck(t.state)).toMatchObject({ conclusion: "success", title: "Hall pass issued: docs-only" });
  });

  it("reads config from the base commit", async () => {
    const t = setup();
    await t.go();
    expect(t.state.getContentRefs).toEqual(["base1"]);
  });

  it("running twice on the same commit: no duplicate approval, comment or label", async () => {
    const t = setup();
    await t.go();
    const before = t.state.calls.length;
    await t.go();
    const second = t.state.calls.slice(before);
    expect(writes(second)).toEqual([]);
    expect(t.state.reviews).toHaveLength(1);
    expect(t.state.comments).toHaveLength(1);
    expect(t.state.labels).toEqual(["hall-pass:docs-only"]);
  });

  it("docs/ and src/ changed: no approval; comment shows abstain", async () => {
    const t = setup();
    await t.go({ files: [modified("docs/a.md"), modified("src/index.ts")] });
    expect(t.state.reviews).toHaveLength(0);
    expect(t.state.autoMergeBy).toBeNull();
    expect(t.state.labels).toEqual([]);
    expect(t.state.comments[0]?.body).toMatch(/\| abstain \|/);
    expect(lastCheck(t.state)?.conclusion).toBe("success");
  });

  it("a SKILL.md change: no approval", async () => {
    const t = setup();
    await t.go({ files: [added(".cursor/skills/x/SKILL.md")] });
    expect(t.state.reviews).toHaveLength(0);
    expect(t.state.comments[0]?.body).toContain("behavioural file");
  });

  it("docs PR, then a src/ commit: dismisses merge-bot's approval, turns off its auto-merge, drops the label", async () => {
    const t = setup();
    await t.go();
    await t.go({ pull: { head: { ref: "docs", sha: "head2", repo: { full_name: "example-org/sandbox" } } }, files: [modified("docs/a.md"), modified("src/x.ts")] });
    expect(t.state.reviews[0]?.state).toBe("DISMISSED");
    expect(t.state.autoMergeBy).toBeNull();
    expect(t.state.labels).toEqual([]);
  });

  it("human turned on auto-merge for a non-docs PR: left alone", async () => {
    const t = setup({ autoMergeBy: "some-human" });
    await t.go({ files: [modified("src/x.ts")] });
    expect(t.state.autoMergeBy).toBe("some-human");
    expect(t.state.calls).not.toContain("graphql.disableAutoMerge");
  });

  it("human already turned on auto-merge on a docs PR: not re-enabled", async () => {
    const t = setup({ autoMergeBy: "some-human" });
    await t.go();
    expect(t.state.calls).not.toContain("graphql.enableAutoMerge");
    expect(t.state.reviews).toHaveLength(1);
  });

  it("a human's approval is never dismissed", async () => {
    const t = setup({ reviews: [{ id: 1, user: { login: "alice" }, state: "APPROVED", commit_id: "head1", body: "" }] });
    await t.go({ files: [modified("src/x.ts")] });
    expect(t.state.reviews[0]?.state).toBe("APPROVED");
  });

  it("a classifier that throws: no approval; the check run shows the error", async () => {
    const t = setup();
    const reg = [eligible, throws] as Classifier<unknown>[];
    const config = "version: 1\nactions: {approve: true, autoMerge: true}\nclassifiers:\n  always-eligible: {mode: active}\n  throws: {mode: active}\n";
    await t.go({ reg, config });
    expect(t.state.reviews).toHaveLength(0);
    expect(lastCheck(t.state)?.summary).toContain("boom");
    expect(lastCheck(t.state)?.summary).toContain("error → veto");
  });

  it("invalid config on the base branch: no writes; check run fails naming the problem", async () => {
    const t = setup();
    const out = await t.go({ config: DOCS_CONFIG("active", "  nope:\n    mode: active") });
    expect(out.status).toBe("config-error");
    expect(writes(t.state.calls)).toEqual([]);
    expect(lastCheck(t.state)).toMatchObject({ conclusion: "failure", title: "Config error" });
    expect(lastCheck(t.state)?.summary).toContain('unknown classifier "nope"');
  });

  it("no config on the base commit: neutral check run, nothing else", async () => {
    const t = setup({ configText: null });
    const out = await t.go({ config: null });
    expect(out.status).toBe("no-config");
    expect(writes(t.state.calls)).toEqual([]);
    expect(lastCheck(t.state)?.conclusion).toBe("neutral");
  });

  it("shadow mode: comment shows it would qualify; no approval or label", async () => {
    const t = setup({ configText: DOCS_CONFIG("shadow") });
    await t.go();
    expect(t.state.reviews).toHaveLength(0);
    expect(t.state.labels).toEqual([]);
    expect(t.state.comments[0]?.body).toContain("eligible (docs-only)");
    expect(t.state.comments[0]?.body).toContain("| shadow |");
  });

  it("draft PR: skipped with a neutral check run", async () => {
    const t = setup();
    const out = await t.go({ pull: { draft: true } });
    expect(out).toEqual({ status: "skipped", reason: "draft" });
    expect(lastCheck(t.state)?.conclusion).toBe("neutral");
    expect(writes(t.state.calls)).toEqual([]);
  });

  it("fork PR: skipped", async () => {
    const t = setup();
    const out = await t.go({ pull: { head: { ref: "x", sha: "head1", repo: { full_name: "someone/sandbox" } } } });
    expect(out).toEqual({ status: "skipped", reason: "fork" });
    expect(writes(t.state.calls)).toEqual([]);
  });

  it("closed PR: skipped", async () => {
    const t = setup();
    expect(await t.go({ pull: { state: "closed" } })).toEqual({ status: "skipped", reason: "closed" });
  });

  it("dry-run: check run and comment only", async () => {
    const t = setup();
    await t.go({ dryRun: true });
    expect(writes(t.state.calls)).toEqual(["issues.createComment"]);
    expect(t.state.comments[0]?.body).toContain("dry run");
    expect(lastCheck(t.state)?.conclusion).toBe("success");
  });

  it("actions.* flags are respected", async () => {
    const t = setup({ configText: DOCS_CONFIG().replace("approve: true", "approve: false").replace("comment: true", "comment: false") });
    await t.go();
    expect(t.state.reviews).toHaveLength(0);
    expect(t.state.comments).toHaveLength(0);
    expect(t.state.autoMergeBy).toBe("merge-bot");
  });

  it("a write failing partway rolls back the approval and fails the check run", async () => {
    const t = setup({ fail: { "graphql.enableAutoMerge": new Error("auto-merge is not allowed for this repository") } });
    const out = await t.go();
    expect(out.status).toBe("error");
    expect(t.state.reviews[0]?.state).toBe("DISMISSED");
    expect(lastCheck(t.state)?.conclusion).toBe("failure");
    expect(lastCheck(t.state)?.summary).toContain("auto-merge is not allowed");
    expect(lastCheck(t.state)?.summary).toContain("rolled back");
  });

  it("a runtime error building the context: no approval; check run fails", async () => {
    const t = setup();
    const repo = { owner: "example-org", name: "sandbox" };
    const out = await runPullRequest({
      pull: pull(),
      repo,
      dryRun: false,
      ops: new GitHubOps(t.octokit, repo),
      loadConfig: async () => parseConfig(DOCS_CONFIG(), registry),
      buildContext: async () => {
        throw new Error("PR #7 reports 4000 changed files but the API returned 3000");
      },
      log: { info: () => {}, warning: () => {} },
    });
    expect(out.status).toBe("error");
    expect(t.state.reviews).toHaveLength(0);
    expect(lastCheck(t.state)?.conclusion).toBe("failure");
  });

  it("PR already clean: GitHub refuses auto-merge, so it merges pinned to the head SHA", async () => {
    const t = setup({ autoMergeCleanStatus: true });
    await t.go();
    expect(t.state.merged).toBe(true);
  });

  it("logs the decision as one JSON line", async () => {
    const t = setup();
    await t.go();
    const line = t.logs.find((l) => l.startsWith("{"));
    expect(JSON.parse(line ?? "{}")).toMatchObject({ tool: "hall-pass", outcome: "decided", eligible: true, pr: 7 });
  });

  it("approves as merge-bot only once even with an old approval on a previous SHA", async () => {
    const t = setup({ reviews: [{ id: 1, user: { login: BOT }, state: "APPROVED", commit_id: "old", body: "" }] });
    await t.go();
    expect(t.state.reviews.filter((r) => r.commit_id === "head1")).toHaveLength(1);
  });
});
