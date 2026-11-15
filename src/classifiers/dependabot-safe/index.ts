import picomatch from "picomatch";
import { z } from "zod";
import { BEHAVIOURAL_DENY, sameActor } from "../../shared.js";
import type { Classifier, PrFile, Verdict } from "../../types.js";
import { parseDependabotMetadata, type DependabotDependency } from "./metadata.js";

export { parseDependabotMetadata } from "./metadata.js";

export const UPDATE_TYPES = [
  "version-update:semver-patch",
  "version-update:semver-minor",
  "version-update:semver-major",
] as const;

export const dependabotSafeConfigSchema = z.strictObject({
  botLogins: z.array(z.string().min(1)).min(1),
  allowedCommitters: z.array(z.string().min(1)).default([]),
  branchPrefix: z.string().min(1),
  allowedUpdateTypes: z.array(z.enum(UPDATE_TYPES)).min(1),
  allowPreOneZero: z.boolean().default(false),
  denyPackages: z.array(z.string().min(1)).default([]),
  allowedFiles: z.array(z.string().min(1)).min(1),
});

export type DependabotSafeConfig = z.infer<typeof dependabotSafeConfigSchema>;

export const CATEGORY = "dependabot-safe";
const MAX_LISTED = 10;

const short = (sha: string) => sha.slice(0, 7);
const inList = (login: string | null, list: string[]) => login !== null && list.some((l) => sameActor(login, l));

/** Every path a file change touches. Renames are judged on both ends. */
function pathsOf(f: PrFile): string[] {
  return f.previousPath && f.previousPath !== f.path ? [f.previousPath, f.path] : [f.path];
}

function describe(d: DependabotDependency): string {
  const kind = [d.updateType?.replace(/^version-update:/, ""), d.type].filter(Boolean).join(", ");
  return `${d.name} → ${d.version ?? "?"}${kind ? ` (${kind})` : ""}`;
}

export const dependabotSafe: Classifier<DependabotSafeConfig> = {
  id: "dependabot-safe",
  kind: "eligibility",
  description:
    "Eligible when the PR is entirely Dependabot's work, every updated dependency passes the configured rules, and only manifests and lockfiles change.",
  configSchema: dependabotSafeConfigSchema as z.ZodType<DependabotSafeConfig>,

  async run(ctx, cfg): Promise<Verdict> {
    const reasons: string[] = [];
    const bots = cfg.botLogins;
    const committers = [...cfg.botLogins, ...cfg.allowedCommitters];

    // 1–2. Who opened it, and from where.
    if (!inList(ctx.author, bots)) reasons.push(`PR author ${ctx.author || "(unknown)"} is not a Dependabot login`);
    if (!ctx.headRef.startsWith(cfg.branchPrefix)) reasons.push(`branch ${ctx.headRef} does not start with ${cfg.branchPrefix}`);

    // 3–5. Every commit is Dependabot's, and carries its metadata.
    const deps: DependabotDependency[] = [];
    if (ctx.commits.length === 0) reasons.push("no commits");
    for (const c of ctx.commits) {
      if (c.authorLogin === null) reasons.push(`commit ${short(c.sha)}: author has no GitHub login`);
      else if (!inList(c.authorLogin, bots)) reasons.push(`commit ${short(c.sha)}: authored by ${c.authorLogin}`);
      if (c.committerLogin === null) reasons.push(`commit ${short(c.sha)}: committer has no GitHub login`);
      else if (!inList(c.committerLogin, committers)) reasons.push(`commit ${short(c.sha)}: committed by ${c.committerLogin}`);

      const meta = parseDependabotMetadata(c.message);
      if (!meta.ok) reasons.push(`commit ${short(c.sha)}: ${meta.error}`);
      else deps.push(...meta.dependencies);
    }
    if (ctx.commits.length > 0 && deps.length === 0 && !reasons.some((r) => r.includes("updated-dependencies") || r.includes("metadata"))) {
      reasons.push("metadata lists no dependencies");
    }

    // 6. Every dependency passes the rules.
    const denied = cfg.denyPackages.length ? picomatch(cfg.denyPackages, { dot: true }) : () => false;
    const allowedTypes = new Set<string>(cfg.allowedUpdateTypes);
    for (const d of deps) {
      if (d.updateType === undefined) reasons.push(`${d.name}: no update-type`);
      else if (!allowedTypes.has(d.updateType)) reasons.push(`${d.name}: ${d.updateType} is not allowed`);
      if (denied(d.name)) reasons.push(`${d.name}: package is denied`);
      if (!cfg.allowPreOneZero) {
        if (d.version === undefined) reasons.push(`${d.name}: no dependency-version`);
        else if (d.version.startsWith("0.")) reasons.push(`${d.name}: ${d.version} is pre-1.0`);
      }
    }

    // 7–9. Only manifests and lockfiles; nothing behavioural.
    if (ctx.files.length === 0) reasons.push("no changed files");
    const allowed = picomatch(cfg.allowedFiles, { dot: true }); // case-sensitive
    const behavioural = picomatch([...BEHAVIOURAL_DENY], { dot: true, nocase: true });
    for (const p of ctx.files.flatMap(pathsOf)) {
      if (behavioural(p)) reasons.push(`${p}: behavioural file (built-in deny)`);
      else if (!allowed(p)) reasons.push(`${p}: not in allowedFiles`);
    }

    if (reasons.length) {
      const shown = reasons.slice(0, MAX_LISTED);
      const more = reasons.length - shown.length;
      return { result: "abstain", note: `${shown.join("; ")}${more > 0 ? `; …and ${more} more` : ""}` };
    }
    // Grouped monorepo updates repeat the same entry once per manifest; list each once.
    return { result: "eligible", category: CATEGORY, evidence: [...new Set(deps.map(describe))] };
  },
};
