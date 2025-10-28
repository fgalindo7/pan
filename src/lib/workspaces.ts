import fs from "node:fs";
import path from "node:path";
import { run } from "./run.js";

export interface WorkspaceInfo {
  name: string;
  location: string;
  scripts: Record<string, string>;
  isRoot: boolean;
}

let cachedWorkspaces: WorkspaceInfo[] | null = null;

export async function listWorkspaces(): Promise<WorkspaceInfo[]> {
  if (cachedWorkspaces) return cachedWorkspaces;
  const workspaces: WorkspaceInfo[] = [];
  const rootPkgPath = path.resolve("package.json");
  const rootPkg = readPackageJson(rootPkgPath);
  workspaces.push({
    name: rootPkg?.name || "root",
    location: ".",
    scripts: rootPkg?.scripts || {},
    isRoot: true,
  });

  const res = await run("yarn workspaces list --json", "yarn workspaces list");
  if (res.ok && res.stdout) {
    const lines = res.stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (!parsed?.location || !parsed?.name) continue;
        const pkgPath = path.resolve(parsed.location, "package.json");
        const pkgJson = readPackageJson(pkgPath);
        workspaces.push({
          name: parsed.name,
          location: normalizePath(parsed.location),
          scripts: pkgJson?.scripts || {},
          isRoot: false,
        });
      } catch {
        continue;
      }
    }
  }

  cachedWorkspaces = workspaces.map(ws => ({ ...ws, location: normalizePath(ws.location) }));
  return cachedWorkspaces;
}

function readPackageJson(pkgPath: string) {
  try {
    const content = fs.readFileSync(pkgPath, "utf8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export async function changedFiles(): Promise<string[]> {
  const status = await run("git status --porcelain", "git status --porcelain", { silence: true });
  if (!status.ok) return [];
  const files: string[] = [];
  const lines = status.stdout.split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const body = line.slice(3);
    if (line.startsWith("R ") && body.includes(" -> ")) {
      const [from, to] = body.split(" -> ").map(s => normalizePath(s.trim()));
      if (from) files.push(from);
      if (to) files.push(to);
    } else if (body) {
      files.push(normalizePath(body.trim()));
    }
  }
  return [...new Set(files)];
}

export async function changedWorkspaces(): Promise<WorkspaceInfo[]> {
  const workspaces = await listWorkspaces();
  const files = await changedFiles();
  if (!files.length) return workspaces.filter(w => w.isRoot);
  const matches = new Set<WorkspaceInfo>();
  for (const file of files) {
    for (const ws of workspaces) {
      if (ws.isRoot) continue;
      const wsPrefix = ws.location.endsWith("/") ? ws.location : `${ws.location}/`;
      if (file.startsWith(wsPrefix)) {
        matches.add(ws);
      }
    }
  }
  if (!matches.size) {
    return workspaces.filter(w => w.isRoot);
  }
  const result = new Set<WorkspaceInfo>([...matches, ...workspaces.filter(w => w.isRoot)]);
  return Array.from(result);
}

export function hasScript(ws: WorkspaceInfo, script: string) {
  return Boolean(ws.scripts && Object.prototype.hasOwnProperty.call(ws.scripts, script));
}

export function findScriptsByKeywords(ws: WorkspaceInfo, keywords: string[]) {
  const scripts: string[] = [];
  for (const key of Object.keys(ws.scripts || {})) {
    const lower = key.toLowerCase();
    if (keywords.some(k => lower.includes(k.toLowerCase()))) scripts.push(key);
  }
  return scripts;
}

function normalizePath(p: string) {
  return p.replace(/\\/g, "/");
}

export function workspaceScriptCommand(ws: WorkspaceInfo, script: string) {
  if (ws.isRoot) return `yarn run ${shellQuote(script)}`;
  return `yarn workspace ${shellQuote(ws.name)} run ${shellQuote(script)}`;
}

function shellQuote(v: string) {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}
