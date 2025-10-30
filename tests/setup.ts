import { afterEach, beforeEach, vi } from "vitest";
import { cleanupTempDirs, resetTrackedTempDirs } from "./support/tempfs";

const BASE_ENV = { ...process.env } as NodeJS.ProcessEnv;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.useRealTimers();

  process.env = { ...BASE_ENV };
  process.env.PAN_CHATGPT_ENABLED = "0";
  process.env.PAN_CHATGPT_CONFIRM = "0";
  process.env.PAN_ASSISTANT_MODE = process.env.PAN_ASSISTANT_MODE ?? "openai";
  process.env.USER = process.env.USER ?? "pan-dev";
});

afterEach(async () => {
  await cleanupTempDirs();
  resetTrackedTempDirs();
});
