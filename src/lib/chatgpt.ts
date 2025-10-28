import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { exec as _exec } from "node:child_process";
import { promisify } from "node:util";
import { run } from "./run.js";

export interface LogContext {
  label: string;
  path?: string;
  snippet?: string;
}

interface ChatGPTContext {
  summary: string;
  question: string;
  logs?: LogContext[];
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

const execp = promisify(_exec);

export type AssistantMode = "openai" | "local";

function resolveLocalCommand() {
  return process.env.PAN_LOCAL_LLM_COMMAND || process.env.PAN_LLM_COMMAND || process.env.LLM_COMMAND || "";
}

export function getAssistantMode(): AssistantMode {
  const envMode = (process.env.PAN_ASSISTANT_MODE || "").toLowerCase();
  if (envMode === "local") return "local";
  if (envMode === "openai") return "openai";
  if ((process.env.PAN_OPENAI_API_KEY || process.env.OPENAI_API_KEY) && envMode !== "local") return "openai";
  if (resolveLocalCommand()) return "local";
  return "openai";
}

export function requiresOpenAIKey(mode?: AssistantMode) {
  return (mode ?? getAssistantMode()) === "openai";
}

export function hasLocalAssistantCommand() {
  return Boolean(resolveLocalCommand());
}

export function localAssistantCommandLabel() {
  return resolveLocalCommand();
}

const CHATGPT_ENABLED = process.env.PAN_CHATGPT_ENABLED !== "0";
const CHATGPT_MODEL = process.env.PAN_CHATGPT_MODEL || "gpt-5-codex";
const CHATGPT_BASE_URL = process.env.PAN_CHATGPT_BASE_URL || "https://api.openai.com/v1";
const CHATGPT_TIMEOUT_MS = Number(process.env.PAN_CHATGPT_TIMEOUT_MS || 120_000);
const CHATGPT_MAX_TOKENS = Number(process.env.PAN_CHATGPT_MAX_TOKENS || 800);
const CHATGPT_CONFIRM = process.env.PAN_CHATGPT_CONFIRM !== "0";
const CHATGPT_MAX_ROUNDS = Number(process.env.PAN_CHATGPT_MAX_ROUNDS || 3);

let alreadyEscalated = false;

export function resetChatGPTSession() {
  alreadyEscalated = false;
}

export async function consultChatGPT(ctx: ChatGPTContext) {
  if (!CHATGPT_ENABLED) return;
  const mode = getAssistantMode();
  const assistantLabel = mode === "openai" ? "ChatGPT" : "assistant";
  const assistantTag = mode === "openai" ? "chatgpt" : "assistant";
  if (alreadyEscalated) {
    console.log(`[pan] ${assistantLabel} escalation already triggered earlier in this run.`);
    return;
  }
  const apiKey = process.env.PAN_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  if (mode === "openai" && !apiKey) {
    console.log("[pan] ChatGPT escalation skipped: set PAN_OPENAI_API_KEY or OPENAI_API_KEY to enable terminal suggestions.");
    return;
  }
  if (mode === "local" && !hasLocalAssistantCommand()) {
    console.log("[pan] Local LLM command not set. Configure PAN_LOCAL_LLM_COMMAND, PAN_LLM_COMMAND, or LLM_COMMAND.");
    return;
  }

  const initialContext = buildPrompt(ctx);
  const systemMessage: ChatMessage = {
    role: "system",
    content: [
      "You are GPT-5 Codex helping a CLI assistant named Pan debug a Yarn workspaces repository.",
      "Hold a friendly conversation, suggest actionable shell commands wrapped in ```sh code blocks, and only propose steps that are safe to run locally.",
      "After Pan executes your commands, it will report back the results. You may ask for clarification or provide further steps.",
    ].join(" "),
  };

  const messages: ChatMessage[] = [systemMessage, { role: "user", content: initialContext }];

  if (CHATGPT_CONFIRM) {
    const label = mode === "openai" ? "ChatGPT (gpt-5-codex)" : `local assistant (${resolveLocalCommand()})`;
    const proceed = await promptYesNo(`[pan] Consult ${label} for additional ideas? [y/N] `, false);
    if (!proceed) {
      console.log(`[pan] Skipping ${assistantLabel} escalation (user declined).`);
      return;
    }
  }

  const extraIntro = await promptOptional(`[you] Add anything you want ${assistantLabel} to know before we start (enter to skip): `);
  if (extraIntro) {
    messages.push({ role: "user", content: `Additional user context: ${extraIntro}` });
    console.log(`[you] ${extraIntro}`);
  }

  alreadyEscalated = true;

  if (mode === "openai") {
    console.log("[pan] Starting chat with ChatGPT. Type at any prompt to join the conversation.");
  } else {
    console.log(`[pan] Starting chat with local assistant (${resolveLocalCommand()}). Type at any prompt to join the conversation.`);
  }

  let round = 0;
  let continueChat = true;

  while (continueChat && round < CHATGPT_MAX_ROUNDS) {
    round += 1;
    const assistantReply = await requestAssistantReply(mode, messages, apiKey);
    if (!assistantReply) {
      console.log(`[pan] ${assistantLabel} did not return a response. Ending chat.`);
      break;
    }

    console.log(`[${assistantTag}] ${assistantReply.trim()}`);
    messages.push({ role: "assistant", content: assistantReply });

    const commands = extractShellCommands(assistantReply);
    let commandSummary = "";
    if (commands.length) {
      commandSummary = await executeCommands(commands, assistantLabel, assistantTag);
      if (commandSummary) {
        console.log(`[pan] Command summary:\n${indent(commandSummary.trim(), 2)}`);
        messages.push({ role: "user", content: `Pan executed the following commands:\n${commandSummary}` });
      }
    } else {
      console.log(`[pan] ${assistantLabel} did not provide runnable commands.`);
    }

    const userReply = await promptOptional(`[you] Reply to ${assistantLabel} (enter to skip): `);
    if (userReply) {
      messages.push({ role: "user", content: `User says: ${userReply}` });
      console.log(`[you] ${userReply}`);
    }

    if (round >= CHATGPT_MAX_ROUNDS) {
      console.log("[pan] Reached chat round limit.");
      break;
    }

    continueChat = await promptYesNo(`[pan] Continue chatting with ${assistantLabel}? [Y/n] `, true);
    if (continueChat) {
      const followUp = await promptOptional(`[pan] Anything else to tell ${assistantLabel} before the next reply? (enter to skip): `);
      if (followUp) {
        messages.push({ role: "user", content: `Additional context: ${followUp}` });
        console.log(`[you] ${followUp}`);
      }
    }
  }

  console.log(`[pan] ${assistantLabel} session complete.`);
}

export function logContextFromFile(label: string, logFile?: string, maxLines = 80): LogContext {
  if (!logFile) return { label };
  try {
    const content = fs.readFileSync(logFile, "utf8");
    const lines = content.trimEnd().split(/\r?\n/);
    const snippet = lines.slice(-maxLines).join("\n");
    return { label, path: logFile, snippet };
  } catch {
    return { label, path: logFile };
  }
}

function buildPrompt(ctx: ChatGPTContext) {
  const lines = [
    "Pan status report:",
    ctx.summary.trim(),
    "",
    "Relevant logs:",
  ];
  const logs = ctx.logs ?? [];
  if (!logs.length) {
    lines.push("(No log snippets available.)");
  } else {
    for (const log of logs) {
      const header = `- ${log.label}${log.path ? ` (${log.path})` : ""}`;
      lines.push(header);
      if (log.snippet) {
        lines.push(indent(log.snippet.trim(), 2));
      }
      lines.push("");
    }
  }
  lines.push("Question:", ctx.question.trim());
  return lines.join("\n");
}

function indent(text: string, spaces = 2) {
  const pad = " ".repeat(spaces);
  return text.split("\n").map(line => pad + line).join("\n");
}

async function executeCommands(commands: string[], assistantLabel: string, assistantTag: string) {
  const outputs: string[] = [];

  for (const command of commands) {
    const label = command.split(" ")[0] || "command";
    console.log(`[pan] Running command from ${assistantLabel}: ${command}`);
    const result = await run(command, `${assistantTag}:${label}`);
    const status = result.ok ? "success" : `failed (exit ${result.code ?? "unknown"})`;
    console.log(`[pan] Result: ${status}`);
    if (result.stdout) console.log(indent(`stdout:\n${result.stdout}`, 4));
    if (result.stderr) console.log(indent(`stderr:\n${result.stderr}`, 4));
    if (result.logFile) console.log(indent(`log file: ${result.logFile}`, 4));
    outputs.push([
      `Command: ${command}`,
      `Outcome: ${status}`,
      result.stdout ? `Stdout: ${truncate(result.stdout)}` : "",
      result.stderr ? `Stderr: ${truncate(result.stderr)}` : "",
    ].filter(Boolean).join("\n"));
  }

  return outputs.join("\n\n");
}

function extractShellCommands(text: string) {
  const commands: string[] = [];
  const codeBlockRegex = /```(?:sh|bash|zsh|shell)?\s+([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  while ((match = codeBlockRegex.exec(text)) !== null) {
    const block = match[1]
      .split("\n")
      .map(line => line.trim())
      .filter(line => line && !line.startsWith("#"));
    commands.push(...block);
  }
  if (!commands.length) {
    const lineRegex = /^[>$]\s*(.+)$/gm;
    while ((match = lineRegex.exec(text)) !== null) {
      const line = match[1].trim();
      if (line && !line.includes("```") && !line.toLowerCase().startsWith("run")) {
        commands.push(line);
      }
    }
  }
  return dedupe(commands.map(stripLeadingDollar).filter(Boolean));
}

