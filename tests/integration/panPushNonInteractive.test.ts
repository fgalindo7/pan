import { describe, expect, it } from "vitest";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRepoFixture } from "../support/repoFixture";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "../../");
const TSX_CLI = path.join(ROOT_DIR, "node_modules", "tsx", "dist", "cli.cjs");
const CLI_ENTRY = path.join(ROOT_DIR, "src", "cli.ts");

interface PromptStep {
  match: string | RegExp;
  reply: string;
}

interface RunPanOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  prompts?: PromptStep[];
  promptTimeoutMs?: number;
}

async function runPan(args: string[], options: RunPanOptions) {
  return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
    const child = spawn(process.execPath, [TSX_CLI, CLI_ENTRY, ...args], {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...options.env,
        NODE_ENV: options.env?.NODE_ENV ?? "test",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let settled = false;
    const finalize = (err?: Error, result?: { stdout: string; stderr: string; exitCode: number }) => {
      if (settled) return;
      settled = true;
      for (const timer of timers) clearTimeout(timer);
      if (err) {
        reject(err);
      } else if (result) {
        resolve(result);
      }
    };

    let stdout = "";
    let stderr = "";
    const prompts = (options.prompts ?? []).map(step => ({
      match: step.match,
      reply: step.reply,
      satisfied: false,
    }));
    const timers: NodeJS.Timeout[] = [];
    const timeoutMs = options.promptTimeoutMs ?? 10_000;

    const trySendReply = () => {
      if (!child.stdin || !child.stdin.writable) return;
      for (const step of prompts) {
        if (!step.satisfied) return;
      }
      child.stdin.end();
    };

    const watchPrompt = (step: { match: string | RegExp; reply: string; satisfied: boolean }, text: string) => {
      if (step.satisfied) return;
      const matched = typeof step.match === "string" ? text.includes(step.match) : step.match.test(text);
      if (!matched) return;
      if (typeof step.match !== "string" && step.match instanceof RegExp) {
        step.match.lastIndex = 0;
      }
      if (!child.stdin || !child.stdin.writable) return;
      child.stdin.write(`${step.reply}\n`);
      step.satisfied = true;
      trySendReply();
    };

    if (prompts.length) {
      for (const step of prompts) {
        timers.push(
          setTimeout(() => {
            if (step.satisfied || settled) return;
            finalize(new Error(`Prompt not satisfied within timeout: ${typeof step.match === "string" ? step.match : step.match.toString()}`));
          }, timeoutMs)
        );
      }
    } else {
      child.stdin?.end();
    }

    child.stdout?.on("data", chunk => {
      const text = chunk.toString();
      stdout += text;
      if (prompts.length) {
        for (const step of prompts) {
          watchPrompt(step, stdout);
        }
      }
    });
    child.stderr?.on("data", chunk => {
      stderr += chunk.toString();
    });

    child.on("error", error => finalize(error));
    child.on("close", exitCode => {
      if (prompts.length) {
        const unsatisfied = prompts.filter(step => !step.satisfied);
        if (unsatisfied.length) {
          finalize(new Error(`Process exited before prompts were satisfied: ${unsatisfied
            .map(step => (typeof step.match === "string" ? step.match : step.match.toString()))
            .join(", \n")}
stdout:\n${stdout}\nstderr:\n${stderr}`));
          return;
        }
      }
      finalize(undefined, { stdout, stderr, exitCode: exitCode ?? 0 });
    });
  });
}

describe("pan push integration", () => {
  it("runs pan push non-interactively using answers file", async () => {
    const fixture = await createRepoFixture({
      packageScripts: {
        build: "node scripts/ok.js build",
        lint: "node scripts/ok.js lint",
        "type-check": "node scripts/ok.js type-check",
        "dirty-index-check": "node scripts/ok.js dirty-index-check",
      },
    });

    await fixture.writeFiles({
      "scripts/ok.js": `#!/usr/bin/env node\nprocess.exit(0);\n`,
      "notes.md": "# Integration test\n",
    });

    const answersPath = fixture.path("pan-push.answers.yaml");
    await writeFile(answersPath, `push:\n  branch:\n    prefix: feat\n    name: integration-smoke\n  commit:\n    firstLine: "test: integration smoke"\n    body: |\n      ensure pan push works non-interactively\n`);

    const result = await runPan([
      "push",
      "--answers",
      answersPath,
    ], {
      cwd: fixture.dir,
      env: {
        USER: "fixture",
        PAN_CHATGPT_ENABLED: "0",
        PAN_CHATGPT_CONFIRM: "0",
        PAN_ASSISTANT_MODE: "openai",
      },
    });

    expect(result.exitCode, `stdout:\n${result.stdout}\n\nstderr:\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("✅ Pushed fixture/feat/integration-smoke");

    const status = await fixture.git("status --short --branch");
    expect(status.stdout).toMatch(/## fixture\/feat\/integration-smoke/);

    const remoteRef = await fixture.remoteGit("show-ref refs/heads/fixture/feat/integration-smoke");
    expect(remoteRef.code).toBe(0);
  });

  it("prompts for branch and commit when answers are missing", async () => {
    const fixture = await createRepoFixture({
      packageScripts: {
        build: "node scripts/ok.js build",
        lint: "node scripts/ok.js lint",
        "type-check": "node scripts/ok.js type-check",
        "dirty-index-check": "node scripts/ok.js dirty-index-check",
      },
    });

    await fixture.writeFiles({
      "scripts/ok.js": `#!/usr/bin/env node\nprocess.exit(0);\n`,
      "notes.md": "# Integration test\n",
    });

    const result = await runPan(["push"], {
      cwd: fixture.dir,
      env: {
        USER: "fixture",
        PAN_CHATGPT_ENABLED: "0",
        PAN_CHATGPT_CONFIRM: "0",
        PAN_ASSISTANT_MODE: "openai",
        PAN_COMMIT_MESSAGE_TEXT: "test: prompted commit\n\nBody from integration test",
      },
      prompts: [
        { match: "Branch type", reply: "feat" },
        { match: "Short branch message", reply: "prompted-branch" },
      ],
    });

    expect(result.exitCode, `stdout:\n${result.stdout}\n\nstderr:\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("Created fixture/feat/prompted-branch");
    expect(result.stdout).toContain("✅ Pushed fixture/feat/prompted-branch");

    const status = await fixture.git("status --short --branch");
    expect(status.stdout).toMatch(/## fixture\/feat\/prompted-branch/);

    const remoteRef = await fixture.remoteGit("show-ref refs/heads/fixture/feat/prompted-branch");
    expect(remoteRef.code).toBe(0);
  }, 30_000);
});
