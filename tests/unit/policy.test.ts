import { describe, expect, it } from "vitest";
import { ALLOWED_PREFIX, sanitizeSegment, userName, validFeatureBranch } from "../../src/lib/policy";

describe("policy", () => {
  it("exposes the expected branch prefixes", () => {
    expect(ALLOWED_PREFIX).toMatchObject(["ci", "docs", "feat", "fix", "perf", "refactor", "style"]);
  });

  it("sanitizes branch segments", () => {
    expect(sanitizeSegment("Feature: Add Login!"))
      .toEqual("feature-add-login");
    expect(sanitizeSegment("  Already-clean ")).toEqual("already-clean");
    expect(sanitizeSegment("Symbols*&^%"))
      .toEqual("symbols");
  });

  it("caps branch segments at 80 characters", () => {
    const long = "a".repeat(200);
    expect(sanitizeSegment(long).length).toBeLessThanOrEqual(80);
  });

  it("accepts valid feature branches for the current user", () => {
    process.env.USER = "pan-dev";
    expect(validFeatureBranch("pan-dev/feat/sample"))
      .toBe(true);
  });

  it("rejects branches that do not follow the prefix convention", () => {
    process.env.USER = "pan-dev";
    expect(validFeatureBranch("pan-dev/feature/sample")).toBe(false);
  });

  it("derives the user name from the environment", () => {
    process.env.USER = "custom-user";
    expect(userName()).toBe("custom-user");

    delete process.env.USER;
    process.env.LOGNAME = "fallback-user";
    expect(userName()).toBe("fallback-user");
  });
});
