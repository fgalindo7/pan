import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { requestAssistantCompletion } from "./chatgpt.js";
import { PushContext, type CommitMessageContext } from "../domain/PushContext.js";

export interface CommitMessageOptions {
  defaultSubject: string;
  providedSubject?: string;
  providedBody?: string;
  suggestedSubject?: string;
  suggestedBody?: string;
  context?: CommitMessageContext;
}

export interface CommitMessageResult {
  subject: string;
  body?: string;
}

export interface CommitMessageProvider {
  getCommitMessage(options: CommitMessageOptions): Promise<CommitMessageResult>;
}

export async function suggestCommitMessage(context: CommitMessageContext): Promise<CommitMessageResult | null> {
  const summary = buildAssistantContext(new PushContext(context).toCommitMessageContext());
  const prompt = [
    "Craft a concise Conventional Commits style message summarizing the staged changes.",
    "Return the subject on the first line. If helpful, include an optional body separated by a blank line.",
    "Focus on what changed and why, not how to test.",
  ].join(" ");

  const response = await requestAssistantCompletion(prompt, { context: summary });
  if (!response) return null;

  const normalized = normalizeMultilineMessage(response);
  const subject = sanitizeSubject(normalized.subject, "");
  if (!subject) return null;
  return { subject, body: normalized.body };
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

    const suggestedSubject = options.suggestedSubject
      ? sanitizeSubject(options.suggestedSubject, options.defaultSubject)
      : options.defaultSubject;
    const suggestedBody = normalizeBody(options.suggestedBody);

    const filePath = await this.createTemplateFile({
      defaultSubject: options.defaultSubject,
      subject: suggestedSubject || options.defaultSubject,
      providedBody,
      suggestedBody,
      context: options.context,
    });

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

  private async createTemplateFile(params: {
    defaultSubject: string;
    subject: string;
    providedBody?: string;
    suggestedBody?: string;
    context?: CommitMessageContext;
  }) {
    const dir = path.join(tmpdir(), `pan-commit-${randomUUID()}`);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, "COMMIT_EDITMSG");
    const template = buildTemplate({
      defaultSubject: params.defaultSubject,
      subject: params.subject,
      body: params.providedBody ?? params.suggestedBody,
      context: params.context,
    });
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

function buildAssistantContext(context: CommitMessageContext) {
  const sections: string[] = [];
  sections.push(`Branch: ${context.branch}`);
  if (context.author) sections.push(`Author: ${context.author}`);
  if (context.changedFiles && context.changedFiles.length) {
    const files = context.changedFiles.slice(0, 40).map(file => `- ${file}`).join("\n");
    sections.push(`Changed files:\n${files}`);
  }
  if (context.statusText && context.statusText.trim()) {
    sections.push(`git status --short:\n${context.statusText.trim()}`);
  }
  if (context.diffStat && context.diffStat.trim()) {
    sections.push(`Diff stat:\n${context.diffStat.trim()}`);
  }
  if (context.commandSummary && context.commandSummary.length) {
    sections.push(`Automated steps:\n${context.commandSummary.map(step => `- ${step}`).join("\n")}`);
  }
  if (context.additionalNotes) {
    sections.push(`Notes: ${context.additionalNotes}`);
  }
  return sections.join("\n\n").slice(0, 4000);
}

function shouldUseEditor() {
  if (process.env.PAN_NO_COMMIT_EDITOR === "1") return false;
  if (process.env.PAN_COMMIT_MESSAGE_EDITOR) return true;
  if (process.env.PAN_COMMIT_MESSAGE_USE_EDITOR === "1") return true;
  return true;
}

function resolveEditorCommand(filePath: string) {
  const custom = process.env.PAN_COMMIT_MESSAGE_EDITOR;
  if (custom) {
    const parts = splitCommand(custom);
    const command = parts.shift() ?? custom;
    return { command, args: [...parts, filePath], options: { stdio: "inherit" as const } };
  }
  if (process.platform === "win32") {
    return {
      command: "notepad",
      args: [filePath],
      options: { stdio: "inherit" as const },
    };
  }
  return {
    command: "vi",
    args: [filePath],
    options: { stdio: "inherit" as const },
  };
}

function splitCommand(input: string): string[] {
  const tokens = input.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g);
  if (!tokens) return [];
  return tokens.map(token => token.replace(/^['"]|['"]$/g, ""));
}

function buildTemplate(options: { defaultSubject: string; subject: string; body?: string; context?: CommitMessageContext }) {
  const subject = options.subject?.trim() || options.defaultSubject;
  const bodyLines = options.body
    ? options.body.replace(/\r\n?/g, "\n").split("\n")
    : [];

  const lines: string[] = [subject];
  if (bodyLines.length) {
    lines.push("");
    lines.push(...bodyLines);
  }
  lines.push("");

  const commentLines = [
    "# Subject: max 50 chars; body wrapped at 72 chars per line.",
    "# Lines starting with # are ignored.",
    ...buildContextComments(options.context),
  ];

  const content = [...lines, ...commentLines].join("\n");
  return `${content}\n`;
}

async function safeUnlink(target: string, isDirectory = false) {
  try {
    await fs.rm(target, { recursive: isDirectory, force: true });
  } catch {}
}

function buildContextComments(context?: CommitMessageContext) {
  if (!context) return [];
  const lines: string[] = [];
  if (context.changedFiles?.length) {
    lines.push("# Changed files:");
    for (const file of context.changedFiles.slice(0, 20)) {
      lines.push(`#   - ${file}`);
    }
    if (context.changedFiles.length > 20) {
      lines.push(`#   … ${context.changedFiles.length - 20} more file(s)`);
    }
  }
  if (context.diffStat && context.diffStat.trim()) {
    lines.push("# Diff stat:");
    for (const line of context.diffStat.trim().split(/\r?\n/).slice(0, 20)) {
      lines.push(`#   ${line}`);
    }
  }
  if (context.commandSummary?.length) {
    lines.push("# Automated commands executed:");
    for (const entry of context.commandSummary.slice(0, 10)) {
      lines.push(`#   - ${entry}`);
    }
  }
  if (context.statusText && context.statusText.trim()) {
    lines.push("# git status --short:");
    for (const line of context.statusText.trim().split(/\r?\n/).slice(0, 20)) {
      lines.push(`#   ${line}`);
    }
  }
  if (context.additionalNotes) {
    lines.push(`# Notes: ${context.additionalNotes}`);
  }
  return lines;
}

function stripCommentLines(message: string) {
  return message
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter(line => !line.trimStart().startsWith("#"))
    .join("\n");
}
