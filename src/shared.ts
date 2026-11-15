// Helpers shared by the runner's GitHub layer and the classifiers.

/** Bots show up as "slug[bot]" in REST and as "slug" in GraphQL. Compare on the slug. */
export function sameActor(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const norm = (s: string) => s.toLowerCase().replace(/\[bot\]$/, "");
  return norm(a) === norm(b);
}

/**
 * Markdown that changes behaviour rather than describing it: agent and
 * assistant instructions, skills, prompts, rule files, and anything under
 * .github/. These read like docs but are executed by a model or by GitHub, so
 * a change to them is a change to the system.
 *
 * Applied to every category on top of the configured deny list, and cannot
 * be turned off from config: a consumer repo's config can only make
 * path-category stricter, never looser. Matched case-insensitively so
 * skill.md, Skills.md and SKILL.md are all caught.
 */
export const BEHAVIOURAL_DENY: readonly string[] = [
  // GitHub workflows, actions, templates, CODEOWNERS, copilot-instructions.md
  ".github/**",
  "**/.github/**",
  // Agent / assistant instruction files, wherever they live
  "**/CLAUDE.md",
  "**/CLAUDE.local.md",
  "**/AGENTS.md",
  "**/AGENT.md",
  "**/GEMINI.md",
  "**/SOUL.md",
  "**/IDENTITY.md",
  "**/MEMORY.md",
  "**/HEARTBEAT.md",
  "**/BOOTSTRAP.md",
  "**/*instructions*.md",
  "**/*instructions*.mdx",
  // Skills
  "**/SKILL.md",
  "**/SKILLS.md",
  "**/skills/**",
  // Prompts
  "**/prompts/**",
  "**/*.prompt.md",
  "**/*.prompt.mdx",
  // Agent definitions and their runtime assets
  "**/agents/**",
  // Tool-specific config directories and rule files
  "**/.claude/**",
  "**/.cursor/**",
  "**/.cursorrules",
  "**/.windsurf/**",
  "**/.windsurfrules",
  "**/.clinerules",
  "**/.clinerules/**",
  "**/.roo/**",
  "**/.kiro/**",
  "**/.continue/**",
  "**/.codex/**",
  "**/.gemini/**",
  "**/.agents/**",
  "**/.openclaw/**",
  "**/.aider*",
];
