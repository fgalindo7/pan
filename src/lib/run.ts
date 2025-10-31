
import { ShellCommandExecutor } from "../infrastructure/ShellCommandExecutor.js";
import { LoggingService } from "../infrastructure/LoggingService.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveCommand, type CommandAlias, type CommandContext } from "./commands.js";
import { recordCommandFailure } from "./errors.js";

/**
 * Shell execution + logging for Pan.
 */

const LOG_DIR = ".repo-doctor";
const shellExecutor = new ShellCommandExecutor();
const loggingService = new LoggingService();
export interface CommandRecord {
  command: string;
  label: string;
  ok: boolean;
  exitCode: number;
  durationMs: number;
  timestamp: number;
}

type Recorder = (entry: CommandRecord) => void;

const commandRecorders: Recorder[] = [];

export function addCommandRecorder(recorder: Recorder) {
  commandRecorders.push(recorder);
  return () => {
    const idx = commandRecorders.indexOf(recorder);
    if (idx !== -1) commandRecorders.splice(idx, 1);
  };
}

function notifyRecorders(entry: CommandRecord) {
  for (const recorder of commandRecorders) {
    try {
      recorder(entry);
    } catch {
      // ignore recorder errors
    }
  }
}

export function summarizeSuccessfulCommands(commands: CommandRecord[]) {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const entry of commands) {
    if (!entry.ok) continue;
    const descriptor = entry.label === entry.command ? entry.label : `${entry.label} (${entry.command})`;
    const key = `${entry.label}|${entry.command}|${entry.ok}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(descriptor);
  }
  return lines;
}


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
  if (!options.silence) loggingService.log(`[pan] ▶ ${name}`);
  try {
    const result = await shellExecutor.run(cmd, { cwd: options.cwd, env: options.env });
    const ms = Date.now() - start;
    if (!options.silence) loggingService.log(`[pan] ${result.code === 0 ? "✅" : "❌"} ${name} (${ms}ms)`);
    const logFile = log(name, result.code, result.stdout, result.stderr, ms);
    notifyRecorders({ command: cmd, label: name, ok: result.code === 0, exitCode: result.code, durationMs: ms, timestamp: Date.now() });
    if (result.code === 0) {
      return { ok: true, stdout: result.stdout.trim(), stderr: result.stderr.trim(), logFile } as const;
    } else {
      recordCommandFailure({
        command: cmd,
        label: name,
        stdout: result.stdout,
        stderr: result.stderr,
        logFile,
        exitCode: result.code,
      });
      return { ok: false, stdout: result.stdout, stderr: result.stderr, code: result.code, logFile } as const;
    }
  } catch (e: any) {
    const out = e?.stdout?.toString?.() ?? "";
    const err = e?.stderr?.toString?.() ?? e?.message ?? "";
    const ms = Date.now() - start;
    loggingService.error(`[pan] ❌ ${name} (${ms}ms)`);
    const logFile = log(name, e?.code ?? 1, out, err, ms);
    notifyRecorders({ command: cmd, label: name, ok: false, exitCode: e?.code ?? 1, durationMs: ms, timestamp: Date.now() });
    recordCommandFailure({
      command: cmd,
      label: name,
      stdout: out,
      stderr: err,
      logFile,
      exitCode: e?.code ?? 1,
    });
    return { ok: false, stdout: out, stderr: err, code: e?.code ?? 1, logFile } as const;
  }
}

export async function runCommand(
  alias: CommandAlias,
  context: CommandContext = {},
  options: RunOptions = {}
) {
  const instance = resolveCommand(alias, context);
  return run(instance.command, instance.label, options);
}

function log(step: string, code: number, out: string, err: string, ms: number) {
  ensureDir();
  const sanitized = step.replace(/[^a-z0-9._-]/gi, "-");
  const truncated = sanitized.length > 80 ? sanitized.slice(0, 80) : sanitized;
  const slug = truncated || "step";
  const f = path.join(LOG_DIR, `${Date.now()}-${slug}.log`);
  fs.writeFileSync(f, `# ${step}\ncode:${code}\nms:${ms}\n\n## out\n${out}\n\n## err\n${err}\n`, "utf8");
  return f;
}
