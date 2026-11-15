import type { ConfiguredClassifier, ConfigResult } from "./config.js";
import type { GitHubOps } from "./github.js";
import type { PullLike } from "./context.js";
import { isFork } from "./context.js";
import type { Classifier, ClassifierRun, Decision, PrContext, Verdict } from "./types.js";

export const CLASSIFIER_TIMEOUT_MS = 30_000;

const ALLOWED: Record<Classifier["kind"], Verdict["result"][]> = {
  eligibility: ["eligible", "abstain"],
  veto: ["veto", "pass"],
};

// ---------------------------------------------------------------------------
// Running and aggregating classifiers. Pure apart from the classifiers.
// ---------------------------------------------------------------------------

function withTimeout<T>(p: Promise<T>, ms: number, id: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${id} timed out after ${ms / 1000}s`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

function isVerdict(v: unknown): v is Verdict {
  return typeof v === "object" && v !== null && typeof (v as { result?: unknown }).result === "string";
}

async function runOne(
  { classifier, mode, cfg }: ConfiguredClassifier,
  ctx: PrContext,
  timeoutMs: number,
): Promise<ClassifierRun> {
  const started = performance.now();
  const base = { id: classifier.id, kind: classifier.kind, mode };
  const failed = (error: string): ClassifierRun => ({
    ...base,
    // Fail closed: an error is a veto. In shadow mode the runner ignores it anyway.
    verdict: { result: "veto", reason: error, evidence: [] },
    durationMs: Math.round(performance.now() - started),
    error,
  });

  let verdict: unknown;
  try {
    // Promise.resolve().then() also turns a synchronous throw into a rejection.
    verdict = await withTimeout(
      Promise.resolve().then(() => classifier.run(ctx, cfg)),
      timeoutMs,
      classifier.id,
    );
  } catch (e) {
    return failed(e instanceof Error ? e.message : String(e));
  }

  if (!isVerdict(verdict)) return failed(`${classifier.id} returned a malformed verdict`);
  if (!ALLOWED[classifier.kind].includes(verdict.result)) {
    return failed(`${classifier.id} is a ${classifier.kind} classifier but returned "${verdict.result}"`);
  }
  return { ...base, verdict, durationMs: Math.round(performance.now() - started) };
}

export async function runClassifiers(
  configured: ConfiguredClassifier[],
  ctx: PrContext,
  timeoutMs = CLASSIFIER_TIMEOUT_MS,
): Promise<ClassifierRun[]> {
  return Promise.all(configured.filter((c) => c.mode !== "off").map((c) => runOne(c, ctx, timeoutMs)));
}

/**
 * A PR qualifies when at least one active eligibility classifier says eligible
 * and no active classifier vetoes. Errors and wrong-kind results have already
 * been turned into vetoes by runOne, whichever kind the classifier is.
 */
export function aggregate(runs: ClassifierRun[]): Decision {
  const active = runs.filter((r) => r.mode === "active");
  const vetoes = active.flatMap((r) => (r.verdict.result === "veto" ? [{ id: r.id, reason: r.verdict.reason }] : []));
  const categories = [
    ...new Set(
      active.flatMap((r) => (r.kind === "eligibility" && r.verdict.result === "eligible" ? [r.verdict.category] : [])),
    ),
  ];
  const eligible = categories.length > 0 && vetoes.length === 0;
  return { eligible, categories: eligible ? categories : [], vetoes, runs };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function verdictText(v: Verdict): { verdict: string; detail: string } {
  switch (v.result) {
    case "eligible":
      return { verdict: `eligible (${v.category})`, detail: v.evidence.join("; ") };
    case "veto":
      return { verdict: "veto", detail: [v.reason, ...v.evidence].join("; ") };
    case "abstain":
    case "pass":
      return { verdict: v.result, detail: v.note ?? "" };
  }
}

/** One plain-text line: "Hall pass issued: docs-only" or "No hall pass: touches api-contract". */
export function decisionText(d: Decision): string {
  if (d.eligible) return `Hall pass issued: ${d.categories.join(", ")}`;
  if (d.vetoes.length) {
    const errored = new Set(d.runs.filter((r) => r.error).map((r) => r.id));
    const touches = d.vetoes.filter((v) => !errored.has(v.id)).map((v) => v.id);
    const failed = d.vetoes.filter((v) => errored.has(v.id)).map((v) => v.id);
    const parts = [];
    if (touches.length) parts.push(`touches ${touches.join(", ")}`);
    if (failed.length) parts.push(`${failed.join(", ")} failed`);
    return `No hall pass: ${parts.join("; ")}`;
  }
  if (!d.runs.some((r) => r.mode === "active" && r.kind === "eligibility")) {
    return "No hall pass: no active eligibility classifier";
  }
  return "No hall pass: not in an eligible category";
}

export function decisionLine(d: Decision, dryRun: boolean): string {
  const suffix = dryRun ? " _(dry run: no labels, approval or auto-merge)_" : "";
  const [head, ...rest] = decisionText(d).split(": ");
  return `**${head}:** ${rest.join(": ")}${suffix}`;
}

export function runsTable(runs: ClassifierRun[]): string {
  if (runs.length === 0) return "_No classifiers ran._";
  const rows = runs.map((r) => {
    const { verdict, detail } = verdictText(r.verdict);
    const shownVerdict = r.error ? `error → ${r.mode === "active" ? "veto" : "ignored"}` : verdict;
    return `| \`${r.id}\` | ${r.kind} | ${r.mode} | ${cell(shownVerdict)} | ${cell(r.error ?? detail)} | ${r.durationMs} ms |`;
  });
  return ["| Classifier | Kind | Mode | Verdict | Evidence | Time |", "|---|---|---|---|---|---|", ...rows].join("\n");
}

