import picomatch from "picomatch";
import { z } from "zod";
import type { Classifier, PrFile, Verdict } from "../types.js";

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

const glob = z.string().min(1);

const categorySchema = z.strictObject({
  allow: z.array(glob).min(1),
  deny: z.array(glob).default([]),
});

export const pathCategoryConfigSchema = z.strictObject({
  categories: z.record(z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "category names are kebab-case"), categorySchema).refine(
    (c) => Object.keys(c).length > 0,
    "at least one category is required",
  ),
});

export type PathCategoryConfig = z.infer<typeof pathCategoryConfigSchema>;

type Matcher = (path: string) => boolean;

const MAX_LISTED = 10;

interface CompiledCategory {
  name: string;
  allow: Matcher;
  deny: Matcher;
  behavioural: Matcher;
}

function compile(name: string, allow: string[], deny: string[]): CompiledCategory {
  return {
    name,
    // Allow is case-sensitive: an allow glob should never match more than it says.
    allow: picomatch(allow, { dot: true }),
    // Denies are case-insensitive: when in doubt, deny.
    deny: deny.length ? picomatch(deny, { dot: true, nocase: true }) : () => false,
    behavioural: picomatch([...BEHAVIOURAL_DENY], { dot: true, nocase: true }),
  };
}

/** Every path a file change touches. Renames are judged on both ends. */
function pathsOf(f: PrFile): string[] {
  return f.previousPath && f.previousPath !== f.path ? [f.previousPath, f.path] : [f.path];
}

/** Why `path` keeps the PR out of `cat`, or null if it fits. */
function rejection(cat: CompiledCategory, path: string): string | null {
  if (cat.behavioural(path)) return `${path}: behavioural file (built-in deny)`;
  if (cat.deny(path)) return `${path}: denied`;
  if (!cat.allow(path)) return `${path}: not in allow list`;
  return null;
}

export const pathCategory: Classifier<PathCategoryConfig> = {
  id: "path-category",
  kind: "eligibility",
  description:
    "Eligible for a category when every changed path matches one of its allow globs and none of its deny globs or the built-in behavioural deny list.",
  configSchema: pathCategoryConfigSchema as z.ZodType<PathCategoryConfig>,

  async run(ctx, cfg): Promise<Verdict> {
    if (ctx.files.length === 0) return { result: "abstain", note: "no changed files" };

    const paths = ctx.files.flatMap(pathsOf);
    const matched: string[] = [];
    const reasons: string[] = [];

    for (const [name, c] of Object.entries(cfg.categories)) {
      const cat = compile(name, c.allow, c.deny);
      const rejected = paths.map((p) => rejection(cat, p)).filter((r): r is string => r !== null);
      if (rejected.length === 0) {
        matched.push(name);
      } else {
        const shown = rejected.slice(0, MAX_LISTED);
        const more = rejected.length - shown.length;
        reasons.push(`${name}: ${shown.join("; ")}${more > 0 ? `; …and ${more} more` : ""}`);
      }
    }

    const [first, ...rest] = matched;
    if (first === undefined) return { result: "abstain", note: reasons.join(" | ") };

    const evidence = [`all ${ctx.files.length} changed file(s) match ${first}`];
    if (rest.length) evidence.push(`also matches: ${rest.join(", ")}`);
    return { result: "eligible", category: first, evidence };
  },
};
