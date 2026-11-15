// Backtest CLI: replay the classifiers over a repo's merged PRs and report what
// they would have done. Reads from GitHub only; never writes to it.
//
//   GITHUB_TOKEN=... node dist/backtest.js --repo owner/name --last 300 --config ./hall-pass.yml --out report.json
//   GITHUB_TOKEN=... node dist/backtest.js --repo owner/name --pr 1234 --config ./hall-pass.yml
import { getOctokit } from "@actions/github";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { classifiers } from "./classifiers/index.js";
import { parseConfig } from "./config.js";
import { buildPrContext, listCommits, listFiles, type PullLike } from "./context.js";
import type { Octokit } from "./github.js";
import { aggregate, runClassifiers } from "./runner.js";
import type { Decision, PrCommit, PrFile } from "./types.js";

const USAGE = `Usage: backtest --repo owner/name (--last N | --pr N) --config path [--out report.json] [--csv report.csv] [--cache-dir .backtest-cache] [--no-cache]`;

interface PrResult {
  number: number;
  title: string;
  author: string;
  url: string;
  mergedAt: string | null;
  files: number;
  additions: number;
  deletions: number;
  eligible: boolean;
  categories: string[];
  vetoes: Decision["vetoes"];
  runs: Decision["runs"];
  error?: string;
}

interface Cached {
  pull: PullLike & { html_url: string; merged_at: string | null };
  files: PrFile[];
  commits: PrCommit[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retry on rate limits and transient errors, waiting as long as GitHub asks. */
async function withBackoff<T>(fn: () => Promise<T>, what: string): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const err = e as { status?: number; response?: { headers?: Record<string, string | undefined> } };
      const h = err.response?.headers ?? {};
      const limited = err.status === 429 || (err.status === 403 && (h["x-ratelimit-remaining"] === "0" || h["retry-after"]));
      const transient = err.status !== undefined && err.status >= 500;
      if ((!limited && !transient) || attempt >= 6) throw e;
      let waitMs = 2 ** attempt * 1000;
      if (h["retry-after"]) waitMs = Number(h["retry-after"]) * 1000;
      else if (h["x-ratelimit-reset"]) waitMs = Math.max(1000, Number(h["x-ratelimit-reset"]) * 1000 - Date.now() + 1000);
      waitMs = Math.min(waitMs, 15 * 60 * 1000);
      process.stderr.write(`  ${what}: ${limited ? "rate limited" : `HTTP ${err.status}`}, waiting ${Math.ceil(waitMs / 1000)}s…\n`);
      await sleep(waitMs);
    }
  }
}

class Cache {
  constructor(
    private readonly dir: string | null,
    private readonly repo: string,
  ) {}
  private path(key: string) {
    return join(this.dir ?? "", this.repo.replace("/", "__"), `${key}.json`);
  }
  async get<T>(key: string): Promise<T | null> {
    if (!this.dir) return null;
    try {
      return JSON.parse(await readFile(this.path(key), "utf8")) as T;
    } catch {
      return null;
    }
  }
  async set(key: string, value: unknown) {
    if (!this.dir) return;
    await mkdir(join(this.dir, this.repo.replace("/", "__")), { recursive: true });
    await writeFile(this.path(key), JSON.stringify(value));
  }
}

/** The last `n` merged PRs into the default branch, most recently merged first. */
async function recentMergedNumbers(octokit: Octokit, owner: string, repo: string, n: number): Promise<number[]> {
  const { data: r } = await withBackoff(() => octokit.rest.repos.get({ owner, repo }), "repo");
  const found: { number: number; mergedAt: string }[] = [];
  // The list API can't sort by merge time; walk closed PRs by last update and
  // keep the merged ones. A PR updated after it merged can appear a little early.
  const pages = octokit.paginate.iterator(octokit.rest.pulls.list, {
    owner,
    repo,
    state: "closed",
    base: r.default_branch,
    sort: "updated",
    direction: "desc",
    per_page: 100,
  });
  for await (const page of pages) {
    for (const p of page.data) if (p.merged_at) found.push({ number: p.number, mergedAt: p.merged_at });
    if (found.length >= n) break;
  }
  return found
    .sort((a, b) => b.mergedAt.localeCompare(a.mergedAt))
    .slice(0, n)
    .map((p) => p.number);
}

async function loadPr(octokit: Octokit, cache: Cache, owner: string, repo: string, number: number): Promise<Cached> {
  const hit = await cache.get<Cached>(`pr-${number}`);
  // Merged PRs don't change, so a cache hit is good forever. Open PRs are
  // refetched, and so are entries written before commits carried messages.
  const complete = hit?.commits.every((c) => typeof c.message === "string") ?? false;
  if (hit && hit.pull.merged_at && complete) return hit;
  const { data: pull } = await withBackoff(() => octokit.rest.pulls.get({ owner, repo, pull_number: number }), `#${number}`);
  const [files, commits] = await Promise.all([
    withBackoff(() => listFiles(octokit, owner, repo, number), `#${number} files`),
    withBackoff(() => listCommits(octokit, owner, repo, number), `#${number} commits`),
  ]);
  const entry: Cached = { pull: pull as Cached["pull"], files, commits };
  await cache.set(`pr-${number}`, entry);
  return entry;
}