export function report(d: Decision, dryRun: boolean): string {
  const shadowNote = d.runs.some((r) => r.mode === "shadow")
    ? "\n\n_Shadow classifiers are reported but do not affect the decision._"
    : "";
  return `${decisionLine(d, dryRun)}\n\n${runsTable(d.runs)}${shadowNote}`;
}

// ---------------------------------------------------------------------------
// The whole run for one pull request event
// ---------------------------------------------------------------------------

export interface Logger {
  info(msg: string): void;
  warning(msg: string): void;
}

export interface RunInput {
  pull: PullLike;
  repo: { owner: string; name: string };
  dryRun: boolean;
  ops: GitHubOps;
  loadConfig(baseSha: string): Promise<ConfigResult>;
  buildContext(): Promise<PrContext>;
  log: Logger;
  timeoutMs?: number;
}

export type RunOutcome =
  | { status: "skipped"; reason: string }
  | { status: "no-config" }
  | { status: "config-error"; message: string }
  | { status: "error"; message: string; decision?: Decision }
  | { status: "decided"; decision: Decision };

function logJson(log: Logger, fields: Record<string, unknown>) {
  log.info(JSON.stringify({ tool: "hall-pass", ts: new Date().toISOString(), ...fields }));
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Re-decide from scratch and make GitHub match. Safe to run any number of
 * times on the same commit.
 */
export async function runPullRequest(input: RunInput): Promise<RunOutcome> {
  const { pull, repo, ops, log, dryRun } = input;
  const headSha = pull.head.sha;
  const where = { repo: `${repo.owner}/${repo.name}`, pr: pull.number, headSha, baseSha: pull.base.sha };

  // 1. Skip drafts, closed PRs and forks.
  const skip = pull.draft ? "draft" : pull.state !== "open" ? "closed" : isFork(pull) ? "fork" : null;
  if (skip) {
    await ops.createCheckRun(headSha, "neutral", `Skipped: ${skip} PR`, `hall-pass does not judge ${skip} PRs.`);
    logJson(log, { ...where, outcome: "skipped", reason: skip });
    return { status: "skipped", reason: skip };
  }

  // 2. Config from the base commit. On error: a failed check run and no other writes.
  const loaded = await input.loadConfig(pull.base.sha);
  if (loaded.kind === "missing") {
    await ops.createCheckRun(headSha, "neutral", "No config", `No \`${loaded.path}\` on the base commit, so nothing ran.`);
    logJson(log, { ...where, outcome: "no-config" });
    return { status: "no-config" };
  }
  if (loaded.kind === "error") {
    await ops.createCheckRun(headSha, "failure", "Config error", `${loaded.message}\n\nNo actions were taken.`);
    logJson(log, { ...where, outcome: "config-error", error: loaded.message });
    return { status: "config-error", message: loaded.message };
  }
  const config = loaded.config;

  // Open the check run first: it marks the run as in progress and tells us
  // merge-bot's identity, which every review and auto-merge write needs.
  const checkId = await ops.startCheckRun(headSha);

  // 3–5. Build the context, run the classifiers, decide.
  let decision: Decision;
  try {
    const ctx = await input.buildContext();
    decision = aggregate(await runClassifiers(config.classifiers, ctx, input.timeoutMs));
  } catch (e) {
    return failRun(input, checkId, `runtime error: ${errorMessage(e)}`, where);
  }

  // 6. Check run. Success means "the run completed", whatever the decision.
  const body = report(decision, dryRun);
  const title = decisionText(decision);

  try {
    await ops.completeCheckRun(checkId, "success", title, body);

    // 7. Sticky comment.
    if (config.actions.comment) await ops.upsertComment(pull.number, body);

    if (!dryRun) {
      // 8. Labels.
      if (config.actions.labels) await ops.syncLabels(pull.number, decision.categories);

      if (decision.eligible) {
        // 9. Approve and turn on auto-merge.
        if (config.actions.approve) {
          await ops.approve(pull.number, headSha, `Hall pass issued: ${decision.categories.join(", ")}`);
        }
        if (config.actions.autoMerge) await ops.enableAutoMerge(pull.number, headSha, config.actions.mergeMethod);
      } else {
        // 10. Take back anything merge-bot gave earlier. Always, regardless of
        // actions.* flags: a flag turned off since must not strand an approval.
        await revoke(ops, pull.number, `Hall pass withdrawn. ${decisionText(decision)}`);
      }
    }
  } catch (e) {
    return failRun(input, checkId, `write failed: ${errorMessage(e)}`, where, decision);
  }

  logJson(log, {
    ...where,
    outcome: "decided",
    dryRun,
    eligible: decision.eligible,
    categories: decision.categories,
    vetoes: decision.vetoes,
    runs: decision.runs.map((r) => ({ id: r.id, mode: r.mode, result: r.verdict.result, error: r.error, ms: r.durationMs })),
  });
  return { status: "decided", decision };
}

async function revoke(ops: GitHubOps, number: number, message: string) {
  await ops.dismissApprovals(number, message);
  await ops.disableOwnAutoMerge(number);
}

/** Don't leave a PR half done: undo merge-bot's approval and auto-merge, then fail the check run. */
async function failRun(
  input: RunInput,
  checkId: number,
  message: string,
  where: Record<string, unknown>,
  decision?: Decision,
): Promise<RunOutcome> {
  const { ops, pull, log, dryRun } = input;
  const rollback: string[] = [];
  if (!dryRun) {
    try {
      await revoke(ops, pull.number, `hall-pass: ${message}`);
      rollback.push("rolled back merge-bot approval and auto-merge");
    } catch (e) {
      rollback.push(`rollback also failed: ${errorMessage(e)}`);
      log.warning(`rollback failed: ${errorMessage(e)}`);
    }
  }
  const summary = [message, ...rollback, decision ? `\n${report(decision, dryRun)}` : ""].filter(Boolean).join("\n\n");
  try {
    await ops.completeCheckRun(checkId, "failure", "Error", summary);
  } catch (e) {
    log.warning(`could not report failure on the check run: ${errorMessage(e)}`);
  }
  logJson(log, { ...where, outcome: "error", error: message, rollback });
  return { status: "error", message, ...(decision ? { decision } : {}) };
}

