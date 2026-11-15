// Parses the metadata block Dependabot writes into every commit message:
//
//   ---
//   updated-dependencies:
//   - dependency-name: lodash
//     dependency-version: 4.17.21
//     dependency-type: direct:production
//     update-type: version-update:semver-patch
//   ...
import { parse } from "yaml";
import { z } from "zod";

export interface DependabotDependency {
  name: string;
  version?: string;
  type?: string; // e.g. direct:production
  updateType?: string; // e.g. version-update:semver-patch
}

export type MetadataResult = { ok: true; dependencies: DependabotDependency[] } | { ok: false; error: string };

// Unknown keys are allowed: Dependabot adds fields over time.
const entrySchema = z.looseObject({
  "dependency-name": z.string().min(1),
  "dependency-version": z.string().optional(),
  "dependency-type": z.string().optional(),
  "update-type": z.string().optional(),
});

const blockSchema = z.looseObject({ "updated-dependencies": z.array(entrySchema) });

/** Find the YAML between a `---` line followed by `updated-dependencies:`, and the closing `...` line. */
function extractBlock(message: string): string | null {
  const lines = message.split(/\r?\n/);
  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i]?.trim() !== "---" || !/^updated-dependencies:/.test(lines[i + 1] ?? "")) continue;
    const end = lines.findIndex((l, j) => j > i + 1 && l.trim() === "...");
    if (end === -1) return null;
    return lines.slice(i + 1, end).join("\n");
  }
  return null;
}

/** Parse Dependabot's metadata block out of a commit message. Never throws. */
export function parseDependabotMetadata(message: string): MetadataResult {
  try {
    const block = extractBlock(message);
    if (block === null) return { ok: false, error: "no updated-dependencies block" };

    // The failsafe schema keeps every scalar a string, so a version such as
    // 1.10 can't be read as the number 1.1.
    let raw: unknown;
    try {
      raw = parse(block, { schema: "failsafe" });
    } catch (e) {
      return { ok: false, error: `metadata is not valid YAML: ${(e as Error).message.split("\n")[0]}` };
    }

    const parsed = blockSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return { ok: false, error: `metadata is malformed: ${issue ? `${issue.path.join(".")}: ${issue.message}` : "invalid"}` };
    }

    return {
      ok: true,
      dependencies: parsed.data["updated-dependencies"].map((d) => {
        const dep: DependabotDependency = { name: d["dependency-name"] };
        if (d["dependency-version"] !== undefined) dep.version = d["dependency-version"];
        if (d["dependency-type"] !== undefined) dep.type = d["dependency-type"];
        if (d["update-type"] !== undefined) dep.updateType = d["update-type"];
        return dep;
      }),
    };
  } catch (e) {
    return { ok: false, error: `could not read metadata: ${e instanceof Error ? e.message : String(e)}` };
  }
}
