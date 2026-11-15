import type { Octokit } from "./github.js";
import type { PrCommit, PrContext, PrFile } from "./types.js";

/** The fields of a pull request object this module reads. REST and webhook payloads both fit. */
export interface PullLike {
  number: number;
  title: string;
  body?: string | null;
  draft?: boolean;
  state: string;
  user: { login: string } | null;
  labels: ({ name?: string } | string)[];
  changed_files?: number;
  head: { ref: string; sha: string; repo: { full_name: string } | null };
  base: { ref: string; sha: string; repo: { full_name: string } };
}

export interface ContextOptions {
  /** Hook for the backtest cache; defaults to fetching straight from the API. */
  fetchFiles?: () => Promise<PrFile[]>;
  fetchCommits?: () => Promise<PrCommit[]>;
}

/** The pull-request files endpoint stops at 3000 files. Past that we can't see the whole PR. */
const FILES_API_LIMIT = 3000;

export function isFork(pull: PullLike): boolean {
  // A deleted head repo also lands here: we can't tell where it came from.
  return pull.head.repo === null || pull.head.repo.full_name !== pull.base.repo.full_name;
}

export async function listFiles(octokit: Octokit, owner: string, repo: string, number: number): Promise<PrFile[]> {
  const raw = await octokit.paginate(octokit.rest.pulls.listFiles, { owner, repo, pull_number: number, per_page: 100 });
  return raw.map((f) => {
    const file: PrFile = {
      path: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
    };
    if (f.previous_filename) file.previousPath = f.previous_filename;
    return file;
  });
}

export async function listCommits(octokit: Octokit, owner: string, repo: string, number: number): Promise<PrCommit[]> {
  const raw = await octokit.paginate(octokit.rest.pulls.listCommits, { owner, repo, pull_number: number, per_page: 100 });
  return raw.map((c) => ({
    sha: c.sha,
    authorLogin: c.author?.login ?? null,
    committerLogin: c.committer?.login ?? null,
    message: c.commit.message,
  }));
}

/** Build a PrContext from a pull request object, paging through all files and commits. */
export async function buildPrContext(
  octokit: Octokit,
  repo: { owner: string; name: string },
  pull: PullLike,
  opts: ContextOptions = {},
): Promise<PrContext> {
  const fetchFiles = opts.fetchFiles ?? (() => listFiles(octokit, repo.owner, repo.name, pull.number));
  const fetchCommits = opts.fetchCommits ?? (() => listCommits(octokit, repo.owner, repo.name, pull.number));
  const [files, commits] = await Promise.all([fetchFiles(), fetchCommits()]);

  // Fail closed if we can't see every file: a classifier must never judge a partial PR.
  if (pull.changed_files !== undefined && files.length < pull.changed_files) {
    throw new Error(
      `PR #${pull.number} reports ${pull.changed_files} changed files but the API returned ${files.length}` +
        (pull.changed_files > FILES_API_LIMIT ? ` (the API stops at ${FILES_API_LIMIT})` : ""),
    );
  }

  return {
    repo,
    number: pull.number,
    title: pull.title,
    body: pull.body ?? "",
    draft: pull.draft ?? false,
    isFork: isFork(pull),
    author: pull.user?.login ?? "",
    headRef: pull.head.ref,
    baseRef: pull.base.ref,
    headSha: pull.head.sha,
    baseSha: pull.base.sha,
    labels: pull.labels.map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter(Boolean),
    files,
    commits,
    async workspace() {
      throw new Error("workspace() is not available in v1: hall-pass never checks out PR code");
    },
  };
}
