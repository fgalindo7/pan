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

export async function rebaseOntoOriginDefault() {
  await fetchOrigin();
  let onto = "origin/master";
  const hasMaster = await run("git show-ref --verify --quiet refs/remotes/origin/master", "check origin/master");
  if (!hasMaster.ok) onto = "origin/main";
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
