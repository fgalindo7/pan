export interface ShellCommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

export class ShellCommandExecutor {
  async run(command: string, options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<ShellCommandResult> {
    const { exec } = await import("node:child_process");
    return new Promise((resolve) => {
      exec(command, { cwd: options.cwd, env: options.env }, (error, stdout, stderr) => {
        resolve({
          stdout: stdout?.toString?.() ?? "",
          stderr: stderr?.toString?.() ?? (error?.message ?? ""),
          code: error && typeof error.code === "number" ? error.code : 0,
        });
      });
    });
  }
}
