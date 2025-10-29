import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { PushOptions } from "./push.js";

interface RawAnswers {
  [key: string]: any;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function coerceString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function parseFileContents(content: string, ext: string, filePath: string): RawAnswers {
  const lowered = ext.toLowerCase();
  if (lowered === ".json") {
    return JSON.parse(content) as RawAnswers;
  }
  if (lowered === ".yaml" || lowered === ".yml") {
    return parseYaml(content) as RawAnswers;
  }
  // Try JSON first, then YAML as a fallback for unknown extensions.
  try {
    return JSON.parse(content) as RawAnswers;
  } catch {
    try {
      return parseYaml(content) as RawAnswers;
    } catch (error) {
      throw new Error(`Unable to parse answers file ${filePath}: ${(error as Error).message}`);
    }
  }
}

function extractPushNode(raw: RawAnswers): RawAnswers {
  if (!isRecord(raw)) return {};
  if (isRecord(raw.push)) return raw.push;
  return raw;
}

export interface PushAnswersSource extends PushOptions {
  sourcePath: string;
}

export async function loadPushAnswers(filePath: string): Promise<PushAnswersSource> {
  const resolved = path.resolve(filePath);
  let data: RawAnswers;
  try {
    const content = await fs.readFile(resolved, "utf8");
    const ext = path.extname(resolved);
    data = parseFileContents(content, ext, resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Answers file not found at ${resolved}`);
    }
    throw new Error(`Failed to read answers file ${resolved}: ${(error as Error).message}`);
  }

  const pushNode = extractPushNode(data);
  const branchNode = isRecord(pushNode.branch) ? pushNode.branch : {};
  const commitNode = isRecord(pushNode.commit) ? pushNode.commit : {};

  const branchPrefix = coerceString(pushNode.branchPrefix)
    ?? coerceString(branchNode.prefix)
    ?? coerceString(branchNode.type);

  const branchName = coerceString(pushNode.branchName)
    ?? coerceString(branchNode.name)
    ?? coerceString(branchNode.slug);

  const commitFirstLine = coerceString(pushNode.commitFirstLine)
    ?? coerceString(commitNode.firstLine)
    ?? coerceString(commitNode.subject)
    ?? coerceString(commitNode.title);

  const commitBody = coerceString(pushNode.commitBody)
    ?? coerceString(commitNode.body);

  return {
    sourcePath: resolved,
    branchPrefix,
    branchName,
    commitFirstLine,
    commitBody,
  };
}
