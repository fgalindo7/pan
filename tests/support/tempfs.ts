import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const tracked = new Set<string>();

export async function createTempDir(prefix = "pan-test-") {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tracked.add(dir);
  return dir;
}

export async function cleanupTempDirs() {
  if (!tracked.size) return;
  const dirs = Array.from(tracked);
  await Promise.all(
    dirs.map(async dir => {
      try {
        await rm(dir, { recursive: true, force: true });
        tracked.delete(dir);
      } catch {
        // ignore cleanup failures; temp dirs may already be removed
      }
    })
  );
}

export function resetTrackedTempDirs() {
  tracked.clear();
}

export function trackTempDir(dir: string) {
  tracked.add(dir);
}
