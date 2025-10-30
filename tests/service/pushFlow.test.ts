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
});
