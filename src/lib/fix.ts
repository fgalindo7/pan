import * as fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { run, addCommandRecorder, type CommandRecord } from "./run.js";
import { resolveOriginDefaultRef, getBranchStatus, type BranchStatus } from "./git.js";
import { FFYC_COMMAND } from "./toolkit.js";
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

interface SmartFixOptions {
  skipConsult?: boolean;
  interactive?: boolean;
  label?: string;
}

export interface SmartBuildFixResult {
  ok: boolean;
  summary: string;
  steps: string[];
  failures: BuildFailure[];
  attempts: number;
  blockedMessage?: string;
  consulted: boolean;
  commands: CommandRecord[];
}

export async function smartBuildFix(options: SmartFixOptions = {}): Promise<SmartBuildFixResult> {
  const { skipConsult = false, interactive = true } = options;
  const steps: string[] = [];
  let consulted = false;
  let totalRuns = 0;
  const commands: CommandRecord[] = [];
  const removeRecorder = addCommandRecorder(entry => commands.push(entry));
  try {

  const allWorkspaces = await listWorkspaces();
  const targets = await changedWorkspaces();
  const rootWorkspace = allWorkspaces.find(ws => ws.isRoot) || null;

    const priority = await attemptPriorityRemediation(rootWorkspace);
    if (priority.status === "ok") {
      steps.push(`Priority remediation (${priority.chainLabel}) completed successfully.`);
      return {
        ok: true,
        summary: "Priority remediation finished cleanly; no further build work was required.",
        steps,
        failures: [],
        attempts: totalRuns,
        consulted,
        commands,
      };
    }

    if (priority.status === "blocked") {
      const summary = priority.message;
      steps.push(`Priority remediation blocked during ${priority.chainLabel}: ${priority.message}`);
      return {
        ok: false,
        summary,
        steps,
        failures: [],
        attempts: totalRuns,
        blockedMessage: priority.message,
        consulted,
        commands,
      };
    }
  const continuationReason = priority.reason;
  steps.push(continuationReason
    ? `Priority remediation could not complete during ${priority.chainLabel} (${continuationReason}); continuing with targeted builds.`
    : `Priority remediation completed (${priority.chainLabel}); continuing with targeted builds.`);

  const first = await runBuildSequence(targets);
  totalRuns += first.ran;
  steps.push(describeRun("Initial build pass", first, targets));
  if (first.ok) {
    const summary = buildSuccessSummary("Initial build pass", targets, totalRuns);
    return { ok: true, summary, steps, failures: [], attempts: totalRuns, consulted, commands };
  }

  const combinedLog = failureBlob(first.failures);
  await runRemediations(combinedLog, { targets, allWorkspaces, failures: first.failures });
  steps.push("Executed remediation scripts based on failure output.");

  const second = await runBuildSequence(targets);
  totalRuns += second.ran;
  steps.push(describeRun("Post-remediation build pass", second, targets));
  if (second.ok) {
    const summary = buildSuccessSummary("Post-remediation build pass", targets, totalRuns);
    return { ok: true, summary, steps, failures: [], attempts: totalRuns, consulted, commands };
  }

  await run("yarn install", "yarn install");
  steps.push("Ran yarn install to refresh dependencies.");

  const third = await runBuildSequence(targets);
  totalRuns += third.ran;
  steps.push(describeRun("Post-install build pass", third, targets));
  if (third.ok) {
    const summary = buildSuccessSummary("Post-install build pass", targets, totalRuns);
    return { ok: true, summary, steps, failures: [], attempts: totalRuns, consulted, commands };
  }

  let postFfyc: Awaited<ReturnType<typeof runBuildSequence>> | null = null;
  if (interactive) {
    const shouldRunFfyc = await confirmFfyc();
    if (shouldRunFfyc) {
      const ffycResult = await run(FFYC_COMMAND, "ffyc deep clean");
      if (ffycResult.ok) {
        steps.push("Ran ffyc deep clean.");
        postFfyc = await runBuildSequence(targets);
        totalRuns += postFfyc.ran;
        steps.push(describeRun("Post-ffyc build pass", postFfyc, targets));
        if (postFfyc.ok) {
          const summary = buildSuccessSummary("Post-ffyc build pass", targets, totalRuns);
          return { ok: true, summary, steps, failures: [], attempts: totalRuns, consulted, commands };
        }
      } else {
        steps.push("ffyc deep clean failed; continuing without it.");
      }
    } else {
      steps.push("Skipped ffyc deep clean (user declined).");
    }
  } else {
    steps.push("Skipped ffyc deep clean (non-interactive mode).");
  }

  const latestRun = postFfyc ?? third;
  const latestFailures = latestRun.failures.length
    ? latestRun.failures
    : (second.failures.length ? second.failures : first.failures);

  const workspaceList = formatWorkspaceList(targets);
  const failureNames = latestFailures.map(failureLabel).join(", ") || workspaceList;
  const summary = [
    `Build remains failing after ${totalRuns} targeted attempt${totalRuns === 1 ? "" : "s"} covering ${workspaceList}.`,
    `Latest failing targets: ${failureNames}.`,
    "Check the .repo-doctor logs above for details.",
  ].join(" ");

  if (!skipConsult) {
    await consultChatGPT({
      summary,
      question: "What additional build or remediation commands should Pan try next to restore a passing build?",
      logs: latestFailures.map(f => {
        const label = failureLabel(f);
        return logContextFromFile(label, f.result.logFile);
      }),
    });
    consulted = true;
  }

  return {
    ok: false,
    summary,
    steps,
    failures: latestFailures,
    attempts: totalRuns,
    consulted,
    commands,
  };
  } finally {
    removeRecorder();
  }
}

