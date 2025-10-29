import path from "node:path";
import pc from "picocolors";

interface CommandFailure {
  command: string;
  label: string;
  stdout: string;
  stderr: string;
  logFile?: string;
  exitCode: number;
}

let lastFailure: CommandFailure | null = null;
let verboseLogging = false;

export function setVerboseLogging(enabled: boolean) {
  verboseLogging = enabled;
}

export function isVerboseLoggingEnabled() {
  return verboseLogging;
}

export function clearLastCommandFailure() {
  lastFailure = null;
}

export function getLastCommandFailure() {
  return lastFailure;
}

export function recordCommandFailure(details: CommandFailure) {
  lastFailure = details;

  if (verboseLogging) {
    printFailure(details, { full: true, includeTip: false });
  }
}

export function printLastFailureSummary(options: { reason?: string } = {}) {
  if (!lastFailure) return;
  const { reason } = options;
  printFailure(lastFailure, { heading: reason, full: false, includeTip: !verboseLogging });
}

function printFailure(details: CommandFailure, opts: { heading?: string; full: boolean; includeTip: boolean }) {
  const { heading, full, includeTip } = opts;
  const body = chooseBody(details.stdout, details.stderr);
  const snippet = full ? body : limitBody(body);
  const lines: string[] = [];

  const headingLine = heading
    ? `${heading} (${details.label}, exit code ${details.exitCode})`
    : `${details.label} failed (exit code ${details.exitCode})`;
  lines.push(pc.red(`[pan] ${headingLine}`));

  if (snippet) {
    lines.push(pc.red(indent(snippet.trim(), 2)));
  } else {
    lines.push(pc.red("  (no stderr/stdout captured)"));
  }

  if (details.logFile) {
    const relative = path.relative(process.cwd(), details.logFile);
    lines.push(`[pan] 🔍 View full log: less ${quote(relative)}`);
  }

  if (includeTip) {
    lines.push("[pan] Tip: rerun with --verbose to see each failure as it happens.");
  }

  for (const line of lines) {
    console.log(line);
  }
}

function chooseBody(stdout: string, stderr: string) {
  const candidate = stderr?.trim() ? stderr : stdout;
  return candidate?.trim() ?? "";
}

function limitBody(text: string, maxLines = 10, maxChars = 800) {
  if (!text) return "";
  const lines = text.split(/\r?\n/);
  let truncated = false;
  let limited = lines.slice(0, maxLines);
  if (lines.length > maxLines) truncated = true;

  let snippet = limited.join("\n");
  if (snippet.length > maxChars) {
    snippet = snippet.slice(0, maxChars);
    truncated = true;
  }

  snippet = snippet.replace(/\s+$/u, "");

  if (truncated) {
    snippet += "\n…";
  }

  return snippet;
}

function indent(text: string, spaces = 2) {
  const pad = " ".repeat(spaces);
  return text
    .split("\n")
    .map(line => (line.length ? pad + line : line))
    .join("\n");
}

function quote(value: string) {
  if (!value.includes(" ")) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
