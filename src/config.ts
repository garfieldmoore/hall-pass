import { parse } from "yaml";
import { z } from "zod";
import type { Classifier, Mode } from "./types.js";
import type { Octokit } from "./github.js";

const modeSchema = z.enum(["active", "shadow", "off"]);

const actionsSchema = z.strictObject({
  // Approval and auto-merge default to off: a missing key never grants a write.
  approve: z.boolean().default(false),
  autoMerge: z.boolean().default(false),
  mergeMethod: z.enum(["squash", "merge", "rebase"]).default("squash"),
  // When a qualifying PR can already merge (nothing left to wait for), GitHub
  // refuses auto-merge. Off: leave it approved for a person. On: hall-pass
  // merges it itself. Only turn on once the ruleset requires your CI checks.
  mergeWhenClean: z.boolean().default(false),
  labels: z.boolean().default(true),
  comment: z.boolean().default(true),
});

const topLevelSchema = z.strictObject({
  version: z.literal(1),
  actions: actionsSchema.default({
    approve: false,
    autoMerge: false,
    mergeMethod: "squash",
    mergeWhenClean: false,
    labels: true,
    comment: true,
  }),
  classifiers: z.record(
    z.string(),
    // Each block carries its mode plus the classifier's own settings, which
    // are validated against that classifier's configSchema below.
    z.looseObject({ mode: modeSchema.default("shadow") }),
  ),
});

export type ActionsConfig = z.infer<typeof actionsSchema>;
export type MergeMethod = ActionsConfig["mergeMethod"];

export interface ConfiguredClassifier {
  classifier: Classifier<unknown>;
  mode: Mode;
  cfg: unknown;
}

export interface ResolvedConfig {
  actions: ActionsConfig;
  classifiers: ConfiguredClassifier[];
}

export type ConfigResult =
  | { kind: "ok"; config: ResolvedConfig }
  | { kind: "missing"; path: string }
  | { kind: "error"; message: string };

function formatZod(prefix: string, err: z.ZodError): string {
  return err.issues
    .map((i) => `${prefix}${i.path.length ? i.path.join(".") : "(root)"}: ${i.message}`)
    .join("; ");
}

/** Parse and validate config text. Pure: no I/O, so it is easy to test. */
export function parseConfig(text: string, registry: readonly Classifier<unknown>[]): ConfigResult {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (e) {
    return { kind: "error", message: `config is not valid YAML: ${(e as Error).message}` };
  }

  const top = topLevelSchema.safeParse(raw);
  if (!top.success) return { kind: "error", message: `invalid config: ${formatZod("", top.error)}` };

  const byId = new Map(registry.map((c) => [c.id, c]));
  const errors: string[] = [];
  const configured: ConfiguredClassifier[] = [];

  for (const [id, block] of Object.entries(top.data.classifiers)) {
    const classifier = byId.get(id);
    if (!classifier) {
      errors.push(`unknown classifier "${id}" (known: ${[...byId.keys()].join(", ") || "none"})`);
      continue;
    }
    const { mode, ...rest } = block;
    const parsed = classifier.configSchema.safeParse(rest);
    if (!parsed.success) {
      errors.push(formatZod(`classifiers.${id}.`, parsed.error));
      continue;
    }
    configured.push({ classifier, mode, cfg: parsed.data });
  }

  if (errors.length) return { kind: "error", message: `invalid config: ${errors.join("; ")}` };
  return { kind: "ok", config: { actions: top.data.actions, classifiers: configured } };
}

/**
 * Load the config from the PR's base commit through the API. Never from the
 * PR branch: a PR must not be able to change the config that judges it.
 */
export async function loadConfig(
  octokit: Octokit,
  repo: { owner: string; name: string },
  baseSha: string,
  path: string,
  registry: readonly Classifier<unknown>[],
): Promise<ConfigResult> {
  let text: string;
  try {
    const res = await octokit.rest.repos.getContent({
      owner: repo.owner,
      repo: repo.name,
      path,
      ref: baseSha,
    });
    const data = res.data;
    if (Array.isArray(data) || data.type !== "file" || !("content" in data)) {
      return { kind: "error", message: `${path} on the base commit is not a file` };
    }
    text = Buffer.from(data.content, "base64").toString("utf8");
  } catch (e) {
    if ((e as { status?: number }).status === 404) return { kind: "missing", path };
    throw e;
  }
  return parseConfig(text, registry);
}
