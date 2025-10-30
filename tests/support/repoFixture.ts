import { mkdir, writeFile, readFile as readFileFs } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { exec as execCallback } from "node:child_process";
import { createTempDir } from "./tempfs";

const exec = promisify(execCallback);

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface RepoFixtureOptions {
  /**
   * Files written into the working tree before the initial commit.
   */
  files?: Record<string, string>;
  /**
   * Optional package.json scripts convenience shortcut.
   * When provided, the generated package.json will include these scripts.
   */
  packageScripts?: Record<string, string>;
  /**
   * Optional custom package.json contents. When omitted a minimal package.json is created.
   */
  packageJson?: Record<string, unknown>;
  /**
   * Name of the default branch. Defaults to "main".
   */
  defaultBranch?: string;
  /**
   * Commit message used for the initial snapshot.
   */
  initialCommitMessage?: string;
}

export interface RepoFixture {
  /** Absolute path to the working tree. */
  dir: string;
  /** Absolute path to the bare remote repository Pan will push to. */
  remoteDir: string;
  /** Default branch configured for the repository. */
  defaultBranch: string;
  /** Run an arbitrary shell command inside the working tree. */
  run(command: string, options?: { env?: NodeJS.ProcessEnv }): Promise<ExecResult>;
  /** Run a git subcommand inside the working tree. */
  git(args: string, options?: { env?: NodeJS.ProcessEnv }): Promise<ExecResult>;
  /** Write or overwrite files relative to the working tree root. */
  writeFiles(files: Record<string, string>): Promise<void>;
  /** Read a file relative to the working tree root (UTF-8). */
  readFile(filePath: string): Promise<string>;
  /** Create a commit, optionally writing additional files before committing. */
  commit(message: string, files?: Record<string, string>): Promise<void>;
  /** Push the current HEAD to the configured origin remote. */
  push(ref?: string): Promise<ExecResult>;
  /** Run a git subcommand inside the bare remote (useful for assertions). */
  remoteGit(args: string): Promise<ExecResult>;
  /** Resolve an absolute path inside the working tree. */
  path(relativePath: string): string;
}

export async function createRepoFixture(options: RepoFixtureOptions = {}): Promise<RepoFixture> {
  const defaultBranch = options.defaultBranch ?? "main";
  const dir = await createTempDir("pan-repo-");
  const remoteDir = await createTempDir("pan-remote-");

  await exec("git init --bare", { cwd: remoteDir });
  await exec("git init", { cwd: dir });
  await exec(`git checkout -b ${defaultBranch}`, { cwd: dir });
  await exec("git config user.name \"Pan Fixture\"", { cwd: dir });
  await exec("git config user.email \"fixture@example.com\"", { cwd: dir });

  const initialFiles = await buildInitialFiles(options);
  await writeFiles(dir, initialFiles);

  await exec("git add .", { cwd: dir });
  const commitMessage = options.initialCommitMessage ?? "chore: initial fixture";
  await exec(`git commit -m ${JSON.stringify(commitMessage)}`, { cwd: dir });

  await exec(`git remote add origin ${JSON.stringify(remoteDir)}`, { cwd: dir });
  await exec(`git push -u origin ${defaultBranch}`, { cwd: dir });

  async function run(command: string, opts: { env?: NodeJS.ProcessEnv } = {}): Promise<ExecResult> {
    try {
      const { stdout, stderr } = await exec(command, { cwd: dir, env: { ...process.env, ...opts.env } });
      return { stdout, stderr, code: 0 };
    } catch (error: any) {
      return {
        stdout: error?.stdout?.toString?.() ?? "",
        stderr: error?.stderr?.toString?.() ?? error?.message ?? "",
        code: typeof error?.code === "number" ? error.code : 1,
      };
    }
  }

  async function git(args: string, opts: { env?: NodeJS.ProcessEnv } = {}) {
    return run(`git ${args}`, opts);
  }

  async function writeFiles(root: string, files: Record<string, string>) {
    const entries = Object.entries(files);
    await Promise.all(entries.map(async ([relativePath, contents]) => {
      const target = path.join(root, relativePath);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, contents, "utf8");
    }));
  }

  async function appendFiles(files: Record<string, string>) {
    await writeFiles(dir, files);
  }

  async function commit(message: string, files?: Record<string, string>) {
    if (files && Object.keys(files).length) {
      await appendFiles(files);
    }
    await exec("git add --all", { cwd: dir });
    await exec(`git commit -m ${JSON.stringify(message)}`, { cwd: dir });
  }

  async function push(ref = defaultBranch) {
    return run(`git push origin ${ref}`);
  }

  async function read(relativePath: string) {
    const target = path.join(dir, relativePath);
    return readFileFs(target, "utf8");
  }

  async function remoteGit(args: string) {
    try {
      const { stdout, stderr } = await exec(`git ${args}`, { cwd: remoteDir });
      return { stdout, stderr, code: 0 };
    } catch (error: any) {
      return {
        stdout: error?.stdout?.toString?.() ?? "",
        stderr: error?.stderr?.toString?.() ?? error?.message ?? "",
        code: typeof error?.code === "number" ? error.code : 1,
      };
    }
  }

  return {
    dir,
    remoteDir,
    defaultBranch,
    run,
    git,
    writeFiles: appendFiles,
    readFile: read,
    commit,
    push,
    remoteGit,
    path: relativePath => path.join(dir, relativePath),
  };
}

async function buildInitialFiles(options: RepoFixtureOptions) {
  const files: Record<string, string> = { ...(options.files ?? {}) };
  if (!files["package.json"]) {
    const pkg = options.packageJson ?? {
      name: "fixture",
      version: "0.0.1",
      scripts: options.packageScripts ?? {},
    };
    files["package.json"] = `${JSON.stringify(pkg, null, 2)}\n`;
  } else if (options.packageScripts) {
    const pkg = JSON.parse(files["package.json"]);
    pkg.scripts = { ...(pkg.scripts ?? {}), ...options.packageScripts };
    files["package.json"] = `${JSON.stringify(pkg, null, 2)}\n`;
  }

  if (!files["README.md"]) {
    files["README.md"] = "# Fixture\n";
  }

  return files;
}
