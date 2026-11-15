# hall-pass

A GitHub Action that classifies pull requests and gives the low-risk ones a hall pass: merge-bot approves them and turns on auto-merge. Every other PR goes to human review, the same as now.

v1 has one classifier, `path-category`, configured with one category, `docs-only`.

- [How it decides](#how-it-decides)
- [Markdown that is behaviour, not docs](#markdown-that-is-behaviour-not-docs)
- [Consumer setup](#consumer-setup) (six steps)
- [Config reference](#config-reference)
- [Backtest](#backtest)
- [Adding a classifier](#adding-a-classifier)
- [Developing and releasing](#developing-and-releasing)
- [Design decisions](#design-decisions)
- [Accepted risks](#accepted-risks)

## How it decides

There are two kinds of classifier:

| Kind | Results | Purpose |
|---|---|---|
| Eligibility | `eligible`, `abstain` | Puts the PR in a safe category |
| Veto | `veto`, `pass` | Blocks the PR whatever its category |

A PR **qualifies** when at least one *active* eligibility classifier returns `eligible` and no *active* classifier vetoes it.

Each classifier has a mode:

- `active`: its verdict counts.
- `shadow`: it runs and is reported, but the decision ignores it.
- `off`: it doesn't run.

The runner fails closed. The classifiers don't have to:

- A classifier that throws, or runs for more than 30 s, counts as a veto. In shadow mode the error is only reported.
- A result outside the classifier's kind counts as a veto. So does a malformed result.
- Invalid config, or an unknown classifier id, means no writes at all, and the check run fails with the problem named.
- With no active eligibility classifier, nothing qualifies.
- Config is read from the PR's **base commit** through the API, so a PR can't change the config that judges it.
- The Action never checks out or runs PR code.

On every `pull_request` event (`opened`, `synchronize`, `reopened`, `ready_for_review`), the runner decides from scratch and makes GitHub match the decision:

1. Skips draft, closed and fork PRs, with a neutral check run.
2. Loads the config from the base commit. If there's no config file, it posts a neutral check run. If the config is invalid, it posts a failed check run and makes no writes.
3. Builds the PR context, with every page of files and commits, and runs every classifier that isn't `off`, in parallel.
4. Completes the `hall-pass` check run on the head SHA. The conclusion is `success` whenever the run completed, whether or not the PR qualified. It's `failure` only on a runtime or config error.
5. Creates or updates the sticky comment, found by `<!-- hall-pass -->`. It opens with one line, such as **Hall pass issued:** docs-only or **No hall pass:** touches api-contract, followed by a table of every classifier run. The check run title uses the same line. A vetoing classifier shows as `touches <id>`. One that errored shows as `<id> failed`.
6. Syncs the labels: it adds `hall-pass:<category>` and removes any other `hall-pass:` label.
7. If the PR qualifies, merge-bot approves it (unless it already approved this head SHA) and turns on auto-merge. If it doesn't qualify, merge-bot dismisses its own approvals and turns off auto-merge, but only if merge-bot turned it on. It never touches a human's approval or a human's auto-merge.

`dry-run: true` keeps steps 4 and 5 and skips steps 6 and 7. If a write fails partway, merge-bot dismisses its approval, turns off its auto-merge and fails the check run. Each run logs one JSON line (`{"tool":"hall-pass",...}`) so runs can be searched later.

## Markdown that is behaviour, not docs

Some `.md` files are instructions that a model or GitHub acts on. Changing one changes how the system behaves, even though it looks like prose. Examples:

- `SKILL.md` and anything under `skills/`
- `CLAUDE.md` and `AGENTS.md`
- `.cursor/rules/*.md` and `.claude/commands/*.md`
- `*.prompt.md`
- agent `instructions.md` files
- `.github/copilot-instructions.md` and PR templates

`path-category` has a built-in deny list for these, `BEHAVIOURAL_DENY` in `src/classifiers/path-category.ts`. It applies to **every** category on top of the configured `deny`, it matches **case-insensitively** (so `skill.md`, `Skills.md` and `SKILL.md` all match), and **config can't turn it off**. A consumer's config can only make the classifier stricter. The list also covers `.github/**`, so workflow and template changes always go to a human.

| Covered | Globs |
|---|---|
| GitHub | `.github/**`, `**/.github/**` |
| Instruction files | `**/CLAUDE.md`, `**/CLAUDE.local.md`, `**/AGENTS.md`, `**/AGENT.md`, `**/GEMINI.md`, `**/SOUL.md`, `**/IDENTITY.md`, `**/MEMORY.md`, `**/HEARTBEAT.md`, `**/BOOTSTRAP.md`, `**/*instructions*.md(x)` |
| Skills | `**/SKILL.md`, `**/SKILLS.md`, `**/skills/**` |
| Prompts | `**/prompts/**`, `**/*.prompt.md(x)` |
| Agent definitions and assets | `**/agents/**` |
| Tool config directories | `**/.claude/**`, `**/.cursor/**`, `**/.cursorrules`, `**/.windsurf/**`, `**/.windsurfrules`, `**/.clinerules(/**)`, `**/.roo/**`, `**/.kiro/**`, `**/.continue/**`, `**/.codex/**`, `**/.gemini/**`, `**/.agents/**`, `**/.openclaw/**`, `**/.aider*` |

Renames are judged on both the old and the new path, so moving `.cursor/skills/x/SKILL.md` to `docs/x.md` doesn't qualify.

The list is deliberately broad. For example, `docs/agents/overview.md` is held back because it's under an `agents/` directory. A false "needs review" costs a few minutes. A false "auto-merge" changes how an agent behaves with nobody looking. If a backtest shows the list holding back plain docs in your repo, rename the directory or widen the list in code, through a reviewed PR to this repo.

Backtesting showed why the list is needed. In a real repository, pure-markdown PRs that only added `.agents/skills/*/SKILL.md` files would have been auto-merged under the example deny list alone. The built-in list held them back.

Path matching can't spot a behavioural file kept somewhere ordinary, such as a skill in `docs/foo.md` with skill frontmatter. That needs a content check. See [Adding a classifier](#adding-a-classifier) for a veto classifier that would catch it.

## Consumer setup

A consumer repo needs six things, set up in this order.

### 1. Register the merge-bot GitHub App (once per org)

Go to **Org settings › Developer settings › GitHub Apps › New GitHub App** and fill it in like this:

- **Name:** `merge-bot` (or any name; reviews appear as `<slug>[bot]`)
- **Homepage URL:** anything, for example this repo's URL
- **Webhook:** untick **Active**. The App is only used as an identity.
- **Repository permissions:**
  - Pull requests: **Read and write**
  - Contents: **Read and write**
  - Checks: **Read and write**
  - Issues: **Read and write** (labels and comments on PRs go through the issues API)
  - Metadata: **Read** (set automatically)
- **Where can this GitHub App be installed?** Only on this account

Create the App, then:

These steps assume an organisation. On a personal account, register the App under your own Developer settings and add the variable and secret to each consumer repo instead.

1. Note the **App ID** shown on the App's page. Then go to **Org settings › Secrets and variables › Actions › Variables › New organization variable**. Name it `MERGE_BOT_APP_ID`, give it the App ID as its value, and grant access to the consumer repos.
2. On the App's page, **Generate a private key**. A `.pem` file downloads. Go to **Org settings › Secrets and variables › Actions › Secrets › New organization secret**. Name it `MERGE_BOT_KEY`, paste the whole `.pem` content, and limit **Repository access** to the consumer repos. Then delete the local `.pem`.
3. Go to **Install App › your-org › Only select repositories**, pick the consumer repos only, and confirm.

### 2. Let consumer repos use the Action (private copies only)

Skip this if you use the public `garfieldmoore/hall-pass`. If you run your own private copy, go to its **Settings › Actions › General › Access** and choose **Accessible from repositories in the organization** (or, on a personal account, **owned by the user**).

### 3. Repo settings

In the consumer repo, go to **Settings › General › Pull Requests** and tick **Allow auto-merge**. Keep at least the merge method you configure (squash by default) enabled.

### 4. Ruleset on the default branch

Go to **Settings › Rules › Rulesets › New branch ruleset**:

- **Target:** the default branch
- **Bypass list:** empty (or admins only)
- **Require a pull request before merging:**
  - Required approvals: **1**
  - **Dismiss stale pull request approvals when new commits are pushed:** on
  - **Require review from Code Owners:** **off**. merge-bot can't satisfy it in v1.
- **Require status checks to pass:** add the CI checks. Don't add `hall-pass` itself: its conclusion is `success` whether or not the PR qualifies.
- **Block force pushes:** on
- Merge queue: optional

### 5. Add the workflow

Add this as `.github/workflows/hall-pass.yml`:

```yaml
name: hall-pass
on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
permissions:
  contents: read
concurrency:
  group: hall-pass-${{ github.event.pull_request.number }}
  cancel-in-progress: true
jobs:
  classify:
    if: github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      - uses: actions/create-github-app-token@v3
        id: app
        with:
          app-id: ${{ vars.MERGE_BOT_APP_ID }}
          private-key: ${{ secrets.MERGE_BOT_KEY }}
      - uses: garfieldmoore/hall-pass@v1
        with:
          github-token: ${{ steps.app.outputs.token }}
```

### 6. Add the config, in shadow mode

Copy [`examples/hall-pass.yml`](examples/hall-pass.yml) to `.github/hall-pass.yml` and merge it to the default branch. The Action reads config from the base commit, so it has no effect until it's merged. Start every classifier in `mode: shadow`. [Run a backtest](#backtest), review the list of PRs that would qualify, then switch to `mode: active` in a separate PR.

## Config reference

```yaml
version: 1                 # required, must be 1

actions:                   # each write can be turned off on its own
  approve: true            # default false: merge-bot approves qualifying PRs
  autoMerge: true          # default false: turn on auto-merge for qualifying PRs
  mergeMethod: squash      # squash | merge | rebase (default squash)
  labels: true             # default true: hall-pass:<category> labels
  comment: true            # default true: sticky summary comment

classifiers:
  <classifier-id>:         # must be a registered id
    mode: shadow           # active | shadow | off (default shadow)
    ...                    # the classifier's own settings, checked against its schema
```

Unknown keys at any level are a config error.

### `path-category`

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

## Backtest

The backtest replays the classifiers over a repo's merged PRs without writing anything to GitHub. Classifiers in `shadow` mode are judged as if they were `active`.

```bash
npm ci && npm run build      # or use the committed dist/
GITHUB_TOKEN=$(gh auth token) node dist/backtest.js \
  --repo your-org/your-repo --last 300 --config ./hall-pass.yml --out report.json

# a single PR
GITHUB_TOKEN=$(gh auth token) node dist/backtest.js --repo your-org/your-repo --pr 1234 --config ./hall-pass.yml

# CSV for a spreadsheet
... --csv report.csv
```

It prints how many PRs would qualify, broken down by category, and how often each veto fired. Then it lists the qualifying PRs (number, category, files, `+/-`, author, title) for people to review by eye. The full per-PR results, including each classifier's evidence and notes, go to `--out` as JSON or `--csv` as CSV.

API responses are cached in `.backtest-cache/`. Merged PRs don't change, so reruns after a config change make no PR API calls. Use `--no-cache` to skip the cache. The CLI waits and retries when it's rate-limited.

To see what the built-in list held back:

```bash
jq -r '.results[] | select(.runs[].verdict.note // "" | contains("behavioural")) | "#\(.number) \(.title)"' report.json
```

## Adding a classifier

1. Write `src/classifiers/<id>.ts` exporting a `Classifier<Cfg>`, with an `id`, a `kind`, a `description`, a zod `configSchema` and `run(ctx, cfg)`. Classifiers are pure. They do no GitHub writes and keep no state.
2. Import it in `src/classifiers/index.ts` and add it to the array. Nothing else changes: `src/types.ts` is the contract.
3. Add `test/classifiers/<id>.test.ts`, including cases that must **not** qualify, or must veto.
4. Ship it, add it to a consumer's config in `shadow` mode, backtest, then switch it to `active`.

For example, a veto classifier `agent-instructions` could fetch each changed `.md` file's content from the API at the head SHA. It would veto files whose YAML frontmatter has `name:` and `description:`, which is how skill files are shaped, or which say things like "You are…" or "When the user asks…". That covers behavioural markdown kept outside the usual paths. It would need its own read of file contents, which is fine because it reads through the API and doesn't check the code out.

## Developing and releasing

```bash
npm ci
npm run check   # lint, type check, tests, build
```

- `dist/` is committed. CI fails if `npm run build` changes it, so always commit the rebuilt `dist/`.
- To release, merge to `main`, then push a semver tag:

  ```bash
  git tag v1.2.3 && git push origin v1.2.3
  ```

  `release.yml` verifies the build and checks that the tag is on `main`. It then creates the GitHub release and moves the major tag (`v1`) to that commit.
- This repo needs human review on every PR. Classifier code is never auto-merged.

## Design decisions

- **Built-in behavioural deny list.** It isn't configurable and applies to every `path-category` category. It also meets the rule that docs-only always denies `.github/**`. See [above](#markdown-that-is-behaviour-not-docs).
- **Case.** `allow` is case-sensitive and `deny` is case-insensitive. Either way, a doubtful path doesn't qualify.
- **Names.** The config file is `.github/hall-pass.yml` and the consumer workflow is `.github/workflows/hall-pass.yml`. The approving review's body is `Hall pass issued: <categories>`.
- **Defaults.** `actions.approve` and `actions.autoMerge` default to `false` and `mode` defaults to `shadow`, so a missing key never grants a write.
- **Check run lifecycle.** The run opens as `in_progress` before the classifiers run and completes afterwards. Creating it is also how the Action learns merge-bot's login (`<app-slug>[bot]`), which it needs to find its own reviews and its own auto-merge. Skip, no-config and config-error runs post one completed check run.
- **Runtime errors after a valid config load**, such as an API failure or a PR with more files than the API returns, roll back merge-bot's approval and auto-merge, then fail the check run. Config errors make no writes at all.
- **Revoking ignores `actions.*`.** When a PR doesn't qualify, merge-bot always takes back its own approval and auto-merge, even if `approve` or `autoMerge` has since been turned off. A flag change must never strand an approval.
- **A PR that is already mergeable.** GitHub refuses to turn on auto-merge for a PR that could merge right now ("clean status"). In that case the Action merges directly, pinned to the head SHA it judged. With a required merge queue that direct merge fails, and the run rolls back.
- **Truncated file lists.** The files API stops at 3000 files. If the PR reports more changed files than the API returned, that's a runtime error: no classifier judges part of a PR.
- **Fresh PR data.** The Action re-reads the PR from the API rather than trusting the event payload, which may be stale by the time a queued job starts.
- **"Last N merged" in the backtest.** The list API can't sort by merge time, so the backtest walks closed PRs by last update and keeps merged ones. PRs edited after merging can be slightly out of order.
- **Runtime and bundle.** `node24` is the newest runtime GitHub Actions supports. The bundle is ESM built by esbuild. The workflow uses `actions/create-github-app-token@v3`, the current major.

## Accepted risks

- **The classifier is the only judge.** A wrong classifier merges a PR that nobody reviewed. The controls are shadow mode, backtests, fail-closed handling, reading config from the base commit, and the built-in deny list including `.github/**`. None of them is optional.
- **Workflow edits can use the token.** The workflow runs from the PR branch with `MERGE_BOT_KEY` available, so anyone with write access could edit a workflow in their PR to use the token directly. Denying `.github/**` stops the classifier approving such a PR, but it doesn't stop the edited workflow from running.
- **The App key is powerful.** It can approve and turn on auto-merge in any repo where merge-bot is installed. Keep it an org secret limited to the consumer repos, and install the App only on those repos.
