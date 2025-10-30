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

interface RunPanOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  inputLines?: string[];
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

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", chunk => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", chunk => {
      stderr += chunk.toString();
    });

    if (options.inputLines && options.inputLines.length > 0 && child.stdin) {
      const baseDelay = 500;
      let delay = baseDelay;
      for (const line of options.inputLines) {
        const value = `${line}\n`;
        setTimeout(() => {
          if (!child.stdin || !child.stdin.writable) return;
          child.stdin.write(value);
        }, delay);
        delay += 200;
      }
      setTimeout(() => {
        if (!child.stdin || child.stdin.destroyed || child.stdin.writableEnded) return;
        child.stdin.end();
      }, delay + 200);
    } else {
      child.stdin?.end();
    }

    child.on("error", error => reject(error));
    child.on("close", exitCode => {
      resolve({ stdout, stderr, exitCode: exitCode ?? 0 });
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
      inputLines: ["feat", "prompted-branch"],
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
