import * as fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { run, addCommandRecorder, type CommandRecord } from "./run.js";
import { consultChatGPT, logContextFromFile } from "./chatgpt.js";
import { resolveCommand, type CommandInstance } from "./commands.js";
import { resolveOriginDefaultRef } from "./git.js";
import { changedWorkspaces, findScriptsByKeywords, hasScript, listWorkspaces, workspaceScriptCommand } from "./workspaces.js";
import { Workspace } from "../domain/Workspace.js";
import { RemediationOutcome, type BuildFailure, type CommandLogEntry } from "../domain/RemediationStrategy.js";

const dockerRemediationCmd = process.env.PAN_DOCKER_DEV_CMD?.trim();
const buildScriptPreference = ["build:ci", "build", "compile", "prepare"];
const remediationKeywordDefaults = ["fix", "clean", "prepare", "postinstall"];

type RunResult = Awaited<ReturnType<typeof run>>;

function toCommandLogEntries(records: CommandRecord[]): CommandLogEntry[] {
  return records.map(record => ({
    command: record.command,
    label: record.label,
    ok: record.ok,
    exitCode: record.exitCode,
    durationMs: record.durationMs,
    timestamp: record.timestamp,
  }));
}

function toBuildFailure(workspace: Workspace | null, result: RunResult): BuildFailure {
  const code = result.ok ? 0 : result.code ?? 1;
  return {
    workspace,
    result: {
      stdout: result.stdout,
      stderr: result.stderr,
      logFile: result.logFile,
      code,
    },
  };
}

function createOutcome(params: {
  ok: boolean;
  summary: string;
  steps: string[];
  failures: BuildFailure[];
  attempts: number;
  consulted: boolean;
  blockedMessage?: string;
  commandRecords: CommandRecord[];
}): RemediationOutcome {
  return new RemediationOutcome({
    ok: params.ok,
    summary: params.summary,
    steps: params.steps,
    failures: params.failures,
    attempts: params.attempts,
    blockedMessage: params.blockedMessage,
    consulted: params.consulted,
    commands: toCommandLogEntries(params.commandRecords),
  });
}

interface SmartFixOptions {
  skipConsult?: boolean;
  interactive?: boolean;
  label?: string;
}

