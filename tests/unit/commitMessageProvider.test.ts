import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";

async function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void>) {
  const original = { ...process.env };
  try {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fn();
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in original)) delete process.env[key];
    }
    Object.assign(process.env, original);
  }
}

describe("commit message provider", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unmock("node:child_process");
    vi.unmock("node:readline/promises");
  });

  it("returns static message when PAN_COMMIT_MESSAGE_TEXT is set", async () => {
    await withEnv({ PAN_COMMIT_MESSAGE_TEXT: "feat: message\n\nbody" }, async () => {
      const { createCommitMessageProvider } = await import("../../src/lib/commitMessageProvider.js");
      const provider = createCommitMessageProvider();
      const result = await provider.getCommitMessage({ defaultSubject: "default" });
      expect(result.subject).toBe("feat: message");
      expect(result.body).toBe("body");
    });
  });

  it("launches editor when configured via PAN_COMMIT_MESSAGE_EDITOR", async () => {
    await withEnv(
      {
        PAN_COMMIT_MESSAGE_EDITOR: "custom-editor",
        PAN_NO_COMMIT_EDITOR: undefined,
        PAN_COMMIT_MESSAGE_TEXT: undefined,
      },
      async () => {
        const writeSpy = vi.spyOn(fs, "writeFile").mockImplementation(async () => undefined);
        const readSpy = vi.spyOn(fs, "readFile").mockImplementation(async () => "feat: from editor\n\nBody line");
        const rmSpy = vi.spyOn(fs, "rm").mockImplementation(async () => undefined);
        const mkdirSpy = vi.spyOn(fs, "mkdir").mockImplementation(async () => undefined);

        const spawnMock = vi.fn<(command: string, args?: string[], options?: any) => any>((_command, _args, _options) => {
          return {
            on(event: string, handler: (arg?: unknown) => void) {
              if (event === "close") handler(0);
              return this;
            },
          };
        });

        const actualChildProcess = await vi.importActual<typeof import("node:child_process")>("node:child_process");
        vi.doMock("node:child_process", () => ({
          ...actualChildProcess,
          spawn: spawnMock,
        }));

        const { createCommitMessageProvider: getProvider } = await import("../../src/lib/commitMessageProvider.js");
        const provider = getProvider();
        const result = await provider.getCommitMessage({ defaultSubject: "default" });

        expect(spawnMock).toHaveBeenCalledTimes(1);
        const callArgs = spawnMock.mock.calls[0];
        const command = callArgs[0];
        const args = callArgs[1];
        expect(command).toBe("custom-editor");
        const fileArg = args?.[args.length - 1];
        expect(typeof fileArg).toBe("string");
        expect(result.subject).toBe("feat: from editor");
        expect(result.body).toBe("Body line");

        expect(writeSpy).toHaveBeenCalled();
        expect(readSpy).toHaveBeenCalledWith(fileArg, "utf8");
        expect(rmSpy).toHaveBeenCalled();
        expect(mkdirSpy).toHaveBeenCalled();
      }
    );
  });

  it("falls back to prompt provider on unsupported platform", async () => {
    await withEnv({ PAN_COMMIT_MESSAGE_TEXT: undefined, PAN_NO_COMMIT_EDITOR: "1" }, async () => {
      const questionMock = vi.fn().mockResolvedValue("feat: direct");
      const closeMock = vi.fn();
      vi.doMock("node:readline/promises", () => ({
        default: {
          createInterface: () => ({
            question: questionMock,
            close: closeMock,
          }),
        },
        createInterface: () => ({
          question: questionMock,
          close: closeMock,
        }),
      }));

      const actualChildProcess = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      vi.doMock("node:child_process", () => actualChildProcess);

      const { createCommitMessageProvider: getProvider } = await import("../../src/lib/commitMessageProvider.js");
      const provider = getProvider();
      const result = await provider.getCommitMessage({ defaultSubject: "default" });
      expect(result.subject).toBe("feat: direct");
      expect(questionMock).toHaveBeenCalled();
    });
  });
});