function csvCell(v: unknown): string {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows: PrResult[]): string {
  const head = ["number", "title", "author", "eligible", "categories", "vetoes", "files", "additions", "deletions", "url", "error"];
  const lines = rows.map((r) =>
    [r.number, r.title, r.author, r.eligible, r.categories.join(" "), r.vetoes.map((v) => v.id).join(" "), r.files, r.additions, r.deletions, r.url, r.error ?? ""]
      .map(csvCell)
      .join(","),
  );
  return [head.join(","), ...lines].join("\n") + "\n";
}

function printSummary(rows: PrResult[]) {
  const ok = rows.filter((r) => !r.error);
  const qualifying = ok.filter((r) => r.eligible);
  const byCategory = new Map<string, number>();
  for (const r of qualifying) for (const c of r.categories) byCategory.set(c, (byCategory.get(c) ?? 0) + 1);
  const vetoCounts = new Map<string, number>();
  for (const r of ok) for (const v of r.vetoes) vetoCounts.set(v.id, (vetoCounts.get(v.id) ?? 0) + 1);
  const pct = (n: number) => (ok.length ? ` (${((100 * n) / ok.length).toFixed(1)}%)` : "");

  const out: string[] = [];
  out.push("", `PRs analysed: ${rows.length}${rows.length !== ok.length ? ` (${rows.length - ok.length} failed to load)` : ""}`);
  out.push(`Would qualify: ${qualifying.length}${pct(qualifying.length)}`);
  for (const [c, n] of byCategory) out.push(`  ${c}: ${n}`);
  out.push(`Vetoes fired: ${vetoCounts.size ? "" : "none"}`);
  for (const [id, n] of vetoCounts) out.push(`  ${id}: ${n}`);
  if (qualifying.length) {
    out.push("", "Qualifying PRs — review these by eye:", "");
    out.push(["#", "category", "files", "+/-", "author", "title"].join("\t"));
    for (const r of qualifying) {
      out.push([`#${r.number}`, r.categories.join(","), r.files, `+${r.additions}/-${r.deletions}`, r.author, r.title].join("\t"));
    }
  }
  const failed = rows.filter((r) => r.error);
  if (failed.length) {
    out.push("", "Failed to load:");
    for (const r of failed) out.push(`  #${r.number}: ${r.error}`);
  }
  console.log(out.join("\n"));
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      repo: { type: "string" },
      last: { type: "string" },
      pr: { type: "string" },
      config: { type: "string" },
      out: { type: "string" },
      csv: { type: "string" },
      "cache-dir": { type: "string", default: ".backtest-cache" },
      "no-cache": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const [owner, repo] = (values.repo ?? "").split("/");
  if (!owner || !repo || !values.config || (!values.last && !values.pr) || (values.last && values.pr)) {
    console.error(USAGE);
    return 2;
  }
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) {
    console.error("Set GITHUB_TOKEN (read access to the repo is enough), e.g. GITHUB_TOKEN=$(gh auth token)");
    return 2;
  }

  const parsed = parseConfig(await readFile(values.config, "utf8"), classifiers);
  if (parsed.kind !== "ok") {
    console.error(parsed.kind === "error" ? parsed.message : "config missing");
    return 2;
  }
  // Backtest judges shadow classifiers as if they were active, so they can be evaluated.
  const configured = parsed.config.classifiers
    .filter((c) => c.mode !== "off")
    .map((c) => ({ ...c, mode: "active" as const }));

  const octokit = getOctokit(token);
  const cache = new Cache(values["no-cache"] ? null : values["cache-dir"], `${owner}/${repo}`);
  const numbers = values.pr ? [Number(values.pr)] : await recentMergedNumbers(octokit, owner, repo, Number(values.last));
  console.error(`Backtesting ${numbers.length} PR(s) in ${owner}/${repo} with ${configured.map((c) => c.classifier.id).join(", ") || "no classifiers"}…`);

  const rows: PrResult[] = [];
  for (const [i, number] of numbers.entries()) {
    if (numbers.length > 1 && i % 25 === 0) console.error(`  ${i}/${numbers.length}`);
    try {
      const { pull, files, commits } = await loadPr(octokit, cache, owner, repo, number);
      const ctx = await buildPrContext(octokit, { owner, name: repo }, pull, {
        fetchFiles: async () => files,
        fetchCommits: async () => commits,
      });
      const d = aggregate(await runClassifiers(configured, ctx));
      rows.push({
        number,
        title: pull.title,
        author: pull.user?.login ?? "",
        url: pull.html_url,
        mergedAt: pull.merged_at,
        files: files.length,
        additions: files.reduce((n, f) => n + f.additions, 0),
        deletions: files.reduce((n, f) => n + f.deletions, 0),
        eligible: d.eligible,
        categories: d.categories,
        vetoes: d.vetoes,
        runs: d.runs,
      });
    } catch (e) {
      rows.push({
        number,
        title: "",
        author: "",
        url: `https://github.com/${owner}/${repo}/pull/${number}`,
        mergedAt: null,
        files: 0,
        additions: 0,
        deletions: 0,
        eligible: false,
        categories: [],
        vetoes: [],
        runs: [],
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  printSummary(rows);
  if (values.out) await writeFile(values.out, JSON.stringify({ repo: `${owner}/${repo}`, generatedAt: new Date().toISOString(), results: rows }, null, 2));
  if (values.csv) await writeFile(values.csv, toCsv(rows));
  return 0;
}

// Run when executed directly (bundled as dist/backtest.js), not when imported by tests.
const entry = process.argv[1] ?? "";
if (entry.endsWith("backtest.js") || entry.endsWith("backtest.ts")) {
  main().then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    },
  );
}
