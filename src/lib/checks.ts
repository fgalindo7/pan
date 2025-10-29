import { run } from "./run.js";
import { changedWorkspaces, hasScript, listWorkspaces, workspaceScriptCommand, WorkspaceInfo } from "./workspaces.js";

const testScriptPreference = ["test:ci", "test:coverage", "test", "unit:test", "test:unit"];

/** Lint/type-check/dirty-index orchestration for Pan. */
export async function lintFix() {
  const root = await resolveRootWorkspace();
  if (!root) return skip("lint --fix", "workspace metadata unavailable");

  if (hasScript(root, "lint:fix")) {
    const cmd = workspaceScriptCommand(root, "lint:fix");
    return run(cmd, "lint:fix");
  }

  if (hasScript(root, "lint")) {
    const cmd = workspaceScriptCommand(root, "lint");
    return run(`${cmd} --fix`, "lint --fix");
  }

  console.log("[pan] ℹ skipping lint --fix (script not found).");
  return skip("lint --fix", "script not found");
}

export async function typeCheck() {
  const root = await resolveRootWorkspace();
  if (!root) return skip("type-check", "workspace metadata unavailable");

  const script = selectFirstScript(root, ["type-check", "typecheck", "check", "tsc"]);
  if (!script) {
    console.log("[pan] ℹ skipping type-check (script not found).");
    return skip("type-check", "script not found");
  }

  const cmd = workspaceScriptCommand(root, script);
  return run(cmd, script);
}

export async function dirtyIndexCheck() {
  const root = await resolveRootWorkspace();
  if (!root) return skip("dirty-index-check", "workspace metadata unavailable");

  if (!hasScript(root, "dirty-index-check")) {
    console.log("[pan] ℹ skipping dirty-index-check (script not found).");
    return skip("dirty-index-check", "script not found");
  }

  const cmd = workspaceScriptCommand(root, "dirty-index-check");
  return run(cmd, "dirty-index-check");
}

export async function runRelevantTests(): Promise<boolean> {
  const targets = await changedWorkspaces();
  const commands = await gatherTestCommands(targets);
  if (!commands.length) {
    console.log("[pan] ℹ no targeted tests discovered.");
    return true;
  }
  let ok = true;
  for (const entry of commands) {
    const res = await run(entry.cmd, `${entry.workspace.isRoot ? "root" : entry.workspace.name} ${entry.script}`);
    if (!res.ok) ok = false;
  }
  return ok;
}

export async function runPrepushChecks(): Promise<boolean> {
  const l = await lintFix(); if (!l.ok) return false;
  const t = await typeCheck(); if (!t.ok) return false;
  const tests = await runRelevantTests(); if (!tests) return false;
  const d = await dirtyIndexCheck(); return d.ok;
}

async function resolveRootWorkspace() {
  const workspaces = await listWorkspaces();
  return workspaces.find(ws => ws.isRoot) ?? null;
}

function selectFirstScript(ws: WorkspaceInfo, candidates: string[]) {
  for (const name of candidates) {
    if (hasScript(ws, name)) return name;
  }
  return null;
}

function skip(label: string, reason: string) {
  return { ok: true, stdout: "", stderr: `skipped: ${reason}`, logFile: "" } as Awaited<ReturnType<typeof run>>;
}

async function gatherTestCommands(targets: WorkspaceInfo[]) {
  const commands: { workspace: WorkspaceInfo; script: string; cmd: string }[] = [];
  const seen = new Set<string>();

  for (const ws of targets) {
    const script = selectTestScript(ws);
    if (!script) continue;
    if (isPlaceholderTestScript(ws, script)) {
      console.log(`[pan] Skipping ${ws.isRoot ? "root" : ws.name} ${script} (placeholder test script).`);
      continue;
    }
    const cmd = workspaceScriptCommand(ws, script);
    if (seen.has(cmd)) continue;
    seen.add(cmd);
    commands.push({ workspace: ws, script, cmd });
  }

  if (!commands.length) {
    const workspaces = await listWorkspaces();
    const root = workspaces.find(w => w.isRoot);
    if (root) {
      const script = selectTestScript(root);
      if (script && !isPlaceholderTestScript(root, script)) {
        const cmd = workspaceScriptCommand(root, script);
        if (!seen.has(cmd)) {
          seen.add(cmd);
          commands.push({ workspace: root, script, cmd });
        }
      } else if (script) {
        console.log("[pan] Skipping root test (placeholder test script).");
      }
    }
  }

  return commands;
}

function selectTestScript(ws: WorkspaceInfo) {
  for (const candidate of testScriptPreference) {
    if (hasScript(ws, candidate)) return candidate;
  }
  const fallback = Object.keys(ws.scripts || {}).find(s => /(test|jest|vitest|cypress)/i.test(s));
  return fallback || null;
}

function isPlaceholderTestScript(ws: WorkspaceInfo, script: string) {
  const body = ws.scripts?.[script];
  if (!body) return false;
  const normalized = body.replace(/\s+/g, " ").toLowerCase();
  return normalized.includes("no test specified") && normalized.includes("exit 1");
}