type PriorityOutcome =
  | { status: "ok"; target: string; chainLabel: string }
  | { status: "continue"; target: string; chainLabel: string; reason?: string }
  | { status: "blocked"; target: string; chainLabel: string; message: string };

async function attemptPriorityRemediation(root: WorkspaceInfo | null): Promise<PriorityOutcome> {
  const steps = priorityCommandSteps(root);
  let target = "origin/master";
  let chainLabel = priorityChainLabel(target, steps);

  const fetchRes = await run("git fetch --prune", "git fetch origin");
  if (!fetchRes.ok) {
    console.log("[pan] Priority remediation: git fetch failed, continuing with standard flow.");
    return { status: "continue", reason: "git fetch origin", target, chainLabel };
  }

  target = await resolveOriginDefaultRef();
  chainLabel = priorityChainLabel(target, steps);
  console.log(`[pan] Priority remediation: ${chainLabel}`);

  const rebaseRes = await run(`git rebase --autostash ${target}`, `git rebase ${target}`);
  if (!rebaseRes.ok) {
    console.log(`[pan] Priority remediation: git rebase ${target} failed — manual resolution required.`);
    const message = await explainRebaseFailure(target);
    return { status: "blocked", message, target, chainLabel };
  }

  for (const step of steps) {
    const res = await run(step.cmd, step.label);
    if (!res.ok) {
      console.log(`[pan] Priority remediation: ${step.label} failed, falling back to standard remediation.`);
      return { status: "continue", reason: step.label, target, chainLabel };
    }
  }

  return { status: "ok", target, chainLabel };
}

function priorityChainLabel(target: string, steps: Array<{ label: string }>) {
  const aliasMap = new Map<string, string>([
    ["yarn cache clean", "ycc"],
    ["yarn install", "yi"],
    ["yarn build", "yb"],
    ["yarn lint", "yl"],
    ["yarn type-check", "ytc"],
  ]);
  const tail = steps
    .map(step => aliasMap.get(step.label) ?? step.label)
    .join(" → ");
  return tail ? `git fetch → git rebase ${target} → ${tail}` : `git fetch → git rebase ${target}`;
}

function priorityCommandSteps(root: WorkspaceInfo | null) {
  const steps: Array<{ cmd: string; label: string }> = [
    { cmd: "yarn cache clean", label: "yarn cache clean" },
    { cmd: "yarn install", label: "yarn install" },
  ];

  if (root && hasScript(root, "build")) {
    const buildCmd = scriptCommand(root, "build");
    if (buildCmd) {
      steps.push({ cmd: buildCmd, label: "yarn build" });
    }
  } else {
    console.log("[pan] Priority remediation: skipping yarn build (script not found).");
  }

  const lintCmd = scriptCommand(root, "lint");
  if (lintCmd) {
    steps.push({ cmd: lintCmd, label: "yarn lint" });
  } else {
    console.log("[pan] Priority remediation: skipping yarn lint (script not found).");
  }

  const typeCheckCmd = scriptCommand(root, "type-check") || scriptCommand(root, "typecheck");
  if (typeCheckCmd) {
    steps.push({ cmd: typeCheckCmd, label: "yarn type-check" });
  } else {
    console.log("[pan] Priority remediation: skipping yarn type-check (script not found).");
  }

  return steps;
}

function scriptCommand(root: WorkspaceInfo | null, script: string) {
  if (!root) return "";
  if (!hasScript(root, script)) return "";
  return workspaceScriptCommand(root, script);
}

async function confirmFfyc() {
  console.log("[pan] Priority remediation exhausted. Before contacting an assistant, you can run ffyc (deep clean).");
  return promptYesNo("[pan] Run ffyc deep clean now? [y/N] ", false);
}

