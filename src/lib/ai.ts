import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { exec as _exec } from "node:child_process";
import { promisify } from "node:util";
const execp = promisify(_exec);

/**
 * Optional AI integration for Pan.
 * Reads context + question, sends via $LLM_COMMAND to a local model (Ollama, LM Studio, etc).
 */
export async function askAI(context: string, question: string) {
  const cmd = process.env.LLM_COMMAND;
  if (!cmd) return "";
  const prompt = `You are helping fix a Yarn workspaces + Prisma monorepo.\n${context}\n\nQuestion: ${question}\n`;
  const tmp = path.join(os.tmpdir(), `pan-${Date.now()}.txt`);
  fs.writeFileSync(tmp, prompt, "utf8");
  try {
    const { stdout } = await execp(`${cmd} < ${JSON.stringify(tmp)}`, { shell: "/bin/zsh" });
    return stdout?.trim();
  } catch {
    return "";
  }
}
