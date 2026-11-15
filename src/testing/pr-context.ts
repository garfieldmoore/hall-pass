import type { PrContext, PrFile } from "../types.js";

/** A PrContext with sensible defaults; pass only what the test cares about. */
export function prContext(overrides: Partial<PrContext> = {}): PrContext {
  return {
    repo: { owner: "example-org", name: "sandbox" },
    number: 42,
    title: "Update the guide",
    body: "",
    draft: false,
    isFork: false,
    author: "dev",
    headRef: "docs/guide",
    baseRef: "main",
    headSha: "head0000",
    baseSha: "base0000",
    labels: [],
    files: [],
    commits: [{ sha: "head0000", authorLogin: "dev", committerLogin: "dev" }],
    async workspace() {
      throw new Error("no workspace in tests");
    },
    ...overrides,
  };
}

export const modified = (path: string): PrFile => ({ path, status: "modified", additions: 3, deletions: 1 });
export const added = (path: string): PrFile => ({ path, status: "added", additions: 10, deletions: 0 });
export const removed = (path: string): PrFile => ({ path, status: "removed", additions: 0, deletions: 10 });
export const renamed = (from: string, to: string): PrFile => ({
  path: to,
  previousPath: from,
  status: "renamed",
  additions: 0,
  deletions: 0,
});

/** The docs-only category exactly as the example config has it. */
export const docsOnly = {
  categories: {
    "docs-only": {
      allow: ["docs/**", "adr/**", "**/*.md", "**/*.mdx"],
      deny: [".github/**", "**/CLAUDE.md", "**/AGENTS.md", "**/prompts/**", "**/CHANGELOG.md"],
    },
  },
};
