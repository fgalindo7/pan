import { Workspace } from "./Workspace.js";

export interface BuildFailureResult {
  stdout: string;
  stderr: string;
  logFile?: string;
  code?: number;
}

export interface BuildFailure {
  workspace: Workspace | null;
  result: BuildFailureResult;
}

export interface CommandLogEntry {
  command: string;
  label: string;
  ok: boolean;
  exitCode: number;
  durationMs: number;
  timestamp: number;
}

export class RemediationOutcome {
  readonly ok: boolean;
  readonly summary: string;
  readonly steps: string[];
  readonly failures: BuildFailure[];
  readonly attempts: number;
  readonly blockedMessage?: string;
  readonly consulted: boolean;
  readonly commands: CommandLogEntry[];

  constructor(props: {
    ok: boolean;
    summary: string;
    steps: string[];
    failures: BuildFailure[];
    attempts: number;
    blockedMessage?: string;
    consulted?: boolean;
    commands?: CommandLogEntry[];
  }) {
    this.ok = props.ok;
    this.summary = props.summary;
    this.steps = [...props.steps];
    this.failures = props.failures.map(failure => ({
      workspace: failure.workspace,
      result: { ...failure.result },
    }));
    this.attempts = props.attempts;
    this.blockedMessage = props.blockedMessage;
    this.consulted = Boolean(props.consulted);
    this.commands = props.commands ? props.commands.map(command => ({ ...command })) : [];
  }

  static success(summary: string, steps: string[], attempts: number, commands: CommandLogEntry[] = []) {
    return new RemediationOutcome({
      ok: true,
      summary,
      steps,
      failures: [],
      attempts,
      commands,
    });
  }

  static blocked(message: string, steps: string[], attempts: number, commands: CommandLogEntry[] = []) {
    return new RemediationOutcome({
      ok: false,
      summary: message,
      steps,
      failures: [],
      attempts,
      blockedMessage: message,
      commands,
    });
  }

  withConsulted() {
    return new RemediationOutcome({
      ok: this.ok,
      summary: this.summary,
      steps: this.steps,
      failures: this.failures,
      attempts: this.attempts,
      blockedMessage: this.blockedMessage,
      consulted: true,
      commands: this.commands,
    });
  }
}
