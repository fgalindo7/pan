import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

export interface CommitMessageOptions {
  defaultSubject: string;
  providedSubject?: string;
  providedBody?: string;
}

export interface CommitMessageResult {
  subject: string;
  body?: string;
}

export interface CommitMessageProvider {
  getCommitMessage(options: CommitMessageOptions): Promise<CommitMessageResult>;
}

class StaticCommitMessageProvider implements CommitMessageProvider {
  constructor(private readonly message: string) {}

  async getCommitMessage(options: CommitMessageOptions): Promise<CommitMessageResult> {
    if (options.providedSubject) {
      return {
        subject: sanitizeSubject(options.providedSubject, options.defaultSubject),
        body: normalizeBody(options.providedBody),
      };
    }

    const normalized = normalizeMultilineMessage(this.message);
    const subject = normalized.subject || options.defaultSubject;
    const body = normalized.body ?? normalizeBody(options.providedBody);
    return { subject, body };
  }
}

class PromptCommitMessageProvider implements CommitMessageProvider {
  async getCommitMessage(options: CommitMessageOptions): Promise<CommitMessageResult> {
    const providedSubject = options.providedSubject;
    const providedBody = normalizeBody(options.providedBody);

    if (providedSubject) {
      return {
        subject: sanitizeSubject(providedSubject, options.defaultSubject),
        body: providedBody,
      };
    }

    let rl: readline.Interface | null = null;
    try {
      rl = readline.createInterface({ input, output });
      const answer = (await rl.question(`Commit message [${options.defaultSubject}]: `)).trim();
      const subject = answer.length ? answer : options.defaultSubject;
      return { subject, body: providedBody };
    } finally {
      rl?.close();
    }
  }
}

class TextEditorCommitMessageProvider implements CommitMessageProvider {
  async getCommitMessage(options: CommitMessageOptions): Promise<CommitMessageResult> {
    const providedSubject = options.providedSubject;
    const providedBody = normalizeBody(options.providedBody);

    if (providedSubject) {
      return {
        subject: sanitizeSubject(providedSubject, options.defaultSubject),
        body: providedBody,
      };
    }

    const filePath = await this.createTemplateFile(options.defaultSubject, providedBody);

    try {
      await this.launchEditor(filePath);
      const contentRaw = await fs.readFile(filePath, "utf8");
      const content = stripCommentLines(contentRaw);
      const normalized = normalizeMultilineMessage(content);
      const subject = normalized.subject || options.defaultSubject;
      const body = normalized.body ?? providedBody;
      return { subject, body };
    } finally {
      await safeUnlink(filePath);
      await safeUnlink(path.dirname(filePath), true);
    }
  }

  private async createTemplateFile(defaultSubject: string, providedBody?: string) {
    const dir = path.join(tmpdir(), `pan-commit-${randomUUID()}`);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, "COMMIT_EDITMSG");
    const template = buildTemplate(defaultSubject, providedBody);
    await fs.writeFile(filePath, template, "utf8");
    return filePath;
  }

  private async launchEditor(filePath: string) {
    const { command, args, options } = resolveEditorCommand(filePath);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, options);
      child.on("error", reject);
      child.on("close", code => {
        if (code === 0) resolve();
        else reject(new Error(`Commit message editor exited with code ${code}`));
      });
    });
  }
}

export function createCommitMessageProvider(): CommitMessageProvider {
  const envText = process.env.PAN_COMMIT_MESSAGE_TEXT;
  if (typeof envText === "string") {
    return new StaticCommitMessageProvider(envText);
  }
  if (shouldUseEditor()) {
    return new TextEditorCommitMessageProvider();
  }
  return new PromptCommitMessageProvider();
}

function sanitizeSubject(subject: string, fallback: string): string {
  const trimmed = subject.trim();
  return trimmed.length ? trimmed : fallback;
}

function normalizeBody(body?: string): string | undefined {
  if (body === undefined) return undefined;
  const trimmed = body.trim();
  return trimmed.length ? trimmed : undefined;
}

function normalizeMultilineMessage(message: string): CommitMessageResult {
  const normalized = message.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");
  const [firstLine = "", ...rest] = lines;
  const subject = firstLine.trim();
  const bodyText = rest.join("\n").trim();
  const body = bodyText.length ? bodyText : undefined;
  return { subject, body };
}

function shouldUseEditor() {
  if (process.env.PAN_NO_COMMIT_EDITOR === "1") return false;
  if (process.env.PAN_COMMIT_MESSAGE_EDITOR) return true;
  if (process.env.PAN_COMMIT_MESSAGE_USE_EDITOR === "1") return true;
  return process.platform === "darwin";
}

function resolveEditorCommand(filePath: string) {
  const custom = process.env.PAN_COMMIT_MESSAGE_EDITOR;
  if (custom) {
    const parts = splitCommand(custom);
    const command = parts.shift() ?? custom;
    return { command, args: [...parts, filePath], options: { stdio: "inherit" as const } };
  }
  return {
    command: "open",
    args: ["-W", "-a", "TextEdit", filePath],
    options: { stdio: "inherit" as const },
  };
}

function splitCommand(input: string): string[] {
  const tokens = input.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g);
  if (!tokens) return [];
  return tokens.map(token => token.replace(/^['"]|['"]$/g, ""));
}

function buildTemplate(defaultSubject: string, providedBody?: string) {
  const lines = [
    defaultSubject,
    "",
    providedBody ?? "",
    "",
    "# Subject: max 50 chars; body wrapped at 72 chars per line.",
    "# Lines starting with # are ignored.",
  ];
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return `${lines.join("\n")}\n`;
}

async function safeUnlink(target: string, isDirectory = false) {
  try {
    await fs.rm(target, { recursive: isDirectory, force: true });
  } catch {}
}

function stripCommentLines(message: string) {
  return message
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter(line => !line.trimStart().startsWith("#"))
    .join("\n");
}
