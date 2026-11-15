// Contracts between the runner and the classifiers.
// Adding a classifier must never require changing this file.
import type { z } from "zod";

export type Verdict =
  | { result: "eligible"; category: string; evidence: string[] }
  | { result: "abstain"; note?: string }
  | { result: "veto"; reason: string; evidence: string[] }
  | { result: "pass"; note?: string };

export type Mode = "active" | "shadow" | "off";

export interface Classifier<Cfg = unknown> {
  id: string; // kebab-case, matches the config key
  kind: "eligibility" | "veto";
  description: string;
  configSchema: z.ZodType<Cfg>; // validated before run() is called
  run(ctx: PrContext, cfg: Cfg): Promise<Verdict>;
}

export interface PrFile {
  path: string;
  previousPath?: string; // set for renames
  status: "added" | "modified" | "removed" | "renamed" | "copied" | "changed" | "unchanged";
  additions: number;
  deletions: number;
}

export interface PrCommit {
  sha: string;
  authorLogin: string | null; // null when not linked to a GitHub account
  committerLogin: string | null;
  message: string; // full commit message
}

/** A checkout of the PR head. Reserved for later classifiers; v1 never creates one. */
export interface Workspace {
  root: string;
}

export interface PrContext {
  repo: { owner: string; name: string };
  number: number;
  title: string;
  body: string;
  draft: boolean;
  isFork: boolean;
  author: string;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  labels: string[];
  files: PrFile[]; // all pages, not just the first 30
  commits: PrCommit[]; // all pages
  workspace(): Promise<Workspace>; // v1: always throws; reserved for later classifiers
}

export interface ClassifierRun {
  id: string;
  kind: Classifier["kind"];
  mode: Mode;
  verdict: Verdict;
  durationMs: number;
  error?: string;
}

export interface Decision {
  eligible: boolean;
  categories: string[]; // from active eligible verdicts
  vetoes: { id: string; reason: string }[];
  runs: ClassifierRun[]; // every run, shadow included
}
