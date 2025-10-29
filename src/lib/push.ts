import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { run, addCommandRecorder, summarizeSuccessfulCommands, type CommandRecord } from "./run.js";
import { currentBranch, rebaseOntoOriginDefault, createBranch, stageAll, commit, pushSetUpstream } from "./git.js";
import { userName, validFeatureBranch, sanitizeSegment, ALLOWED_PREFIX } from "./policy.js";
import { smartBuildFix } from "./fix.js";
import { runPrepushChecks, dirtyIndexCheck, typeCheck, lintFix } from "./checks.js";

export async function pushFlow() {
  console.log("[pan] starting push flow");
  const commandLog: CommandRecord[] = [];
  const removeRecorder = addCommandRecorder(entry => commandLog.push(entry));
  let pushSucceeded = false;
  try {
  const br = await currentBranch();
  const user = userName();

  const onMain = br === "master" || br === "main";
  if (onMain) {
    console.log("On main: will update, create feature branch, then continue.");
  } else {
    console.log(`On branch: ${br}`);
  }

  const stashState = await stashIfNeeded();
  const { onto, ok } = await rebaseOntoOriginDefault();
  if (!ok) {
    if (stashState?.ref) {
      console.log(`[pan] rebase failed; changes remain in ${stashState.ref}. Apply manually after resolving conflicts.`);
    }
    throw new Error(`Rebase onto ${onto} failed. Resolve conflicts then retry.`);
  }
  if (stashState?.ref) {
    await applyStash(stashState.ref);
  }

  let featureBranch = br;
  if (onMain || !validFeatureBranch(br, user)) {
    const rl = readline.createInterface({ input, output });
    const kind = (await rl.question(`Branch type (${ALLOWED_PREFIX.join("/")}) [feat]: `)).trim() || "feat";
    const msg = sanitizeSegment((await rl.question(`Short branch message [work]: `)).trim() || "work");
    rl.close();
    featureBranch = `${user}/${ALLOWED_PREFIX.includes(kind as any) ? kind : "feat"}/${msg}`;
    const mk = await createBranch(featureBranch);
    if (!mk.ok) throw new Error("Failed to create feature branch.");
    console.log(`Created ${featureBranch}`);
  }

  console.log("Fixing build (smart)...");
  const buildResult = await smartBuildFix();
  console.log(`[pan] ${buildResult.summary}`);
  if (buildResult.blockedMessage) {
    for (const step of buildResult.steps) {
      console.log(`[pan] ▸ ${step}`);
    }
    throw new Error(buildResult.blockedMessage);
  }
  if (!buildResult.ok) console.log("Build still failing — continuing with remediation checks.");

  console.log("Running pre-push checks...");
  let checksOK = await runPrepushChecks();
  if (!checksOK) {
    console.log("Checks failing. Trying additional remediation (deep build fix)...");
    const retryResult = await smartBuildFix();
    console.log(`[pan] ${retryResult.summary}`);
    if (retryResult.blockedMessage) {
      for (const step of retryResult.steps) {
        console.log(`[pan] ▸ ${step}`);
      }
      throw new Error(retryResult.blockedMessage);
    }
    checksOK = await runPrepushChecks();
    if (!checksOK) throw new Error("Pre-push checks still failing.");
  }

  await stageAll();
  const defMsg = "chore: prepare for push";
  const rl = readline.createInterface({ input, output });
  const msg = (await rl.question(`Commit message [${defMsg}]: `)).trim() || defMsg;
  rl.close();
  const c = await commit(msg);
  if (!c.ok) throw new Error("Commit failed");

  const dic = await dirtyIndexCheck();
  if (!dic.ok) {
    console.log("dirty-index-check failed after commit. Trying lint/type-check + recommit...");
    await lintFix();
    await typeCheck();
    await stageAll();
    await run("git commit --no-edit || true","git commit --no-edit");
    const dic2 = await dirtyIndexCheck();
    if (!dic2.ok) throw new Error("dirty-index-check still failing.");
  }

  if (featureBranch === "master" || featureBranch === "main") {
    throw new Error("Refusing to push main/master. Create a feature branch.");
  }
  const p = await pushSetUpstream(featureBranch);
  if (!p.ok) throw new Error("Push failed.");

  pushSucceeded = true;
  console.log(`✅ Pushed ${featureBranch}`);
  const lines = summarizeSuccessfulCommands(commandLog);
  if (lines.length) {
    console.log("[pan] Commands executed to prepare the push:");
    for (const line of lines) {
      console.log(`[pan]   - ${line}`);
    }
  }
  } finally {
    removeRecorder();
    if (!pushSucceeded) {
      commandLog.length = 0;
    }
  }
}

async function stashIfNeeded(): Promise<{ ref: string | null } | null> {
  const status = await run("git status --porcelain", "git status snapshot", { silence: true });
  if (!status.ok) return null;
  const lines = status.stdout.split(/\r?\n/).filter(Boolean);
  if (!lines.length) return null;

  let staged = 0;
  let unstaged = 0;
  let untracked = 0;
  for (const line of lines) {
    if (line.startsWith("??")) {
      untracked++;
      continue;
    }
    const x = line[0];
    const y = line[1];
    if (x && x !== " ") staged++;
    if (y && y !== " ") unstaged++;
  }
  const message = `pan stash before rebase (staged:${staged}, unstaged:${unstaged}, untracked:${untracked})`;
  console.log(`[pan] creating stash: ${message}`);
  const pushRes = await run(`git stash push --include-untracked -m ${JSON.stringify(message)}`, "git stash push (pre-rebase)");
  if (!pushRes.ok) {
    throw new Error("Failed to stash working tree before rebase. Inspect .repo-doctor logs for details.");
  }
  const refRes = await run("git stash list --format=%gd -1", "git stash resolve", { silence: true });
  const ref = refRes.ok && refRes.stdout ? refRes.stdout.trim() : "stash@{0}";
  console.log(`[pan] stash saved as ${ref}`);
  return { ref };
}

async function applyStash(ref: string) {
  console.log(`[pan] restoring ${ref}`);
  const applyRes = await run(`git stash apply ${ref}`, `git stash apply ${ref}`);
  if (!applyRes.ok) {
    console.log(`[pan] stash apply failed; ${ref} kept for manual inspection.`);
    return;
  }
  await run(`git stash drop ${ref}`, `git stash drop ${ref}`);
}
