import { Command } from "commander";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import * as fs from "node:fs";
import { run } from "./lib/run.js";
import { pushFlow } from "./lib/push.js";
import { consultChatGPT, logContextFromFile, resetChatGPTSession, getAssistantMode, requiresOpenAIKey, hasLocalAssistantCommand, localAssistantCommandLabel } from "./lib/chatgpt.js";
import { listWorkspaces, changedWorkspaces, changedFiles } from "./lib/workspaces.js";
import { currentBranch, worktreeClean } from "./lib/git.js";

const program = new Command();
program
  .name("pan")
  .description("Pan — the monorepo shepherd. From panic to push: fix, harmonize, and deliver.")
  .version("0.1.0");

program.command("help")
  .description("Detailed Pan usage guide")
  .action(() => {
    console.log(detailedHelp().trim());
  });

program.command("diagnose")
  .description("Quick health check (build/typecheck/lint)")
  .action(async () => {
    type RunResult = Awaited<ReturnType<typeof run>>;
    type StepResult = { name: string; label: string; result: RunResult };

    const pkg = readPackageInfo();
    const runner = detectRunner(pkg);
    const scripts = pkg.scripts || {};

    const { smartBuildFix } = await import("./lib/fix.js");
    console.log("[pan] Running smart remediation before diagnostics...");
    const fixResult = await smartBuildFix({ skipConsult: true, interactive: false, label: "diagnose" });
    console.log(`[pan] Smart remediation summary: ${fixResult.summary}`);
    if (fixResult.steps.length) {
      console.log(`[pan] Remediation steps: ${fixResult.steps.join(" → ")}`);
    }
    let exitCode = fixResult.ok ? 0 : 1;
    if (fixResult.blockedMessage) {
      console.log(`[pan] Smart remediation blocked: ${fixResult.blockedMessage}`);
      process.exitCode = 1;
      return;
    }

    const diagnoseConfigs: Array<{ name: string; description: string; candidates: string[] }> = [
      { name: "type-check", description: "type-check", candidates: ["type-check", "typecheck", "check", "tsc"] },
      { name: "lint", description: "lint", candidates: ["lint", "lint:ci", "lint:fix", "eslint"] },
      { name: "build", description: "build", candidates: ["build", "compile", "dist"] },
    ];

    const results: StepResult[] = [];
    const skipped: Array<{ description: string; reason: string }> = [];

    for (const cfg of diagnoseConfigs) {
      const scriptName = findScriptCandidate(scripts, cfg.candidates);
      if (!scriptName) {
        skipped.push({ description: cfg.description, reason: "no matching package script" });
        continue;
      }
      const cmd = commandForScript(runner, scriptName);
      const label = `${runnerLabel(runner)} ${scriptName}`.trim();
      const result = await run(cmd, cfg.name);
      results.push({ name: cfg.name, label, result });
    }

    for (const skip of skipped) {
      console.log(`[pan] Skipping ${skip.description} (${skip.reason}).`);
    }

    if (results.length === 0) {
      console.log("[pan] No diagnose scripts found. Define package scripts (e.g., type-check, lint, build) to enable diagnostics.");
      process.exitCode = exitCode;
      return;
    }

    const successes = results.filter((r) => r.result.ok);
    const failures = results.filter(isFailure);

    if (!failures.length) {
      console.log("[pan] All diagnose checks passed. No further action required.");
      process.exitCode = exitCode;
      return;
    }

    const successLabels = successes.map((s) => s.label);
    const failureLabels = failures.map((f) => f.label);
    const summary = buildSummary(successLabels, failureLabels);

    console.log(`[pan] ${summary}`);
    for (const failure of failures) {
      if (failure.result.logFile) {
        console.log(`[pan] ↳ ${failure.label} log: ${failure.result.logFile}`);
      }
    }
    console.log("[pan] Inspect the logs above (stored in .repo-doctor/) for raw stdout/stderr.");

    const chatSummaryLines = [
      "pan diagnose summary:",
      `Smart remediation: ${fixResult.summary}`,
      summary,
      "",
      "Failures:",
      ...failures.map((f) => `- ${f.label} (exit code ${f.result.code ?? "unknown"})`),
    ];
    if (successLabels.length) {
      chatSummaryLines.push("", `Successful checks: ${successLabels.join(", ")}`);
    }

    await consultChatGPT({
      summary: chatSummaryLines.join("\n"),
      question: "What additional remediation steps should Pan attempt to resolve the failing checks?",
      logs: failures.map((f) => logContextFromFile(f.label, f.result.logFile)),
    });
    exitCode = 1;
    process.exitCode = exitCode;
  });