function stripLeadingDollar(cmd: string) {
  return cmd.startsWith("$") ? cmd.slice(1).trim() : cmd.trim();
}

function dedupe(values: string[]) {
  return Array.from(new Set(values));
}

async function requestAssistantReply(mode: AssistantMode, messages: ChatMessage[], apiKey?: string) {
  if (mode === "local") {
    return requestLocalCompletion(messages);
  }
  return requestChatCompletion(apiKey ?? "", messages);
}

async function requestChatCompletion(apiKey: string, messages: ChatMessage[]) {
  const url = `${CHATGPT_BASE_URL.replace(/\/+$/, "")}/chat/completions`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CHATGPT_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: CHATGPT_MODEL,
        temperature: 0.2,
        max_tokens: CHATGPT_MAX_TOKENS,
        messages,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await safeReadText(response);
      console.log(`[pan] ChatGPT request failed (${response.status} ${response.statusText})${text ? `: ${text}` : ""}`);
      return "";
    }

    const data = await response.json();
    const suggestion: string | undefined = data?.choices?.[0]?.message?.content;
    return suggestion?.trim() ?? "";
  } catch (error: any) {
    if (error?.name === "AbortError") {
      console.log("[pan] ChatGPT request timed out.");
      return "";
    }
    console.log(`[pan] ChatGPT request error: ${error?.message || error}`);
    return "";
  } finally {
    clearTimeout(timeout);
  }
}

