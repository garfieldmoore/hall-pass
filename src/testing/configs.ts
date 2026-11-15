/** The docs-only config from the brief, active by default; `extra` is appended verbatim. */
export const DOCS_CONFIG = (mode = "active", extra = "") => `
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