program.command("fix")
  .description("Smart remediation for build failures")
  .action(async () => {
    const { smartBuildFix } = await import("./lib/fix.js");
    const result = await smartBuildFix();
    console.log(`[pan] ${result.summary}`);
    if (result.ok) {
      console.log("✅ Build fixed");
    } else {
      if (result.blockedMessage) {
        console.log(`[pan] ${result.blockedMessage}`);
      }
      console.log("⚠️ Build still failing (see .repo-doctor logs).");
      process.exitCode = 1;
    }
  });

program.command("prepush")
  .description("Run lint --fix, type-check, dirty-index-check")
  .action(async () => {
    const { runPrepushChecks } = await import("./lib/checks.js");
    const ok = await runPrepushChecks();
    if (!ok) process.exitCode = 1; else console.log("✅ Ready to push!");
  });

program.command("push")
  .description("Full policy flow: branch -> rebase -> fix -> checks -> commit -> push")
  .action(async () => {
    try { await pushFlow(); } catch (e: any) { console.error("❌", e?.message || e); process.exit(1); }
  });

program.command("chat")
  .description("Open a contextual assistant session with Pan (ChatGPT or local LLM)")
  .action(async () => {
    resetChatGPTSession();
    let mode = process.env.PAN_ASSISTANT_MODE as "openai" | "local" | undefined;
    if (!mode) {
      const choices = ["openai", "local"];
      const selection = (await promptLine(`[pan] Select assistant mode (${choices.join("/")}) [openai]: `)).trim().toLowerCase();
      if (selection === "local" || selection === "openai") mode = selection;
      else mode = getAssistantMode();
      process.env.PAN_ASSISTANT_MODE = mode;
    }
    const activeMode = mode ?? getAssistantMode();
    if (requiresOpenAIKey(activeMode)) {
      const apiKey = await ensureOpenAIKey();
      if (!apiKey) {
        console.log("[pan] Chat session cancelled — API key required.");
        process.exitCode = 1;
        return;
      }
    } else {
      if (!hasLocalAssistantCommand()) {
        const custom = (await promptLine("[pan] Enter local LLM command or press Enter to install Docker llama3: ")).trim();
        if (custom) {
          process.env.PAN_LOCAL_LLM_COMMAND = custom;
          process.env.PAN_LLM_COMMAND = custom;
        } else {
          const ok = await ensureDockerLlama3Setup();
          if (!ok) {
            console.log("[pan] Unable to prepare default llama3 Docker setup. Provide a custom command and retry.");
            process.exitCode = 1;
            return;
          }
        }
      }
      console.log(`[pan] Using local assistant command (${localAssistantCommandLabel()}).`);
    }

    const pkg = readPackageInfo();
    const branch = await currentBranch();
    const clean = await worktreeClean();
    const workspaces = await listWorkspaces();
    const changed = (await changedWorkspaces()).filter(ws => !ws.isRoot);
    const changedFilesList = await changedFiles();

    const workspaceSummary = workspaces.map(ws => `${ws.isRoot ? "(root)" : ws.name} → ${ws.location}`).join("\n  ");
    const changedSummary = changed.length
      ? changed.map(ws => `${ws.name} (${ws.location})`).join(", ")
      : "none";

    console.log("[pan] Gathering build state...");
    const logs = [];
    const hasChanges = changedFilesList.length > 0;
    const hasNodeModules = fs.existsSync("node_modules");
    const shouldOfferBuild = hasChanges || !hasNodeModules;
    let buildStatus = shouldOfferBuild ? "skipped" : "skipped (clean tree)";
    if (shouldOfferBuild) {
      const runBuild = await promptYesNo("[pan] Run `yarn build` now to capture current status? [Y/n] ", true);
      if (runBuild) {
        const buildResult = await run("yarn build", "chat build snapshot");
        buildStatus = buildResult.ok ? "yarn build succeeded" : `yarn build failed (exit ${buildResult.code ?? "unknown"})`;
        if (buildResult.logFile) logs.push(logContextFromFile("yarn build", buildResult.logFile));
      }
    } else {
      console.log("[pan] Build snapshot skipped (clean worktree with dependencies present).");
    }

    const gitStatus = await run("git status --short", "chat git status", { silence: true });
    if (gitStatus.logFile) logs.push(logContextFromFile("git status --short", gitStatus.logFile));

    const summaryLines = [
      `Project: ${pkg.name ?? "unknown"}${pkg.version ? `@${pkg.version}` : ""}`,
      `Branch: ${branch || "unknown"} (${clean ? "clean worktree" : "dirty worktree"})`,
      `Changed files: ${changedFilesList.length}`,
      `Changed workspaces: ${changedSummary}`,
      `Build state: ${buildStatus}`,
      "",
      "Workspaces:",
      `  ${workspaceSummary || "n/a"}`,
      "",
      "Recent git status:",
      gitStatus.stdout ? indent(gitStatus.stdout.trim(), 2) : "  (no changes)",
    ];
    const summary = summaryLines.join("\n");
    console.log(summary);

    const promptLabel = activeMode === "openai"
      ? "[you] What would you like to ask ChatGPT? (enter for default) "
      : "[you] What would you like to ask the assistant? (enter for default) ";
    const userQuestion = (await promptLine(promptLabel)).trim()
      || "Help me plan the next steps for this workspace.";

    await consultChatGPT({
      summary,
      question: userQuestion,
      logs,
    });
  });

