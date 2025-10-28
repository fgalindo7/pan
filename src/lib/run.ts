import { exec as _exec } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as path from "node:path";
export const execp = promisify(_exec);

/**
 * Shell execution + logging for Pan.
 */
const LOG_DIR = ".repo-doctor";

interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  silence?: boolean;
}

function ensureDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

export async function run(cmd: string, name = cmd, options: RunOptions = {}) {
  ensureDir();
  const start = Date.now();
  if (!options.silence) console.log(`[pan] ▶ ${name}`);
  try {
    const { stdout, stderr } = await execp(cmd, { shell: "/bin/zsh", cwd: options.cwd, env: options.env });
    const ms = Date.now() - start;
    if (!options.silence) console.log(`[pan] ✅ ${name} (${ms}ms)`);
    const logFile = log(name, 0, stdout, stderr, ms);
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim(), logFile } as const;
  } catch (e: any) {
    const out = e?.stdout?.toString?.() ?? "";
    const err = e?.stderr?.toString?.() ?? e?.message ?? "";
    const ms = Date.now() - start;
    if (!options.silence) console.log(`[pan] ❌ ${name} (${ms}ms)`);
    const logFile = log(name, e?.code ?? 1, out, err, ms);
    return { ok: false, stdout: out, stderr: err, code: e?.code ?? 1, logFile } as const;
  }
}

function log(step: string, code: number, out: string, err: string, ms: number) {
  ensureDir();
  const f = path.join(LOG_DIR, `${Date.now()}-${step.replace(/[^a-z0-9._-]/gi, "-")}.log`);
  fs.writeFileSync(f, `# ${step}\ncode:${code}\nms:${ms}\n\n## out\n${out}\n\n## err\n${err}\n`, "utf8");
  return f;
}