async function promptYesNo(question: string, defaultYes = false) {
  const rl = readline.createInterface({ input, output });
  try {
    const response = (await rl.question(question)).trim().toLowerCase();
    if (!response) return defaultYes;
    if (["y", "yes"].includes(response)) return true;
    if (["n", "no"].includes(response)) return false;
    return defaultYes;
  } finally {
    rl.close();
  }
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

function describeRun(label: string, result: { ok: boolean; failures: BuildFailure[] }, targets: WorkspaceInfo[]) {
  if (result.ok) {
    return `${label} succeeded for ${formatWorkspaceList(targets)}.`;
  }
  const failures = result.failures.map(failureLabel).join(", ") || formatWorkspaceList(targets);
  return `${label} failed for ${failures}.`;
}

function buildSuccessSummary(phase: string, targets: WorkspaceInfo[], runCount: number) {
  const workspaceList = formatWorkspaceList(targets);
  return `${phase} succeeded after ${runCount} targeted run${runCount === 1 ? "" : "s"} covering ${workspaceList}.`;
}

function formatWorkspaceList(targets: WorkspaceInfo[]) {
  const names = targets.length ? targets.map(ws => ws.isRoot ? "root workspace" : ws.name) : ["root workspace"];
  return humanJoin(Array.from(new Set(names)));
}

function failureLabel(failure: BuildFailure) {
  if (!failure.workspace) return "build";
  return failure.workspace.isRoot ? "root workspace build" : `${failure.workspace.name} build`;
}

function humanJoin(items: string[]) {
  if (!items.length) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

interface RebaseDiagnostics {
  branchStatus: BranchStatus;
  head: string;
  rebaseInProgress: boolean;
  autoAborted: boolean;
}

async function explainRebaseFailure(target: string) {
  const diagnostics = await gatherRebaseDiagnostics();
  const { branchStatus, head, rebaseInProgress, autoAborted } = diagnostics;
  const branchLabel = branchStatus.name && branchStatus.name !== "(detached)" ? branchStatus.name : "your branch";
  const upstreamLabel = branchStatus.upstream || "its upstream";

  const lines: string[] = [
    `git rebase ${target} failed, so Pan paused automated remediation to avoid corrupting your branch history.`,
  ];

  if (branchStatus.detached && head) {
    lines.push(`HEAD ended up detached at ${head}.`);
  }

  if (branchStatus.ahead > 0 && branchStatus.behind > 0) {
    lines.push(`Local ${branchLabel} and ${upstreamLabel} have diverged (+${branchStatus.ahead}/-${branchStatus.behind}). Both sides contain commits the other does not (common after a force-push).`);
  } else if (branchStatus.ahead > 0) {
    lines.push(`Local ${branchLabel} is ahead of ${upstreamLabel} by ${branchStatus.ahead} commit${branchStatus.ahead === 1 ? "" : "s"}.`);
  } else if (branchStatus.behind > 0) {
    lines.push(`${branchLabel} is behind ${upstreamLabel} by ${branchStatus.behind} commit${branchStatus.behind === 1 ? "" : "s"}.`);
  }

  if (autoAborted) {
    lines.push("Pan detected the in-progress rebase and ran `git rebase --abort` to return you to a safe state.");
  } else if (rebaseInProgress) {
    lines.push("A Git rebase is still in progress. Abort it before rerunning Pan.");
  }

  const suggestions: string[] = [];
  if (rebaseInProgress && !autoAborted) {
    suggestions.push("- Run `git rebase --abort` to exit the half-applied rebase.");
  }

  if (branchStatus.upstream) {
    const upstream = branchStatus.upstream;
    suggestions.push(
      "- Decide how to reconcile " +
        branchLabel +
        " with " +
        upstream +
        ". If you want the remote history, run `git fetch origin && git reset --hard " +
        upstream +
        "`. If you need your local commits, create a backup branch and replay them after syncing with " +
        upstream +
        "."
    );
  } else {
    suggestions.push("- Reconcile your branch with " + target + ", then rerun `pan fix`.");
  }

  suggestions.push("- After the branch history is settled, rerun `pan fix` to continue remediation.");

  return `${lines.join(" ")}\n${suggestions.join("\n")}`;
}

async function gatherRebaseDiagnostics(): Promise<RebaseDiagnostics> {
  const gitDir = process.env.GIT_DIR || ".git";
  const rebaseMerge = path.join(gitDir, "rebase-merge");
  const rebaseApply = path.join(gitDir, "rebase-apply");
  const rebaseInProgress = fs.existsSync(rebaseMerge) || fs.existsSync(rebaseApply);

  const branchStatus: BranchStatus = (await getBranchStatus()) ?? {
    name: "",
    ahead: 0,
    behind: 0,
    detached: false,
  };

  const headRes = await run("git rev-parse --short HEAD", "git rev-parse --short HEAD", { silence: true });
  const head = headRes.ok ? headRes.stdout.trim() : "";

  let autoAborted = false;
  if (rebaseInProgress) {
    const abortRes = await run("git rebase --abort", "git rebase --abort", { silence: true });
    if (abortRes.ok) {
      autoAborted = true;
      console.log("[pan] Priority remediation: auto-aborted git rebase to restore your worktree.");
      const updated = await getBranchStatus();
      if (updated) {
        branchStatus.name = updated.name || branchStatus.name;
        branchStatus.upstream = updated.upstream ?? branchStatus.upstream;
        branchStatus.ahead = updated.ahead;
        branchStatus.behind = updated.behind;
        branchStatus.detached = updated.detached;
      }
    }
  }

  return { branchStatus, head, rebaseInProgress, autoAborted };
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
