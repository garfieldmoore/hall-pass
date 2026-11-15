import { describe, expect, it } from "vitest";
import { parseDependabotMetadata } from "./metadata.js";

const single = `Bump lodash from 4.17.20 to 4.17.21

Bumps [lodash](https://github.com/lodash/lodash) from 4.17.20 to 4.17.21.
- [Release notes](https://github.com/lodash/lodash/releases)

---
updated-dependencies:
- dependency-name: lodash
  dependency-version: 4.17.21
  dependency-type: direct:production
  update-type: version-update:semver-patch
...

Signed-off-by: dependabot[bot] <support@github.com>`;

describe("parseDependabotMetadata", () => {
  it("a single-dependency block", () => {
    expect(parseDependabotMetadata(single)).toEqual({
      ok: true,
      dependencies: [
        { name: "lodash", version: "4.17.21", type: "direct:production", updateType: "version-update:semver-patch" },
      ],
    });
  });

  it("a grouped block with three dependencies", () => {
    const msg = `Bump the npm group with 3 updates

---
updated-dependencies:
- dependency-name: express
  dependency-version: 4.21.2
  dependency-type: direct:production
  update-type: version-update:semver-patch
  dependency-group: npm
- dependency-name: uuid
  dependency-version: 9.0.1
  dependency-type: direct:production
  update-type: version-update:semver-patch
  dependency-group: npm
- dependency-name: body-parser
  dependency-version: 1.20.3
  dependency-type: direct:production
  update-type: version-update:semver-patch
  dependency-group: npm
...
`;
    const r = parseDependabotMetadata(msg);
    expect(r.ok && r.dependencies.map((d) => d.name)).toEqual(["express", "uuid", "body-parser"]);
  });

  it("no block at all", () => {
    expect(parseDependabotMetadata("fix: a human commit\n\nNo metadata here.")).toEqual({
      ok: false,
      error: "no updated-dependencies block",
    });
  });

  it("a block that is never closed counts as no block", () => {
    expect(parseDependabotMetadata("x\n\n---\nupdated-dependencies:\n- dependency-name: a\n").ok).toBe(false);
  });

  it("malformed YAML inside the block", () => {
    const r = parseDependabotMetadata("x\n\n---\nupdated-dependencies:\n- dependency-name: [unclosed\n  update-type: x\n...\n");
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toMatch(/not valid YAML|malformed/);
  });

  it("an entry without a dependency-name is malformed", () => {
    const r = parseDependabotMetadata("x\n\n---\nupdated-dependencies:\n- update-type: version-update:semver-patch\n...\n");
    expect(r.ok).toBe(false);
  });

  it("an entry missing update-type parses, without updateType", () => {
    const r = parseDependabotMetadata("x\n\n---\nupdated-dependencies:\n- dependency-name: lodash\n  dependency-version: 4.17.21\n...\n");
    expect(r).toEqual({ ok: true, dependencies: [{ name: "lodash", version: "4.17.21" }] });
  });

  it("a scoped package name, quoted as Dependabot writes it", () => {
    const r = parseDependabotMetadata('x\n\n---\nupdated-dependencies:\n- dependency-name: "@apollo/server"\n  dependency-version: 4.11.1\n...\n');
    expect(r.ok && r.dependencies[0]?.name).toBe("@apollo/server");
  });

  it("an unquoted @name is invalid YAML, so it fails closed", () => {
    expect(parseDependabotMetadata("x\n\n---\nupdated-dependencies:\n- dependency-name: @apollo/server\n...\n").ok).toBe(false);
  });

  it("extra unknown keys are accepted", () => {
    const r = parseDependabotMetadata(
      "x\n\n---\nupdated-dependencies:\n- dependency-name: lodash\n  dependency-version: 4.17.21\n  update-type: version-update:semver-patch\n  some-future-field: yes\n...\n",
    );
    expect(r.ok && r.dependencies[0]?.name).toBe("lodash");
  });

  it("a block surrounded by other commit message text", () => {
    const msg = `chore(deps): bump lodash\n\nSome prose.\n---\nnot the block\n\n${single.slice(single.indexOf("---"))}\n\nCo-authored-by: someone`;
    const r = parseDependabotMetadata(msg);
    expect(r.ok && r.dependencies[0]?.version).toBe("4.17.21");
  });

  it("keeps versions as strings: 1.10 stays 1.10, not 1.1", () => {
    const r = parseDependabotMetadata("x\n\n---\nupdated-dependencies:\n- dependency-name: a\n  dependency-version: 1.10\n...\n");
    expect(r.ok && r.dependencies[0]?.version).toBe("1.10");
  });

  it("never throws, whatever the input", () => {
    for (const input of ["", "---", "---\nupdated-dependencies:\n...", "---\nupdated-dependencies: 3\n...", "\u0000\u0001"]) {
      expect(() => parseDependabotMetadata(input)).not.toThrow();
    }
  });
});