async function safeReadText(response: any) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

async function requestLocalCompletion(messages: ChatMessage[]) {
  const cmd = resolveLocalCommand();
  if (!cmd) return "";
  const prompt = buildLocalPrompt(messages);
  const tmp = path.join(os.tmpdir(), `pan-local-${Date.now()}.txt`);
  fs.writeFileSync(tmp, prompt, "utf8");
  try {
    const { stdout } = await execp(`${cmd} < ${JSON.stringify(tmp)}`, { shell: "/bin/zsh" });
    return stdout.trim();
  } catch (error: any) {
    console.log(`[pan] Local LLM command failed: ${error?.message || error}`);
    return "";
  } finally {
    try { fs.rmSync(tmp); } catch { /* ignore */ }
  }
}

function buildLocalPrompt(messages: ChatMessage[]) {
  const system = messages.filter(m => m.role === "system").map(m => m.content).join("\n\n");
  const conversation = messages
    .filter(m => m.role !== "system")
    .map(m => {
      const speaker = m.role === "assistant" ? "Assistant" : "Pan";
      return `${speaker}: ${m.content}`;
    })
    .join("\n\n");
  return [
    system,
    "",
    "Conversation so far:",
    conversation || "(none yet)",
    "",
    "Respond as Assistant with friendly tone. Suggest shell commands inside ```sh code blocks when appropriate, followed by explanations."
  ].join("\n");
}

async function promptYesNo(question: string, defaultYes: boolean) {
  const answer = (await promptLine(question)).trim().toLowerCase();
  if (!answer) return defaultYes;
  if (["y", "yes"].includes(answer)) return true;
  if (["n", "no"].includes(answer)) return false;
  return defaultYes;
}

async function promptOptional(question: string) {
  return (await promptLine(question)).trim();
}

async function promptLine(question: string) {
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(question);
    return answer;
  } finally {
    rl.close();
  }
}

function truncate(text: string, limit = 400) {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…`;
}
