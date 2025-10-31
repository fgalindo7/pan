import { PushPolicy, DEFAULT_ALLOWED_PREFIXES } from "../domain/PushPolicy.js";

/**
 * Branch naming policy enforcement for Pan.
 */
export const ALLOWED_PREFIX = DEFAULT_ALLOWED_PREFIXES;

const defaultPolicy = new PushPolicy({ allowedPrefixes: ALLOWED_PREFIX });

export function userName(): string {
  return defaultPolicy.resolveUserName();
}

export function validFeatureBranch(branch: string, user = userName()) {
  return defaultPolicy.validFeatureBranch(branch, user);
}

export function sanitizeSegment(s: string) {
  return defaultPolicy.sanitizeSegment(s);
}

export { PushPolicy };
