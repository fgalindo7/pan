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

async function runPan(args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }) {
  return new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve, reject) => {
    const child = spawn(process.execPath, [TSX_CLI, CLI_ENTRY, ...args], {
      cwd: options.cwd,
      env: {
        ...process.env,
        ...options.env,
        NODE_ENV: options.env?.NODE_ENV ?? "test",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", chunk => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", chunk => {
      stderr += chunk.toString();
    });

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
    await writeFile(answersPath, `push:\n  branch:\n    prefix: feat\n    name: integration-smoke\n  commit:\n    firstLine: "test: integration smoke"\n    body: |
      ensure pan push works non-interactively\n`);

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
  }, 30_000);
});
