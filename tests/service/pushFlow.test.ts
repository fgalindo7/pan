import { beforeEach, describe, expect, it } from "vitest";
import { importPushModule, pushMockState, resetPushMockState } from "./pushHarness";

const { pushFlow, validatePushOptions } = await importPushModule();

describe("pushFlow", () => {
  beforeEach(() => {
    resetPushMockState();
  });

  it("creates a feature branch and commits with provided options", async () => {
    const options = validatePushOptions({
      branchPrefix: "feat",
      branchName: "Test-Foundations",
      commitFirstLine: "test: scaffold vitest harness",
      commitBody: "Introduce baseline unit specs",
    });

    await pushFlow(options);

    expect(pushMockState.events).toContain("git:rebase");
    expect(pushMockState.events).toContain("fix:smartBuildFix");
    expect(pushMockState.events).toContain("checks:runPrepushChecks");
    expect(pushMockState.events).toContain("git:stageAll");
    expect(pushMockState.events).toContain("git:createBranch:francisco/feat/test-foundations");
    expect(pushMockState.events.some((event: string) => event.startsWith("git:commit:test: scaffold vitest harness|Introduce baseline unit specs"))).toBe(true);
    expect(pushMockState.events).toContain("git:push:francisco/feat/test-foundations");
  });

  it("reuses the current feature branch when it already meets policy", async () => {
    pushMockState.git.currentBranch = "francisco/feat/test-existing";
    pushMockState.git.branchStatus = {
      name: "francisco/feat/test-existing",
      upstream: "origin/francisco/feat/test-existing",
      ahead: 0,
      behind: 0,
      detached: false,
    };

    const options = validatePushOptions({
      commitFirstLine: "chore: reuse existing branch",
      commitBody: "Exercise the non-interactive branch negotiation path.",
    });

    await pushFlow(options);

    expect(pushMockState.events).not.toContain("git:createBranch:francisco/feat/test-existing");
    expect(pushMockState.events).toContain("git:push:francisco/feat/test-existing");
    expect(pushMockState.events.some((event: string) => event.startsWith("git:commit:chore: reuse existing branch|Exercise the non-interactive branch negotiation path."))).toBe(true);
  });

  it("creates a new feature branch when the current branch violates policy", async () => {
    pushMockState.git.currentBranch = "francisco/chore/legacy";

    const options = validatePushOptions({
      branchPrefix: "feat",
      branchName: "Negotiation Coverage",
      commitFirstLine: "test: cover branch negotiation",
    });

    await pushFlow(options);

    const expectedBranch = "francisco/feat/negotiation-coverage";

    expect(pushMockState.events).toContain("git:createBranch:" + expectedBranch);
    expect(pushMockState.events).toContain("git:push:" + expectedBranch);
    expect(pushMockState.events).not.toContain("git:push:francisco/chore/legacy");
  });
});
