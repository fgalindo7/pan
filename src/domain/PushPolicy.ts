const DEFAULT_ALLOWED_PREFIXES = ["ci", "docs", "feat", "fix", "perf", "refactor", "style"] as const;

export type AllowedPrefix = typeof DEFAULT_ALLOWED_PREFIXES[number];

export interface PushPolicyOptions {
  allowedPrefixes?: readonly string[];
}

export class PushPolicy {
  readonly allowedPrefixes: readonly string[];

  constructor(options: PushPolicyOptions = {}) {
    this.allowedPrefixes = options.allowedPrefixes?.map(prefix => prefix.toLowerCase()) ?? DEFAULT_ALLOWED_PREFIXES;
  }

  sanitizeSegment(input: string) {
    return input
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80);
  }

  isAllowedPrefix(prefix: string): prefix is AllowedPrefix {
    return this.allowedPrefixes.includes(prefix.toLowerCase());
  }

  validFeatureBranch(branch: string, user: string) {
    const normalizedUser = this.sanitizeUser(user);
    const regex = new RegExp(`^${normalizedUser}/(?:${this.allowedPrefixes.join("|")})/.+`);
    return regex.test(branch);
  }

  sanitizeUser(user: string) {
    return (user || "dev").replace(/[^a-zA-Z0-9._-]/g, "");
  }

  resolveUserName(env: NodeJS.ProcessEnv = process.env) {
    const candidate = env.USER || env.LOGNAME || env.GITHUB_USER || env.CI_USER;
    return this.sanitizeUser(candidate || "dev");
  }
}

export function defaultPushPolicy() {
  return new PushPolicy({ allowedPrefixes: DEFAULT_ALLOWED_PREFIXES });
}

export { DEFAULT_ALLOWED_PREFIXES };
