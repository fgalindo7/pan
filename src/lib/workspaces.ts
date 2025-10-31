import fs from "node:fs";
import path from "node:path";
import { Workspace } from "../domain/Workspace.js";
import { runCommand } from "./run.js";

let cachedWorkspaces: Workspace[] | null = null;

export async function listWorkspaces(): Promise<Workspace[]> {
  if (cachedWorkspaces) return cachedWorkspaces;

  const workspaces: Workspace[] = [];
  const rootPkgPath = path.resolve("package.json");
  const rootPkg = readPackageJson(rootPkgPath);
  workspaces.push(
    Workspace.create({
      name: rootPkg?.name || "root",
      location: ".",
      scripts: rootPkg?.scripts || {},
      isRoot: true,
    })
  );

  const res = await runCommand("ywls");
  if (res.ok && res.stdout) {
    const lines = res.stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (!parsed?.location || !parsed?.name) continue;
        const pkgPath = path.resolve(parsed.location, "package.json");
        const pkgJson = readPackageJson(pkgPath);
        workspaces.push(
          Workspace.create({
            name: parsed.name,
            location: parsed.location,
            scripts: pkgJson?.scripts || {},
            isRoot: false,
          })
        );
      } catch {
        continue;
      }
    }
  }

  cachedWorkspaces = workspaces.map(ws => Workspace.create(ws.toJSON()));
  return cachedWorkspaces;
}

export function clearWorkspaceCache() {
  cachedWorkspaces = null;
}

export async function changedFiles(): Promise<string[]> {
  const status = await runCommand("gss", { label: "git status --short" }, { silence: true });
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

export async function changedWorkspaces(): Promise<Workspace[]> {
  const workspaces = await listWorkspaces();
  const files = await changedFiles();
  if (!files.length) return workspaces.filter(w => w.isRoot);
  const matches = new Set<Workspace>();
  for (const file of files) {
    for (const ws of workspaces) {
      if (!ws.isRoot && ws.ownsFile(file)) {
        matches.add(ws);
      }
    }
  }
  if (!matches.size) {
    return workspaces.filter(w => w.isRoot);
  }
  const result = new Set<Workspace>([...matches, ...workspaces.filter(w => w.isRoot)]);
  return Array.from(result);
}

export function hasScript(ws: Workspace, script: string) {
  return ws.hasScript(script);
}

export function findScriptsByKeywords(ws: Workspace, keywords: string[]) {
  return ws.listScriptsMatching(script => {
    const lower = script.toLowerCase();
    return keywords.some(k => lower.includes(k.toLowerCase()));
  });
}

export function workspaceScriptCommand(ws: Workspace, script: string) {
  if (ws.isRoot) return `yarn run ${shellQuote(script)}`;
  return `yarn workspace ${shellQuote(ws.name)} run ${shellQuote(script)}`;
}

function readPackageJson(pkgPath: string) {
  try {
    const content = fs.readFileSync(pkgPath, "utf8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

function normalizePath(p: string) {
  return p.replace(/\\/g, "/");
}

function shellQuote(v: string) {
  return `'${v.replace(/'/g, `'\\''`)}'`;
}
