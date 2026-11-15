# path-category

**Kind:** eligibility. **Results:** `eligible` or `abstain`.

Puts a PR in a category when every changed file sits in paths that category allows. v1 uses it for one category, `docs-only`.

## Config

```yaml
path-category:
  mode: shadow
  categories:
    <kebab-case-name>:
      allow: [glob, ...]   # required, at least one
      deny:  [glob, ...]   # optional
```

A category is `eligible` when every changed path matches at least one `allow` glob, no `deny` glob and nothing on the built-in behavioural list. For renames, both the old and the new path are checked. With no changed files, or when no category matches, the result is `abstain`, and the note lists which files kept the PR out of each category. When several categories match, the first in config order is the `category` and the rest are listed in `evidence`.

Globs use [picomatch](https://github.com/micromatch/picomatch) with `dot: true`. `allow` is case-sensitive. `deny` and the built-in list are case-insensitive.

## Built-in behavioural deny list

`BEHAVIOURAL_DENY` in [`index.ts`](index.ts) holds markdown and config that changes how agents or GitHub behave: `SKILL.md`, `CLAUDE.md`, `AGENTS.md`, prompts, agent instructions, tool rule folders and `.github/**`. It applies to every category on top of the configured `deny`, matches case-insensitively, and config can't turn it off. See [Markdown that is behaviour, not docs](../../../README.md#markdown-that-is-behaviour-not-docs) for the full list and the reasoning.

## Tests

[`path-category.test.ts`](path-category.test.ts) covers the brief's cases, every behavioural file pattern, renames, case handling and the config schema.