export type SmartBuildFixResult = RemediationOutcome;

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
      steps.push("Priority remediation (git fetch → git rebase origin/master → ycc → yi → yb → yl → ytc) completed successfully.");
      return createOutcome({
        ok: true,
        summary: "Priority remediation finished cleanly; no further build work was required.",
        steps,
        failures: [],
        attempts: totalRuns,
        consulted,
        commandRecords: commands,
      });
    }

    if (priority.status === "blocked") {
      const summary = priority.message;
      steps.push(`Priority remediation blocked: ${priority.message}`);
      return createOutcome({
        ok: false,
        summary,
        steps,
        failures: [],
        attempts: totalRuns,
        blockedMessage: priority.message,
        consulted,
        commandRecords: commands,
      });
    }
    const continuationReason = priority.reason;
    steps.push(continuationReason
      ? `Priority remediation could not complete (${continuationReason}); continuing with targeted builds.`
      : "Priority remediation completed; continuing with targeted builds.");

    const first = await runBuildSequence(targets);
    totalRuns += first.ran;
    steps.push(describeRun("Initial build pass", first, targets));
    if (first.ok) {
      const summary = buildSuccessSummary("Initial build pass", targets, totalRuns);
      return createOutcome({
        ok: true,
        summary,
        steps,
        failures: [],
        attempts: totalRuns,
        consulted,
        commandRecords: commands,
      });
    }

    const combinedLog = failureBlob(first.failures);
    await runRemediations(combinedLog, { targets, allWorkspaces, failures: first.failures });
    steps.push("Executed remediation scripts based on failure output.");

    const second = await runBuildSequence(targets);
    totalRuns += second.ran;
    steps.push(describeRun("Post-remediation build pass", second, targets));
    if (second.ok) {
      const summary = buildSuccessSummary("Post-remediation build pass", targets, totalRuns);
      return createOutcome({
        ok: true,
        summary,
        steps,
        failures: [],
        attempts: totalRuns,
        consulted,
        commandRecords: commands,
      });
    }

    const install = resolveCommand("yi");
    await run(install.command, install.label);
    steps.push("Ran yarn install to refresh dependencies.");

    const third = await runBuildSequence(targets);
    totalRuns += third.ran;
    steps.push(describeRun("Post-install build pass", third, targets));
    if (third.ok) {
      const summary = buildSuccessSummary("Post-install build pass", targets, totalRuns);
      return createOutcome({
        ok: true,
        summary,
        steps,
        failures: [],
        attempts: totalRuns,
        consulted,
        commandRecords: commands,
      });
    }

    let postFfyc: Awaited<ReturnType<typeof runBuildSequence>> | null = null;
    if (interactive) {
      const shouldRunFfyc = await confirmFfyc();
      if (shouldRunFfyc) {
        const ffyc = resolveCommand("ffyc");
        const ffycResult = await run(ffyc.command, ffyc.label);
        if (ffycResult.ok) {
          steps.push("Ran ffyc deep clean.");
          postFfyc = await runBuildSequence(targets);
          totalRuns += postFfyc.ran;
          steps.push(describeRun("Post-ffyc build pass", postFfyc, targets));
          if (postFfyc.ok) {
            const summary = buildSuccessSummary("Post-ffyc build pass", targets, totalRuns);
            return createOutcome({
              ok: true,
              summary,
              steps,
              failures: [],
              attempts: totalRuns,
              consulted,
              commandRecords: commands,
            });
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

    return createOutcome({
      ok: false,
      summary,
      steps,
      failures: latestFailures,
      attempts: totalRuns,
      consulted,
      commandRecords: commands,
    });
  } finally {
    removeRecorder();
  }
}

type PriorityOutcome =
  | { status: "ok" }
  | { status: "continue"; reason?: string }
  | { status: "blocked"; message: string };

async function attemptPriorityRemediation(root: Workspace | null): Promise<PriorityOutcome> {
  console.log("[pan] Priority remediation: git fetch → git rebase origin/master → ycc → yi → yb → yl → ytc");

  const fetch = resolveCommand("gfo");
  const fetchRes = await run(fetch.command, fetch.label);
  if (!fetchRes.ok) {
    console.log("[pan] Priority remediation: git fetch failed, continuing with standard flow.");
    return { status: "continue", reason: fetch.label };
  }

  const onto = await resolveOriginDefaultRef();
  const rebase = resolveCommand("grb", { target: onto, label: `git rebase ${onto}` });
  const rebaseRes = await run(rebase.command, rebase.label);
  if (!rebaseRes.ok) {
    console.log("[pan] Priority remediation: git rebase origin/master failed — manual resolution required.");
    const message = await explainRebaseFailure();
    return { status: "blocked", message };
  }

  const steps = priorityCommandSteps(root);
  for (const step of steps) {
    const res = await run(step.command, step.label);
    if (!res.ok) {
      console.log(`[pan] Priority remediation: ${step.label} failed, falling back to standard remediation.`);
      return { status: "continue", reason: step.label };
    }
  }

  return { status: "ok" };
}

function priorityCommandSteps(root: Workspace | null): CommandInstance[] {
  const steps: CommandInstance[] = [
    resolveCommand("ycc"),
    resolveCommand("yi"),
  ];

  const buildCmd = scriptCommand(root, "build") || "yarn run build";
  steps.push(resolveCommand("workspace-script", { command: buildCmd, label: "yarn build" }));

  const lintCmd = scriptCommand(root, "lint");
  if (lintCmd) {
    steps.push(resolveCommand("workspace-script", { command: lintCmd, label: "yarn lint" }));
  } else {
    console.log("[pan] Priority remediation: skipping yarn lint (script not found).");
  }

  const typeCheckCmd = scriptCommand(root, "type-check") || scriptCommand(root, "typecheck");
  if (typeCheckCmd) {
    steps.push(resolveCommand("workspace-script", { command: typeCheckCmd, label: "yarn type-check" }));
  } else {
    console.log("[pan] Priority remediation: skipping yarn type-check (script not found).");
  }

  return steps;
}

function scriptCommand(root: Workspace | null, script: string) {
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

async function runBuildSequence(targets: Workspace[]): Promise<{ ok: boolean; failures: BuildFailure[]; ran: number }> {
  const failures: BuildFailure[] = [];
  let ran = 0;

  for (const ws of targets) {
    const script = selectBuildScript(ws);
    if (!script) {
      console.log(`[pan] ℹ no build script found for ${ws.isRoot ? "root workspace" : ws.name}, skipping.`);
      continue;
    }
    ran++;
    const commandInstance = resolveCommand("workspace-script", {
      command: workspaceScriptCommand(ws, script),
      label: `${ws.isRoot ? "root" : ws.name} ${script}`,
    });
    const res = await run(commandInstance.command, commandInstance.label);
    if (!res.ok) failures.push(toBuildFailure(ws, res));
  }

  if (ran === 0) {
  const fallbackCommand = resolveCommand("yb", { label: "yarn build (fallback)" });
  const fallback = await run(fallbackCommand.command, fallbackCommand.label);
    if (!fallback.ok) {
      const workspace = targets.find(w => w.isRoot) || null;
      return { ok: false, failures: [toBuildFailure(workspace, fallback)], ran: 1 };
    }
    return { ok: true, failures: [], ran: 1 };
  }

  return { ok: failures.length === 0, failures, ran };
}

async function runRemediations(blob: string, ctx: { targets: Workspace[]; allWorkspaces: Workspace[]; failures: BuildFailure[] }) {
  if (!blob.trim()) return;
  const lower = blob.toLowerCase();
  const executed = new Set<string>();

  if (/prisma|p100|client/.test(lower)) {
    const prismaGenerate = resolveCommand("prisma-generate");
    await run(prismaGenerate.command, prismaGenerate.label);
  }

  if (/tsbuildinfo|cannot find module|duplicate identifier|ts180/.test(lower)) {
    const workspaceClean = resolveCommand("ffyc", { label: "workspace cache clean" });
    await run(workspaceClean.command, workspaceClean.label);
  }

  if (/cache|yn000|integrity/.test(lower)) {
    const cacheClean = resolveCommand("ycc");
    await run(cacheClean.command, cacheClean.label);
  }

  if (/migrat/.test(lower)) {
    const migrateScripts = collectScripts(ctx.targets, ["migrate"], ctx.allWorkspaces);
    for (const entry of migrateScripts) {
      const cmd = workspaceScriptCommand(entry.workspace, entry.script);
      if (executed.has(cmd)) continue;
      executed.add(cmd);
      const commandInstance = resolveCommand("workspace-script", {
        command: cmd,
        label: `${entry.workspace.isRoot ? "root" : entry.workspace.name} ${entry.script}`,
      });
      await run(commandInstance.command, commandInstance.label);
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
    const commandInstance = resolveCommand("workspace-script", {
      command: cmd,
      label: `${entry.workspace.isRoot ? "root" : entry.workspace.name} ${entry.script}`,
    });
    await run(commandInstance.command, commandInstance.label);
  }
}

function selectBuildScript(ws: Workspace) {
  for (const candidate of buildScriptPreference) {
    if (hasScript(ws, candidate)) return candidate;
  }
  const buildCandidates = Object.keys(ws.scripts || {}).filter(s => /build|compile/.test(s));
  return buildCandidates[0];
}

function failureBlob(failures: BuildFailure[]) {
  return failures.map(f => `${f.result.stdout}\n${f.result.stderr}`).join("\n");
}

function describeRun(label: string, result: { ok: boolean; failures: BuildFailure[] }, targets: Workspace[]) {
  if (result.ok) {
    return `${label} succeeded for ${formatWorkspaceList(targets)}.`;
  }
  const failures = result.failures.map(failureLabel).join(", ") || formatWorkspaceList(targets);
  return `${label} failed for ${failures}.`;
}

function buildSuccessSummary(phase: string, targets: Workspace[], runCount: number) {
  const workspaceList = formatWorkspaceList(targets);
  return `${phase} succeeded after ${runCount} targeted run${runCount === 1 ? "" : "s"} covering ${workspaceList}.`;
}

function formatWorkspaceList(targets: Workspace[]) {
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

interface BranchStatusInfo {
  name: string;
  upstream?: string;
  ahead: number;
  behind: number;
  detached: boolean;
}

interface RebaseDiagnostics {
  branchStatus: BranchStatusInfo;
  head: string;
  rebaseInProgress: boolean;
  autoAborted: boolean;
}

async function explainRebaseFailure() {
  const diagnostics = await gatherRebaseDiagnostics();
  const { branchStatus, head, rebaseInProgress, autoAborted } = diagnostics;
  const branchLabel = branchStatus.name && branchStatus.name !== "(detached)" ? branchStatus.name : "your branch";
  const upstreamLabel = branchStatus.upstream || "its upstream";

  const lines: string[] = [
    "git rebase origin/master failed, so Pan paused automated remediation to avoid corrupting your branch history.",
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
    suggestions.push(`- Decide how to reconcile ${branchLabel} with ${upstream}. If you want the remote history, run \`git fetch origin && git reset --hard ${upstream}\`. If you need your local commits, create a backup branch and replay them after syncing with ${upstream}.`);
  } else {
    suggestions.push("- Reconcile your branch with the remote history, then rerun `pan fix`.");
  }

  suggestions.push("- After the branch history is settled, rerun `pan fix` to continue remediation.");

  return `${lines.join(" ")}\n${suggestions.join("\n")}`;
}

async function gatherRebaseDiagnostics(): Promise<RebaseDiagnostics> {
  const gitDir = process.env.GIT_DIR || ".git";
  const rebaseMerge = path.join(gitDir, "rebase-merge");
  const rebaseApply = path.join(gitDir, "rebase-apply");
  const rebaseInProgress = fs.existsSync(rebaseMerge) || fs.existsSync(rebaseApply);

  const statusCommand = resolveCommand("gsb", { label: "git status --short --branch" });
  const statusRes = await run(statusCommand.command, statusCommand.label, { silence: true });
  const branchStatus = parseBranchStatus(statusRes.ok ? statusRes.stdout : "");

  const headRes = await run("git rev-parse --short HEAD", "git rev-parse --short HEAD", { silence: true });
  const head = headRes.ok ? headRes.stdout.trim() : "";

  let autoAborted = false;
  if (rebaseInProgress) {
    const abortCommand = resolveCommand("grba");
    const abortRes = await run(abortCommand.command, abortCommand.label, { silence: true });
    if (abortRes.ok) {
      autoAborted = true;
      console.log("[pan] Priority remediation: auto-aborted git rebase to restore your worktree.");
      const postStatusCommand = resolveCommand("gsb", { label: "git status --short --branch (post-abort)" });
      const postStatus = await run(postStatusCommand.command, postStatusCommand.label, { silence: true });
      if (postStatus.ok) {
        const updated = parseBranchStatus(postStatus.stdout);
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

function parseBranchStatus(output: string): BranchStatusInfo {
  const info: BranchStatusInfo = { name: "", ahead: 0, behind: 0, detached: false };
  if (!output) return info;

  const lines = output.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return info;

  const header = lines[0].trim();
  if (!header.startsWith("##")) return info;

  let body = header.slice(2).trim();
  let bracketContent = "";
  const bracketIndex = body.indexOf(" [");
  if (bracketIndex !== -1 && body.endsWith("]")) {
    bracketContent = body.slice(bracketIndex + 2, -1);
    body = body.slice(0, bracketIndex).trim();
  }

  if (!body) return info;

  if (body.startsWith("HEAD")) {
    info.name = "HEAD";
    info.detached = body.includes("detached");
    return info;
  }

  const [branchPart, upstreamPart] = body.split("...");
  info.name = branchPart.trim();

  const upstream = upstreamPart?.trim();
  if (upstream && upstream !== "(no branch)") {
    info.upstream = upstream;
  }

  if (bracketContent) {
    for (const token of bracketContent.split(",")) {
      const text = token.trim();
      const aheadMatch = text.match(/^ahead (\d+)/);
      if (aheadMatch) {
        const value = Number.parseInt(aheadMatch[1], 10);
        if (Number.isFinite(value)) info.ahead = Math.max(value, 0);
        continue;
      }
      const behindMatch = text.match(/^behind (\d+)/);
      if (behindMatch) {
        const value = Number.parseInt(behindMatch[1], 10);
        if (Number.isFinite(value)) info.behind = Math.max(value, 0);
      }
    }
  }

  return info;
}

function collectScripts(targets: Workspace[], keywords: string[], all: Workspace[]) {
  const scripts: { workspace: Workspace; script: string }[] = [];
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
