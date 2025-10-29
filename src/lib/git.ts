import { run } from "./run.js";

/**
 * Git helpers for Pan.
 */
export async function currentBranch() {
  const r = await run("git rev-parse --abbrev-ref HEAD", "git branch");
  return r.ok ? r.stdout.trim() : "";
}

export async function worktreeClean() {
  const r = await run("git status --porcelain", "git status");
  return r.ok && r.stdout.trim().length === 0;
}

export async function fetchOrigin() {
  return run("git fetch origin", "git fetch origin");
}

export async function resolveOriginDefaultRef() {
  const masterCheck = await run(
    "git show-ref --verify --quiet refs/remotes/origin/master",
    "check origin/master",
    { silence: true }
  );
  if (masterCheck.ok) return "origin/master";

  const mainCheck = await run(
    "git show-ref --verify --quiet refs/remotes/origin/main",
    "check origin/main",
    { silence: true }
  );
  if (mainCheck.ok) return "origin/main";

  return "origin/master";
}

export interface BranchStatus {
  name: string;
  upstream?: string;
  ahead: number;
  behind: number;
  detached: boolean;
}

export async function getBranchStatus(): Promise<BranchStatus | null> {
  const res = await run("git status --porcelain=v2 --branch", "git status --porcelain=v2 --branch", { silence: true });
  if (!res.ok) return null;
  return parseBranchStatus(res.stdout);
}

export async function rebaseOntoOriginDefault() {
  await fetchOrigin();
  const onto = await resolveOriginDefaultRef();
  const rb = await run(`git rebase ${onto}`, `git rebase ${onto}`);
  return { onto, ok: rb.ok };
}

export async function createBranch(name: string) {
  return run(`git checkout -b ${name}`, `git checkout -b ${name}`);
}

export async function stageAll() {
  return run("git add -A", "git add -A");
}

export async function commit(msg: string) {
  return run(`git commit -m ${JSON.stringify(msg)}`, `git commit -m ${msg}`);
}

export async function pushSetUpstream(branch: string) {
  return run(`git push -u origin ${branch}`, `git push -u origin ${branch}`);
}

function parseBranchStatus(output: string): BranchStatus {
  const info: BranchStatus = { name: "", ahead: 0, behind: 0, detached: false };
  if (!output) return info;
  for (const line of output.split("\n")) {
    if (!line.startsWith("#")) continue;
    const trimmed = line.slice(2).trim();
    const match = trimmed.match(/^branch\.(\w+)\s+(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    const value = rawValue.trim();
    if (key === "head") {
      info.name = value;
      if (value === "(detached)" || value.startsWith("(detached")) info.detached = true;
    } else if (key === "upstream") {
      info.upstream = value;
    } else if (key === "ab") {
      const [aheadRaw, behindRaw] = value.split(" ");
      if (aheadRaw) info.ahead = parseAheadBehindValue(aheadRaw, "+");
      if (behindRaw) info.behind = parseAheadBehindValue(behindRaw, "-");
    }
  }
  return info;
}

function parseAheadBehindValue(value: string, prefix: "+" | "-"): number {
  const normalized = value.startsWith(prefix) ? value.slice(1) : value;
  const parsed = Number.parseInt(normalized, 10);
  return Number.isFinite(parsed) ? Math.max(parsed, 0) : 0;
}
