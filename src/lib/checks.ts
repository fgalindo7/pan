import { run } from "./run.js";
import { changedWorkspaces, hasScript, listWorkspaces, workspaceScriptCommand, WorkspaceInfo } from "./workspaces.js";

const testScriptPreference = ["test:ci", "test:coverage", "test", "unit:test", "test:unit"];

/** Lint/type-check/dirty-index orchestration for Pan. */
export async function lintFix() { return run("yarn lint --fix", "lint --fix"); }
export async function typeCheck() { return run("yarn type-check", "type-check"); }
export async function dirtyIndexCheck() { return run("yarn dirty-index-check", "dirty-index-check"); }

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

async function gatherTestCommands(targets: WorkspaceInfo[]) {
  const commands: { workspace: WorkspaceInfo; script: string; cmd: string }[] = [];
  const seen = new Set<string>();

  for (const ws of targets) {
    const script = selectTestScript(ws);
    if (!script) continue;
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
      if (script) {
        const cmd = workspaceScriptCommand(root, script);
        if (!seen.has(cmd)) {
          seen.add(cmd);
          commands.push({ workspace: root, script, cmd });
        }
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
