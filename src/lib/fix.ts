import { run } from "./run.js";
import { consultChatGPT, logContextFromFile } from "./chatgpt.js";
import { changedWorkspaces, findScriptsByKeywords, hasScript, listWorkspaces, workspaceScriptCommand, WorkspaceInfo } from "./workspaces.js";

const dockerRemediationCmd = process.env.PAN_DOCKER_DEV_CMD?.trim();
const buildScriptPreference = ["build:ci", "build", "compile", "prepare"];
const remediationKeywordDefaults = ["fix", "clean", "prepare", "postinstall"];

type RunResult = Awaited<ReturnType<typeof run>>;

interface BuildFailure {
  workspace: WorkspaceInfo | null;
  result: RunResult;
}

export async function smartBuildFix(): Promise<boolean> {
  const allWorkspaces = await listWorkspaces();
  const targets = await changedWorkspaces();
  const first = await runBuildSequence(targets);
  if (first.ok) return true;

  const combinedLog = failureBlob(first.failures);
  await runRemediations(combinedLog, { targets, allWorkspaces, failures: first.failures });

  const second = await runBuildSequence(targets);
  if (second.ok) return true;

  await run("yarn install", "yarn install");
  const third = await runBuildSequence(targets);
  if (third.ok) return true;

  const latestFailures = third.failures.length ? third.failures : (second.failures.length ? second.failures : first.failures);
  const workspaceList = targets.map(ws => ws.isRoot ? "root workspace" : ws.name).join(", ") || "root workspace";
  const totalRuns = first.ran + second.ran + third.ran;
  const failingTargets = latestFailures.map(f => f.workspace ? (f.workspace.isRoot ? "root workspace build" : `${f.workspace.name} build`) : "build").join(", ");
  const summary = [
    `Pan smartBuildFix attempted ${totalRuns} build run(s) targeting ${workspaceList}.`,
    "Automated remediations (prisma generate, cache clean, migrate/fix scripts, Docker recovery, yarn install) were executed, but the build still fails.",
    failingTargets ? `Latest failing targets: ${failingTargets}.` : "",
  ].filter(Boolean).join(" ");

  await consultChatGPT({
    summary,
    question: "What additional build or remediation commands should Pan try next to restore a passing build?",
    logs: latestFailures.map(f => {
      const label = f.workspace ? (f.workspace.isRoot ? "root workspace build" : `${f.workspace.name} build`) : "build";
      return logContextFromFile(label, f.result.logFile);
    }),
  });

  return false;
}

async function runBuildSequence(targets: WorkspaceInfo[]): Promise<{ ok: boolean; failures: BuildFailure[]; ran: number }> {
  const failures: BuildFailure[] = [];
  let ran = 0;

  for (const ws of targets) {
    const script = selectBuildScript(ws);
    if (!script) {
      console.log(`[pan] ℹ no build script found for ${ws.isRoot ? "root workspace" : ws.name}, skipping.`);
      continue;
    }
    ran++;
    const cmd = workspaceScriptCommand(ws, script);
    const res = await run(cmd, `${ws.isRoot ? "root" : ws.name} ${script}`);
    if (!res.ok) failures.push({ workspace: ws, result: res });
  }

  if (ran === 0) {
    const fallback = await run("yarn build", "yarn build (fallback)");
    if (!fallback.ok) return { ok: false, failures: [{ workspace: targets.find(w => w.isRoot) || null, result: fallback }], ran: 1 };
    return { ok: true, failures: [], ran: 1 };
  }

  return { ok: failures.length === 0, failures, ran };
}

async function runRemediations(blob: string, ctx: { targets: WorkspaceInfo[]; allWorkspaces: WorkspaceInfo[]; failures: BuildFailure[] }) {
  if (!blob.trim()) return;
  const lower = blob.toLowerCase();
  const executed = new Set<string>();

  if (/prisma|p100|client/.test(lower)) {
    await run("npx prisma generate", "prisma generate");
  }

  if (/tsbuildinfo|cannot find module|duplicate identifier|ts180/.test(lower)) {
    const deepClean = 'find packages -name "build" -type d -exec rm -rf {} + 2>/dev/null && find packages -name "tsconfig.tsbuildinfo" -type f -delete && find . -name "node_modules" -type d -exec rm -rf {} + 2>/dev/null';
    await run(deepClean, "workspace cache clean");
  }

  if (/cache|yn000|integrity/.test(lower)) {
    await run("yarn cache clean", "yarn cache clean");
  }

  if (/migrat/.test(lower)) {
    const migrateScripts = collectScripts(ctx.targets, ["migrate"], ctx.allWorkspaces);
    for (const entry of migrateScripts) {
      const cmd = workspaceScriptCommand(entry.workspace, entry.script);
      if (executed.has(cmd)) continue;
      executed.add(cmd);
      await run(cmd, `${entry.workspace.isRoot ? "root" : entry.workspace.name} ${entry.script}`);
    }
  }

  if (dockerRemediationCmd && /docker|cannot connect to the docker daemon/.test(lower)) {
    await run(dockerRemediationCmd, "docker remediation");
  }

  const failureKeywords = deriveKeywordsFromFailures(ctx.failures);
  const scriptTargets = collectScripts(ctx.targets, [...new Set([...failureKeywords, ...remediationKeywordDefaults])], ctx.allWorkspaces);
  for (const entry of scriptTargets) {
    const cmd = workspaceScriptCommand(entry.workspace, entry.script);
    if (executed.has(cmd)) continue;
    executed.add(cmd);
    await run(cmd, `${entry.workspace.isRoot ? "root" : entry.workspace.name} ${entry.script}`);
  }
}

function selectBuildScript(ws: WorkspaceInfo) {
  for (const candidate of buildScriptPreference) {
    if (hasScript(ws, candidate)) return candidate;
  }
  const buildCandidates = Object.keys(ws.scripts || {}).filter(s => /build|compile/.test(s));
  return buildCandidates[0];
}

function failureBlob(failures: BuildFailure[]) {
  return failures.map(f => `${f.result.stdout}\n${f.result.stderr}`).join("\n");
}

function collectScripts(targets: WorkspaceInfo[], keywords: string[], all: WorkspaceInfo[]) {
  const scripts: { workspace: WorkspaceInfo; script: string }[] = [];
  const checkList = [...targets, ...all.filter(ws => ws.isRoot)];
  for (const ws of checkList) {
    const matched = findScriptsByKeywords(ws, keywords);
    for (const script of matched) {
      scripts.push({ workspace: ws, script });
    }
  }
  return scripts;
}

function deriveKeywordsFromFailures(failures: BuildFailure[]) {
  const keywords = new Set<string>();
  for (const failure of failures) {
    const blob = `${failure.result.stdout}\n${failure.result.stderr}`.toLowerCase();
    if (blob.includes("cache")) keywords.add("cache");
    if (blob.includes("migrat")) keywords.add("migrate");
    if (blob.includes("clean")) keywords.add("clean");
    if (blob.includes("prisma")) keywords.add("prisma");
    if (blob.includes("rebuild")) keywords.add("rebuild");
    if (blob.includes("docker")) keywords.add("docker");
    if (blob.includes("lint")) keywords.add("lint");
  }
  return Array.from(keywords);
}