program.parseAsync();

function isFailure(step: { result: Awaited<ReturnType<typeof run>> }): step is { result: Extract<Awaited<ReturnType<typeof run>>, { ok: false }> } {
  return !step.result.ok;
}

function buildSummary(successes: string[], failures: string[]) {
  const parts: string[] = [];
  if (successes.length) parts.push(`Pan made it through ${formatList(successes)}.`);
  if (failures.length) parts.push(`But ${formatList(failures)} exited non-zero, so pan diagnose stopped there.`);
  parts.push("See the captured logs for details.");
  return parts.join(" ");
}

function formatList(items: string[]) {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

type ScriptRunner = "yarn" | "pnpm" | "npm" | "bun";

type PackageInfo = {
  name?: string;
  version?: string;
  scripts?: Record<string, string>;
  packageManager?: string;
};

function detectRunner(pkg: { packageManager?: string } = {}): ScriptRunner {
  const pm = pkg.packageManager || "";
  if (pm.startsWith("yarn")) return "yarn";
  if (pm.startsWith("pnpm")) return "pnpm";
  if (pm.startsWith("bun")) return "bun";
  if (pm.startsWith("npm")) return "npm";
  if (fs.existsSync("yarn.lock")) return "yarn";
  if (fs.existsSync("pnpm-lock.yaml")) return "pnpm";
  if (fs.existsSync("bun.lockb")) return "bun";
  if (fs.existsSync("package-lock.json")) return "npm";
  return "npm";
}

function commandForScript(runner: ScriptRunner, script: string) {
  switch (runner) {
    case "yarn":
      return `yarn ${script}`;
    case "pnpm":
      return `pnpm run ${script}`;
    case "bun":
      return `bun run ${script}`;
    case "npm":
    default:
      return `npm run ${script}`;
  }
}

function runnerLabel(runner: ScriptRunner) {
  switch (runner) {
    case "yarn":
      return "yarn";
    case "pnpm":
      return "pnpm run";
    case "bun":
      return "bun run";
    case "npm":
    default:
      return "npm run";
  }
}

function findScriptCandidate(scripts: Record<string, string>, candidates: string[]) {
  for (const name of candidates) {
    if (Object.prototype.hasOwnProperty.call(scripts, name)) return name;
  }
  return "";
}

function detailedHelp() {
  return `
Pan Command Guide
-----------------

pan help
  Show this guide.

pan diagnose
  Run yarn type-check, yarn lint, and yarn build to surface issues.
  Summarizes successes/failures and points to .repo-doctor logs.

pan fix
  Attempt smart remediation (targeted workspace builds, Prisma/generator runs,
  cache cleans, migrate/fix scripts, Docker hook, yarn install).

pan prepush
  Perform lint --fix, type-check, targeted tests, and dirty-index validation.

pan push
  Handle feature branch enforcement, stash + rebase, smart build fix, pre-push
  checks, commit prompt, dirty-index policing, and push to origin.

pan chat
  Provide project/repo/build context, run optional yarn build snapshot, prompt
  for an OpenAI API key if missing (in ChatGPT mode), or leverage a local LLM
  command, and open a collaborative assistant chat. The assistant can suggest
  commands, which Pan executes and reports back, while you
  can jump in with additional instructions at each round.

Environment knobs
  PAN_OPENAI_API_KEY / OPENAI_API_KEY   ChatGPT credentials (required for remote AI)
	  PAN_CHATGPT_ENABLED                   Disable/enable chat escalation (default 1)
	  PAN_CHATGPT_CONFIRM                   Toggle confirmation prompts (default 1)
	  PAN_CHATGPT_MODEL / BASE_URL          Override ChatGPT model or API host
	  PAN_CHATGPT_TIMEOUT_MS                Adjust ChatGPT request timeout
  PAN_CHATGPT_MAX_TOKENS                Cap ChatGPT reply length
  PAN_CHATGPT_MAX_ROUNDS                Max chat rounds per session (default 3)
  PAN_ASSISTANT_MODE                    "openai" (default) or "local" for shell LLMs
  PAN_LOCAL_LLM_COMMAND / PAN_LLM_COMMAND / LLM_COMMAND
                                        Command Pan runs for local LLM chats
	  PAN_DOCKER_DEV_CMD                    Custom command for Docker remediation
	  PAN_CHATGPT_ENABLED=0                 Fully disable remote chat integration

Logs
  All command stdout/stderr is captured under .repo-doctor/.
  Use pan diagnose/fix/push/chat outputs to locate the exact log files.
`;
}

async function ensureOpenAIKey() {
  const existing = process.env.PAN_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  if (existing && existing.trim()) return existing.trim();
  console.log("[pan] No OpenAI API key detected (set PAN_OPENAI_API_KEY or OPENAI_API_KEY).");
  console.log("[pan] You can create/manage API keys at https://platform.openai.com/account/api-keys");
  const key = (await promptLine("[pan] Enter your OpenAI API key (leave blank to cancel): ")).trim();
  if (!key) return "";
  process.env.PAN_OPENAI_API_KEY = key;
  process.env.OPENAI_API_KEY = key;
  return key;
}

async function ensureDockerLlama3Setup() {
  const image = process.env.PAN_LLAMA_DOCKER_IMAGE || "ollama/ollama:latest";
  const container = process.env.PAN_LLAMA_DOCKER_CONTAINER || "pan-llama3";
  const model = process.env.PAN_LLAMA_MODEL || "llama3";
  const command = `docker exec -i ${container} ollama run ${model}`;

  console.log(`[pan] Setting up Docker-based ${model} using image ${image} (container ${container}).`);
  const pull = await run(`docker pull ${image}`, `docker pull ${image}`);
  if (!pull.ok) {
    console.log("[pan] Failed to pull Docker image. Ensure Docker is running and you have network access.");
    return false;
  }

  const inspect = await run(`docker inspect ${container}`, `docker inspect ${container}`, { silence: true });
  if (!inspect.ok) {
    const runContainer = await run(`docker run -d --name ${container} -p 11434:11434 ${image}`, `docker run ${container}`);
    if (!runContainer.ok) {
      console.log("[pan] Failed to start Docker container.");
      return false;
    }
  } else {
    const start = await run(`docker start ${container}`, `docker start ${container}`, { silence: true });
    if (!start.ok) {
      console.log("[pan] Failed to start existing Docker container.");
      return false;
    }
  }

  await new Promise(resolve => setTimeout(resolve, 3000));

  const pullModel = await run(`docker exec -i ${container} ollama pull ${model}`, `docker exec ${container} ollama pull ${model}`);
  if (!pullModel.ok) {
    console.log("[pan] Failed to pull llama3 model inside the container.");
    return false;
  }

  process.env.PAN_LOCAL_LLM_COMMAND = command;
  process.env.PAN_LLM_COMMAND = command;
  console.log(`[pan] Default llama3 ready. Pan will use: ${command}`);
  return true;
}

function readPackageInfo(): PackageInfo {
  try {
    const raw = fs.readFileSync("package.json", "utf8");
    return JSON.parse(raw) as PackageInfo;
  } catch {
    return {} as PackageInfo;
  }
}

async function promptLine(question: string) {
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(question);
    return answer;
  } finally {
    rl.close();
  }
}

async function promptYesNo(question: string, defaultYes: boolean) {
  const answer = (await promptLine(question)).trim().toLowerCase();
  if (!answer) return defaultYes;
  if (["y", "yes"].includes(answer)) return true;
  if (["n", "no"].includes(answer)) return false;
  return defaultYes;
}

function indent(text: string, spaces = 2) {
  const pad = " ".repeat(spaces);
  return text.split("\n").map(line => (line.length ? pad + line : line)).join("\n");
}
