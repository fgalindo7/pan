import os from "node:os";
import path from "node:path";
import * as fs from "node:fs/promises";
import { listToolkitCommands, type CommandInstance } from "./commands.js";

export interface ToolkitAlias {
  alias: string;
  command: string;
  description: string;
}

function getToolkitAliases(): ToolkitAlias[] {
  return listToolkitCommands().map((entry: CommandInstance) => ({
    alias: entry.alias,
    command: entry.command,
    description: entry.description,
  }));
}

const SENTINEL_BEGIN = "# >>> pan toolkit aliases >>>";
const SENTINEL_END = "# <<< pan toolkit aliases <<<";

export function formatToolkitListing(): string {
  const aliases = getToolkitAliases();
  const rows = aliases.map(entry => `  ${entry.alias.padEnd(10)} → ${entry.command} (${entry.description})`);
  return [
    "Pan Remediation Toolkit",
    "------------------------",
    ...rows,
  ].join("\n");
}

export function generateToolkitSnippet(): string {
  const body = getToolkitAliases()
    .map(entry => `alias ${entry.alias}='${entry.command.replace(/'/g, "'\\''")}'`)
    .join("\n");
  return [
    SENTINEL_BEGIN,
    "# Drop this block into your shell profile (e.g. ~/.zshrc) to enable Pan toolkit aliases.",
    body,
    SENTINEL_END,
    "",
  ].join("\n");
}

export interface InstallResult {
  profilePath: string;
  status: "installed" | "skipped";
  reason?: string;
}

export async function installToolkitAliases(profilePath?: string): Promise<InstallResult> {
  const resolvedProfile = profilePath ? resolveProfilePath(profilePath) : resolveDefaultProfile();
  if (!resolvedProfile) {
    return { profilePath: "", status: "skipped", reason: "no-profile" };
  }

  const snippet = generateToolkitSnippet();
  let existing = "";
  try {
    existing = await fs.readFile(resolvedProfile, "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") {
      await fs.mkdir(path.dirname(resolvedProfile), { recursive: true });
      existing = "";
    } else {
      throw error;
    }
  }

  if (existing.includes(SENTINEL_BEGIN)) {
    return { profilePath: resolvedProfile, status: "skipped", reason: "already-installed" };
  }

  const content = existing.endsWith("\n") ? existing + snippet : existing + "\n" + snippet;
  await fs.writeFile(resolvedProfile, content, "utf8");
  return { profilePath: resolvedProfile, status: "installed" };
}

export function resolveDefaultProfile(): string | null {
  const shell = process.env.SHELL || "";
  const home = os.homedir();
  if (!home) return null;
  if (shell.includes("zsh")) return path.join(home, ".zshrc");
  if (shell.includes("bash")) return path.join(home, ".bashrc");
  return path.join(home, ".profile");
}

function resolveProfilePath(input: string) {
  const expanded = expandHome(input);
  return path.resolve(expanded);
}

function expandHome(p: string) {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}
