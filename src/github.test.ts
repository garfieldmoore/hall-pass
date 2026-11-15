import { describe, expect, it, vi } from "vitest";
import { GitHubOps, MAX_CHECK_RUN_RETRIES } from "./github.js";
import { fakeOctokit } from "./testing/fake-octokit.js";

const repo = { owner: "example-org", name: "sandbox" };

async function complete(notYetVisible: number) {
  const fake = fakeOctokit({ checkRunNotYetVisible: notYetVisible });
  const ops = new GitHubOps(fake.octokit, repo);
  const id = await ops.startCheckRun("head1");
  vi.useFakeTimers();
  try {
    const p = ops.completeCheckRun(id, "success", "t", "s").then(
      () => "ok",
      (e: { status?: number }) => `threw ${e.status}`,
    );
    await vi.runAllTimersAsync();
    return { result: await p, updates: fake.state.calls.filter((c) => c === "checks.update").length };
  } finally {
    vi.useRealTimers();
  }
}

describe("completeCheckRun retries a 404 on a just-created check run", () => {
  it("retries 3 times, so 4 attempts at most", () => {
    expect(MAX_CHECK_RUN_RETRIES).toBe(3);
  });

  it("succeeds on the last allowed attempt", async () => {
    expect(await complete(MAX_CHECK_RUN_RETRIES)).toEqual({ result: "ok", updates: 4 });
  });

  it("gives up after 4 attempts and rethrows the 404", async () => {
    expect(await complete(99)).toEqual({ result: "threw 404", updates: 4 });
  });

  it("doesn't retry when the first attempt works", async () => {
    expect(await complete(0)).toEqual({ result: "ok", updates: 1 });
  });
});
