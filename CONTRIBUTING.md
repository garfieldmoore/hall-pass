# Contributing to hall-pass

hall-pass decides which PRs merge without a human, so changes to it get a human review every time. Classifier code is never auto-merged.

- [Getting started](#getting-started)
- [Repository layout](#repository-layout)
- [Adding a classifier](#adding-a-classifier)
- [Releasing](#releasing)

## Getting started

```bash
npm ci
npm run check   # lint, type check, tests, build
```

- `dist/` is committed. CI fails if `npm run build` changes it, so always commit the rebuilt `dist/`.
- Open a PR against `main`. Every PR needs a human review.

## Repository layout

Tests sit next to the code they test, everywhere:

```
src/
  main.ts, backtest.ts     # entry points (bundled into dist/)
  runner.ts, runner.test.ts
  config.ts, config.test.ts
  context.ts, github.ts, types.ts
  shared.ts                # helpers shared by classifiers, including BEHAVIOURAL_DENY
  classifiers/
    index.ts               # the registry
    <id>/                  # one folder per classifier: index.ts, <id>.test.ts, README.md
  testing/                 # shared test helpers: PR context builders, a fake Octokit, configs
```

`src/testing/` is for tests only. ESLint blocks importing it from non-test code, so it never reaches the bundle. Test files themselves aren't bundled either: esbuild only follows imports from `main.ts` and `backtest.ts`.

## Adding a classifier

Each classifier is a folder under `src/classifiers/`, holding its code, its tests and its docs:

```
src/classifiers/<id>/
  index.ts          # exports a Classifier<Cfg>
  <id>.test.ts      # its tests, next to the code
  README.md         # what it checks, its config, any built-in rules
```

1. Create the folder. `index.ts` exports a `Classifier<Cfg>`, with an `id`, a `kind`, a `description`, a zod `configSchema` and `run(ctx, cfg)`. Classifiers are pure. They do no GitHub writes and keep no state.
2. Import it in `src/classifiers/index.ts` and add it to the array. Nothing else changes: `src/types.ts` is the contract.
3. Write `<id>.test.ts`, including cases that must **not** qualify, or must veto. Build PR contexts with the helpers in `src/testing/`.
4. Write `README.md` using the layout of the existing ones:
   - **Kind** and **Results** on the first line
   - what it checks, and the exact rules it applies
   - a **Config** section with every option, its default, and whether it's required
   - any built-in rules config can't change
   - where its tests are
5. Add a row for it to the [Classifiers](README.md#classifiers) table in the main README, linking to its `README.md`.
6. Ship it, add it to a consumer's config in `shadow` mode, backtest, then switch it to `active`.

For example, a veto classifier `agent-instructions` could fetch each changed `.md` file's content from the API at the head SHA. It would veto files whose YAML frontmatter has `name:` and `description:`, which is how skill files are shaped, or which say things like "You are…" or "When the user asks…". That covers behavioural markdown kept outside the usual paths. It would need its own read of file contents, which is fine because it reads through the API and doesn't check the code out.

## Releasing

Merge to `main`, then push a semver tag:

```bash
git tag v1.2.3 && git push origin v1.2.3
```

`release.yml` verifies the build and checks that the tag is on `main`. It then creates the GitHub release and moves the major tag (`v1`) to that commit.
