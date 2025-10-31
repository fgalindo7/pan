import { vi } from "vitest";

export type CommandRecord = {
  command: string;
  label: string;
  ok: boolean;
  exitCode: number;
  durationMs: number;
  timestamp: number;
};

export type RunResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  logFile: string;
};

export type PushMockState = {
  events: string[];
  run: {
    recorders: Array<(entry: CommandRecord) => void>;
    outputs: Map<string, RunResult>;
  };
  git: {
    currentBranch: string;
    rebaseOnto: string;
    rebaseOk: boolean;
    createBranchOk: boolean;
    commitOk: boolean;
    pushOk: boolean;
    worktreeClean: boolean;
    branchStatus: {
      name: string;
      upstream?: string;
      ahead: number;
      behind: number;
      detached: boolean;
    };
  };
  fix: {
    result: {
      ok: boolean;
      summary: string;
      steps: string[];
      failures: unknown[];
      attempts: number;
      consulted: boolean;
      commands: CommandRecord[];
      blockedMessage?: string;
    };
  };
  checks: {
    prepushOk: boolean;
    dirtyIndexOk: boolean;
  };
};

export const pushMockState: PushMockState = {
  events: [],
  run: {
    recorders: [],
    outputs: new Map(),
  },
  git: {
    currentBranch: "main",
    rebaseOnto: "origin/main",
    rebaseOk: true,
    createBranchOk: true,
    commitOk: true,
    pushOk: true,
    worktreeClean: false,
    branchStatus: {
      name: "francisco/feat/test-foundations",
      upstream: "origin/francisco/feat/test-foundations",
      ahead: 1,
      behind: 0,
      detached: false,
    },
  },
  fix: {
    result: {
      ok: true,
      summary: "priority remediation finished cleanly",
      steps: [],
      failures: [],
      attempts: 1,
      consulted: false,
      commands: [],
    },
  },
  checks: {
    prepushOk: true,
    dirtyIndexOk: true,
  },
};

export function resetPushMockState() {
  pushMockState.events.length = 0;
  pushMockState.run.recorders.length = 0;
  pushMockState.run.outputs.clear();

  pushMockState.git.currentBranch = "main";
  pushMockState.git.rebaseOnto = "origin/main";
  pushMockState.git.rebaseOk = true;
  pushMockState.git.createBranchOk = true;
  pushMockState.git.commitOk = true;
  pushMockState.git.pushOk = true;
  pushMockState.git.worktreeClean = false;
  pushMockState.git.branchStatus = {
    name: "francisco/feat/test-foundations",
    upstream: "origin/francisco/feat/test-foundations",
    ahead: 1,
    behind: 0,
    detached: false,
  };

  pushMockState.fix.result = {
    ok: true,
    summary: "priority remediation finished cleanly",
    steps: [],
    failures: [],
    attempts: 1,
    consulted: false,
    commands: [],
  };

  pushMockState.checks.prepushOk = true;
  pushMockState.checks.dirtyIndexOk = true;

  process.env.USER = "francisco";
}

export async function importPushModule() {
  return import("../../src/lib/push");
}

vi.mock("../../src/lib/run.js", () => {
  return {
    runCommand: vi.fn(async (alias: string, ctx?: { label?: string }) => {
      const label = ctx?.label ?? alias;
      pushMockState.events.push(`run:${alias}:${label}`);
      const result = pushMockState.run.outputs.get(alias) ?? { ok: true, stdout: "", stderr: "", logFile: "" };
      pushMockState.run.recorders.forEach(recorder => recorder({
        command: alias,
        label,
        ok: result.ok,
        exitCode: result.ok ? 0 : 1,
        durationMs: 0,
        timestamp: Date.now(),
      }));
      return result;
    }),
    addCommandRecorder: vi.fn((recorder: (entry: CommandRecord) => void) => {
      pushMockState.run.recorders.push(recorder);
      return () => {
        const index = pushMockState.run.recorders.indexOf(recorder);
        if (index >= 0) pushMockState.run.recorders.splice(index, 1);
      };
    }),
    summarizeSuccessfulCommands: vi.fn((records: CommandRecord[]) => records.filter(record => record.ok).map(record => record.label)),
    run: vi.fn(async (command: string, label?: string) => {
      const actualLabel = label ?? command;
      pushMockState.events.push(`run:${command}:${actualLabel}`);
      pushMockState.run.recorders.forEach(recorder => recorder({
        command,
        label: actualLabel,
        ok: true,
        exitCode: 0,
        durationMs: 0,
        timestamp: Date.now(),
      }));
      return { ok: true, stdout: "", stderr: "", logFile: "" };
    }),
  };
});

vi.mock("../../src/lib/git.js", () => {
  return {
    currentBranch: vi.fn(async () => pushMockState.git.currentBranch),
    rebaseOntoOriginDefault: vi.fn(async () => {
      pushMockState.events.push("git:rebase");
      return { onto: pushMockState.git.rebaseOnto, ok: pushMockState.git.rebaseOk };
    }),
    createBranch: vi.fn(async (name: string) => {
      pushMockState.events.push(`git:createBranch:${name}`);
      return { ok: pushMockState.git.createBranchOk };
    }),
    stageAll: vi.fn(async () => {
      pushMockState.events.push("git:stageAll");
      return { ok: true };
    }),
    commit: vi.fn(async (message: string, body?: string) => {
      pushMockState.events.push(`git:commit:${message}|${body ?? ""}`);
      return { ok: pushMockState.git.commitOk };
    }),
    pushSetUpstream: vi.fn(async (branch: string) => {
      pushMockState.events.push(`git:push:${branch}`);
      return { ok: pushMockState.git.pushOk };
    }),
    worktreeClean: vi.fn(async () => pushMockState.git.worktreeClean),
    getBranchStatus: vi.fn(async () => pushMockState.git.branchStatus),
    getShortStatus: vi.fn(async () => ""),
    getCachedDiffStat: vi.fn(async () => ""),
  };
});

vi.mock("../../src/lib/fix.js", () => {
  return {
    smartBuildFix: vi.fn(async () => {
      pushMockState.events.push("fix:smartBuildFix");
      return pushMockState.fix.result;
    }),
  };
});

vi.mock("../../src/lib/workspaces.ts", () => {
  return {
    changedFiles: vi.fn(async () => ["package.json"]),
  };
});

vi.mock("../../src/lib/commitMessageProvider.ts", () => {
  return {
    createCommitMessageProvider: vi.fn(() => ({
      getCommitMessage: vi.fn(async (options: { defaultSubject: string; providedSubject?: string; providedBody?: string }) => ({
        subject: options.providedSubject ?? options.defaultSubject,
        body: options.providedBody,
      })),
    })),
    suggestCommitMessage: vi.fn(async () => null),
  };
});

vi.mock("../../src/lib/checks.js", () => {
  return {
    runPrepushChecks: vi.fn(async () => {
      pushMockState.events.push("checks:runPrepushChecks");
      return pushMockState.checks.prepushOk;
    }),
    dirtyIndexCheck: vi.fn(async () => ({ ok: pushMockState.checks.dirtyIndexOk })),
    typeCheck: vi.fn(async () => ({ ok: true })),
    lintFix: vi.fn(async () => ({ ok: true })),
  };
});
