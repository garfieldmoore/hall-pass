// Every GitHub write hall-pass makes lives here. Classifiers never write.
import type { getOctokit } from "@actions/github";
import type { MergeMethod } from "./config.js";

export type Octokit = ReturnType<typeof getOctokit>;

export const CHECK_NAME = "hall-pass";
export const COMMENT_MARKER = "<!-- hall-pass -->";
export const LABEL_PREFIX = "hall-pass:";
const MAX_CHECK_TEXT = 65_000; // GitHub rejects check output over 65535 chars

export type CheckConclusion = "success" | "failure" | "neutral";

interface Repo {
  owner: string;
  name: string;
}

interface AutoMergeState {
  pullRequestId: string;
  enabledBy: string | null; // null when auto-merge is off
}

/** Bots show up as "slug[bot]" in REST and as "slug" in GraphQL. Compare on the slug. */
export function sameActor(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const norm = (s: string) => s.toLowerCase().replace(/\[bot\]$/, "");
  return norm(a) === norm(b);
}

function truncate(s: string): string {
  return s.length <= MAX_CHECK_TEXT ? s : s.slice(0, MAX_CHECK_TEXT) + "\n\n…truncated";
}

export class GitHubOps {
  /** Our own login ("slug[bot]"), learned from the first check run we create. */
  self: string | null = null;

  constructor(
    private readonly octokit: Octokit,
    private readonly repo: Repo,
  ) {}

  private get r() {
    return { owner: this.repo.owner, repo: this.repo.name };
  }

  // ---- check run -------------------------------------------------------

  async createCheckRun(headSha: string, conclusion: CheckConclusion, title: string, summary: string): Promise<number> {
    const res = await this.octokit.rest.checks.create({
      ...this.r,
      name: CHECK_NAME,
      head_sha: headSha,
      status: "completed",
      conclusion,
      output: { title: truncate(title).slice(0, 255), summary: truncate(summary) },
    });
    const slug = res.data.app?.slug;
    if (slug) this.self = `${slug}[bot]`;
    return res.data.id;
  }

  /** Open an in-progress check run. Also tells us who we are, before any review or auto-merge write. */
  async startCheckRun(headSha: string): Promise<number> {
    const res = await this.octokit.rest.checks.create({
      ...this.r,
      name: CHECK_NAME,
      head_sha: headSha,
      status: "in_progress",
    });
    const slug = res.data.app?.slug;
    if (slug) this.self = `${slug}[bot]`;
    return res.data.id;
  }

  async completeCheckRun(id: number, conclusion: CheckConclusion, title: string, summary: string): Promise<void> {
    await this.octokit.rest.checks.update({
      ...this.r,
      check_run_id: id,
      status: "completed",
      conclusion,
      output: { title: truncate(title).slice(0, 255), summary: truncate(summary) },
    });
  }

  // ---- sticky comment --------------------------------------------------

  async upsertComment(number: number, body: string): Promise<void> {
    const full = `${COMMENT_MARKER}\n${body}`;
    const comments = await this.octokit.paginate(this.octokit.rest.issues.listComments, {
      ...this.r,
      issue_number: number,
      per_page: 100,
    });
    const mine = comments.find(
      (c) => c.body?.includes(COMMENT_MARKER) && (this.self === null || sameActor(c.user?.login, this.self)),
    );
    if (!mine) {
      await this.octokit.rest.issues.createComment({ ...this.r, issue_number: number, body: full });
    } else if (mine.body !== full) {
      await this.octokit.rest.issues.updateComment({ ...this.r, comment_id: mine.id, body: full });
    }
  }

  // ---- labels ----------------------------------------------------------

  /** Make the PR's hall-pass: labels exactly `wanted`. Leaves every other label alone. */
  async syncLabels(number: number, categories: string[]): Promise<void> {
    const wanted = new Set(categories.map((c) => `${LABEL_PREFIX}${c}`));
    const current = (
      await this.octokit.paginate(this.octokit.rest.issues.listLabelsOnIssue, {
        ...this.r,
        issue_number: number,
        per_page: 100,
      })
    ).map((l) => l.name);

    const toAdd = [...wanted].filter((l) => !current.includes(l));
    const toRemove = current.filter((l) => l.startsWith(LABEL_PREFIX) && !wanted.has(l));

    if (toAdd.length) await this.octokit.rest.issues.addLabels({ ...this.r, issue_number: number, labels: toAdd });
    for (const name of toRemove) {
      try {
        await this.octokit.rest.issues.removeLabel({ ...this.r, issue_number: number, name });
      } catch (e) {
        if ((e as { status?: number }).status !== 404) throw e; // already gone is fine
      }
    }
  }

