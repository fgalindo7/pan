/**
 * Branch naming policy enforcement for Pan.
 */
export const ALLOWED_PREFIX = ["ci", "docs", "feat", "fix", "perf", "refactor", "style"] as const;

export function userName(): string {
  return process.env.USER || process.env.LOGNAME || "dev";
}

export function validFeatureBranch(branch: string, user = userName()) {
  const u = user.replace(/[^a-zA-Z0-9._-]/g, "");
  const re = new RegExp(`^${u}/(?:${ALLOWED_PREFIX.join("|")})/.+`);
  return re.test(branch);
}

export function sanitizeSegment(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}
