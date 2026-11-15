import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { classifiers as registry } from "./classifiers/index.js";
import { loadConfig, parseConfig, type ConfiguredClassifier } from "./config.js";
import type { PullLike } from "./context.js";
import { GitHubOps } from "./github.js";
import { aggregate, decisionText, runClassifiers, runPullRequest } from "./runner.js";
import type { Classifier, PrContext, PrFile, Verdict } from "./types.js";
import { added, modified, prContext } from "./testing/pr-context.js";
import { DOCS_CONFIG } from "./testing/configs.js";
import { BOT, fakeOctokit } from "./testing/fake-octokit.js";

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
    expect(decisionText(await decide())).toBe("No hall pass: no active eligibility classifier");
  });

  it("shadow wording says what it would have done", async () => {
    const apiContract = fixed("api-contract", "veto", { result: "veto", reason: "x", evidence: [] });
    expect(decisionText(await decide(as(eligible, "shadow")))).toBe("Would issue a hall pass (shadow): docs-only");
    expect(decisionText(await decide(as(abstain, "shadow")))).toBe("No hall pass (shadow): not in an eligible category");
    expect(decisionText(await decide(as(eligible, "shadow"), as(apiContract, "shadow")))).toBe(
      "No hall pass (shadow): api-contract would block it",
    );
  });

  it("a malformed verdict counts as a veto", async () => {
    expect((await decide(as(eligible), as(malformed))).eligible).toBe(false);
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
  ctx?: Partial<PrContext>;
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
      buildContext: async () => prContext({ files: sc.files ?? [modified("docs/guide.md")], headSha: p.head.sha, ...sc.ctx }),
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
/** Writes that give the PR something. Withdrawing (dismiss, disable) is always allowed. */
const GRANTING = ["issues.addLabels", "pulls.createReview", "pulls.merge", "graphql.enableAutoMerge", "issues.createComment"];
const CLEAN_MERGE_CONFIG = DOCS_CONFIG().replace("mergeMethod: squash", "mergeMethod: squash\n  mergeWhenClean: true");
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

  it("the comment has no timings (so re-runs don't edit it); the check run does", async () => {
    const t = setup();
    await t.go();
    expect(t.state.comments[0]?.body).not.toMatch(/\d+ ms/);
    expect(t.state.comments[0]?.body).not.toContain("| Time |");
    expect(t.state.checkRuns.at(-1)?.summary).toMatch(/\| \d+ ms \|/);
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

  it("invalid config on the base branch: grants nothing; check run fails naming the problem", async () => {
    const t = setup();
    const out = await t.go({ config: DOCS_CONFIG("active", "  nope:\n    mode: active") });
    expect(out.status).toBe("config-error");
    expect(writes(t.state.calls).filter((c) => GRANTING.includes(c))).toEqual([]);
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

  it("pins auto-merge to the head SHA (expectedHeadOid)", async () => {
    const t = setup();
    await t.go();
    expect(t.state.autoMergeVars).toMatchObject({ head: "head1", mergeMethod: "SQUASH" });
  });

  it("already mergeable, mergeWhenClean off (default): approves but leaves the merge to a person", async () => {
    const t = setup({ mergeStateStatus: "CLEAN" });
    const out = await t.go();
    expect(out.status).toBe("decided");
    expect(t.state.merged).toBe(false);
    expect(t.state.calls).not.toContain("graphql.enableAutoMerge");
    expect(t.state.reviews[0]?.state).toBe("APPROVED");
    expect(t.state.comments[0]?.body).toContain("a person needs to press merge");
    expect(t.logs.some((l) => l.includes("leaving it for a person"))).toBe(true);
  });

  it("already mergeable, mergeWhenClean on: merges directly, pinned to the head SHA, and logs it", async () => {
    const t = setup({ mergeStateStatus: "CLEAN", configText: CLEAN_MERGE_CONFIG });
    await t.go();
    expect(t.state.merged).toBe(true);
    expect(t.state.mergedSha).toBe("head1");
    expect(t.logs.some((l) => l.includes("merged PR #7 directly at head1"))).toBe(true);
  });

  it("race: state looked blocked but GitHub says clean; falls back on the error text", async () => {
    const t = setup({ autoMergeCleanStatus: true, configText: CLEAN_MERGE_CONFIG });
    await t.go();
    expect(t.state.merged).toBe(true);
  });

  it("race with mergeWhenClean off: leaves it for a person, no error", async () => {
    const t = setup({ autoMergeCleanStatus: true });
    const out = await t.go();
    expect(out.status).toBe("decided");
    expect(t.state.merged).toBe(false);
    expect(t.state.reviews[0]?.state).toBe("APPROVED");
  });

  it("UNSTABLE (a non-required check failing): never merges directly, even with mergeWhenClean", async () => {
    const t = setup({ mergeStateStatus: "UNSTABLE", configText: CLEAN_MERGE_CONFIG });
    await t.go();
    expect(t.state.merged).toBe(false);
    expect(t.state.comments[0]?.body).toContain("a person needs to press merge");
  });

  it("an unrecognised auto-merge error still rolls back and fails", async () => {
    const t = setup({ fail: { "graphql.enableAutoMerge": new Error("Pull request is in dirty status") } });
    const out = await t.go();
    expect(out.status).toBe("error");
    expect(t.state.reviews[0]?.state).toBe("DISMISSED");
  });

  describe("withdrawing earlier grants on paths that grant nothing", () => {
    const granted = () => ({
      reviews: [{ id: 1, user: { login: BOT }, state: "APPROVED" as const, commit_id: "head1", body: "" }],
      autoMergeBy: "merge-bot",
    });

    it("config broken on the base branch: withdraws approval and auto-merge", async () => {
      const t = setup(granted());
      const out = await t.go({ config: DOCS_CONFIG("sometimes") });
      expect(out.status).toBe("config-error");
      expect(t.state.reviews[0]?.state).toBe("DISMISSED");
      expect(t.state.autoMergeBy).toBeNull();
      expect(writes(t.state.calls).filter((c) => GRANTING.includes(c))).toEqual([]);
    });

    it("config removed from the base branch: withdraws", async () => {
      const t = setup({ ...granted(), configText: null });
      expect((await t.go({ config: null })).status).toBe("no-config");
      expect(t.state.reviews[0]?.state).toBe("DISMISSED");
      expect(t.state.autoMergeBy).toBeNull();
    });

    it("PR turned back into a draft: withdraws", async () => {
      const t = setup(granted());
      await t.go({ pull: { draft: true } });
      expect(t.state.reviews[0]?.state).toBe("DISMISSED");
      expect(t.state.autoMergeBy).toBeNull();
    });

    it("closed PR: leaves everything alone", async () => {
      const t = setup(granted());
      await t.go({ pull: { state: "closed" } });
      expect(t.state.reviews[0]?.state).toBe("APPROVED");
    });

    it("a human's auto-merge is still left alone", async () => {
      const t = setup({ ...granted(), autoMergeBy: "some-human" });
      await t.go({ config: DOCS_CONFIG("sometimes") });
      expect(t.state.autoMergeBy).toBe("some-human");
    });

    it("dry-run: withdraws nothing", async () => {
      const t = setup(granted());
      await t.go({ config: DOCS_CONFIG("sometimes"), dryRun: true });
      expect(t.state.reviews[0]?.state).toBe("APPROVED");
    });
  });

  it("a just-created check run that 404s at first is retried, and the run succeeds", async () => {
    vi.useFakeTimers();
    try {
      const t = setup({ checkRunNotYetVisible: 2 });
      const p = t.go();
      await vi.runAllTimersAsync();
      const out = await p;
      expect(out.status).toBe("decided");
      expect(lastCheck(t.state)?.conclusion).toBe("success");
      expect(t.state.reviews[0]?.state).toBe("APPROVED");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a check run that stays 404 still fails closed", async () => {
    vi.useFakeTimers();
    try {
      const t = setup({ checkRunNotYetVisible: 99 });
      const p = t.go();
      await vi.runAllTimersAsync();
      const out = await p;
      expect(out.status).toBe("error");
      expect(t.state.reviews).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
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

// ---------------------------------------------------------------------------
// dependabot-safe alongside path-category, through the real registry
// ---------------------------------------------------------------------------

describe("dependabot-safe in the runner", () => {
  const BOTH = (mode: string) => DOCS_CONFIG("active", `  dependabot-safe:
    mode: ${mode}
    botLogins: ["dependabot[bot]"]
    allowedCommitters: ["web-flow"]
    branchPrefix: "dependabot/"
    allowedUpdateTypes: ["version-update:semver-patch"]
    denyPackages: ["@apollo/*", "graphql"]
    allowedFiles: ["**/package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"]
`);
  const dependabotCtx: Partial<PrContext> = {
    author: "dependabot[bot]",
    headRef: "dependabot/npm_and_yarn/lodash-4.17.21",
    files: [modified("package.json"), modified("pnpm-lock.yaml")],
    commits: [
      {
        sha: "abc1234",
        authorLogin: "dependabot[bot]",
        committerLogin: "web-flow",
        message:
          "Bump lodash\n\n---\nupdated-dependencies:\n- dependency-name: lodash\n  dependency-version: 4.17.21\n  dependency-type: direct:production\n  update-type: version-update:semver-patch\n...\n",
      },
    ],
  };

  it("active and eligible while path-category abstains: qualifies as dependabot-safe", async () => {
    const t = setup();
    const out = await t.go({ config: BOTH("active"), ctx: dependabotCtx });
    expect(out.status === "decided" && out.decision).toMatchObject({ eligible: true, categories: ["dependabot-safe"] });
    expect(t.state.labels).toEqual(["hall-pass:dependabot-safe"]);
    expect(t.state.reviews[0]).toMatchObject({ state: "APPROVED", body: "Hall pass issued: dependabot-safe" });
    expect(t.state.comments[0]?.body).toContain("| `path-category` | eligibility | active | abstain |");
    expect(t.state.comments[0]?.body).toContain("lodash → 4.17.21 (semver-patch, direct:production)");
  });

  it("in shadow and eligible: doesn't qualify; the comment shows the shadow result", async () => {
    const t = setup();
    const out = await t.go({ config: BOTH("shadow"), ctx: dependabotCtx });
    expect(out.status === "decided" && out.decision.eligible).toBe(false);
    expect(t.state.reviews).toHaveLength(0);
    expect(t.state.labels).toEqual([]);
    expect(t.state.comments[0]?.body).toContain("| `dependabot-safe` | eligibility | shadow | eligible (dependabot-safe) |");
  });

  it("a docs PR still qualifies as docs-only with both configured", async () => {
    const t = setup();
    const out = await t.go({ config: BOTH("active") });
    expect(out.status === "decided" && out.decision.categories).toEqual(["docs-only"]);
  });
});