  // ---- reviews ---------------------------------------------------------

  private async myApprovals(number: number) {
    if (!this.self) throw new Error("merge-bot identity unknown; refusing to touch reviews");
    const reviews = await this.octokit.paginate(this.octokit.rest.pulls.listReviews, {
      ...this.r,
      pull_number: number,
      per_page: 100,
    });
    return reviews.filter((r) => r.state === "APPROVED" && sameActor(r.user?.login, this.self));
  }

  /** Approve, unless we already have an approval on this exact head SHA. Returns true if it approved. */
  async approve(number: number, headSha: string, body: string): Promise<boolean> {
    const mine = await this.myApprovals(number);
    if (mine.some((r) => r.commit_id === headSha)) return false;
    await this.octokit.rest.pulls.createReview({
      ...this.r,
      pull_number: number,
      commit_id: headSha,
      event: "APPROVE",
      body,
    });
    return true;
  }

  /** Dismiss every active approval merge-bot holds on this PR. Returns how many it dismissed. */
  async dismissApprovals(number: number, message: string): Promise<number> {
    const mine = await this.myApprovals(number);
    for (const r of mine) {
      await this.octokit.rest.pulls.dismissReview({ ...this.r, pull_number: number, review_id: r.id, message });
    }
    return mine.length;
  }

  // ---- auto-merge ------------------------------------------------------

  async autoMergeState(number: number): Promise<AutoMergeState> {
    const res = await this.octokit.graphql<{
      repository: {
        pullRequest: { id: string; autoMergeRequest: { enabledBy: { login: string } | null } | null };
      };
    }>(
      `query($owner: String!, $name: String!, $number: Int!) {
        repository(owner: $owner, name: $name) {
          pullRequest(number: $number) {
            id
            autoMergeRequest { enabledBy { login } }
          }
        }
      }`,
      { owner: this.repo.owner, name: this.repo.name, number },
    );
    const pr = res.repository.pullRequest;
    return {
      pullRequestId: pr.id,
      enabledBy: pr.autoMergeRequest ? (pr.autoMergeRequest.enabledBy?.login ?? "(unknown)") : null,
    };
  }

  /**
   * Turn on auto-merge. Leaves it alone if anyone already turned it on.
   * Returns "enabled", "already-on" or "merged" (the PR was already clean, so
   * GitHub refused auto-merge and we merged it directly, pinned to headSha).
   */
  async enableAutoMerge(number: number, headSha: string, method: MergeMethod): Promise<"enabled" | "already-on" | "merged"> {
    const state = await this.autoMergeState(number);
    if (state.enabledBy !== null) return "already-on";
    try {
      await this.octokit.graphql(
        `mutation($id: ID!, $method: PullRequestMergeMethod!) {
          enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: $method }) {
            pullRequest { number }
          }
        }`,
        { id: state.pullRequestId, method: method.toUpperCase() },
      );
      return "enabled";
    } catch (e) {
      // GitHub won't enable auto-merge on a PR that can merge right now.
      if (/clean status/i.test(String((e as Error).message))) {
        await this.octokit.rest.pulls.merge({ ...this.r, pull_number: number, sha: headSha, merge_method: method });
        return "merged";
      }
      throw e;
    }
  }

  /** Turn off auto-merge, but only if merge-bot turned it on. Never touches a human's. */
  async disableOwnAutoMerge(number: number): Promise<boolean> {
    if (!this.self) throw new Error("merge-bot identity unknown; refusing to touch auto-merge");
    const state = await this.autoMergeState(number);
    if (state.enabledBy === null || !sameActor(state.enabledBy, this.self)) return false;
    await this.octokit.graphql(
      `mutation($id: ID!) {
        disablePullRequestAutoMerge(input: { pullRequestId: $id }) { pullRequest { number } }
      }`,
      { id: state.pullRequestId },
    );
    return true;
  }
}
