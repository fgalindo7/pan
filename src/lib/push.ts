import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { runCommand, addCommandRecorder, summarizeSuccessfulCommands, type CommandRecord } from "./run.js";
import { currentBranch, rebaseOntoOriginDefault, createBranch, stageAll, commit, pushSetUpstream, worktreeClean, getBranchStatus } from "./git.js";
import { userName, validFeatureBranch, sanitizeSegment, ALLOWED_PREFIX } from "./policy.js";
import { smartBuildFix } from "./fix.js";
import { runPrepushChecks, dirtyIndexCheck, typeCheck, lintFix } from "./checks.js";

export interface PushOptions {
  branchPrefix?: string;
  branchName?: string;
  commitFirstLine?: string;
  commitBody?: string;
}

export interface NormalizedPushOptions {
  branchPrefix?: typeof ALLOWED_PREFIX[number];
  branchName?: string;
  commitFirstLine?: string;
  commitBody?: string;
}

export function validatePushOptions(options: PushOptions = {}): NormalizedPushOptions {
  const normalized: NormalizedPushOptions = {};

  if (typeof options.branchPrefix === "string") {
    const prefix = options.branchPrefix.trim().toLowerCase();
    if (!prefix) {
      throw new Error("--branch-prefix cannot be empty.");
    }
    if (!ALLOWED_PREFIX.includes(prefix as typeof ALLOWED_PREFIX[number])) {
      throw new Error(`Invalid --branch-prefix "${prefix}". Allowed values: ${ALLOWED_PREFIX.join(", ")}`);
    }
    normalized.branchPrefix = prefix as typeof ALLOWED_PREFIX[number];
  }

  if (typeof options.branchName === "string") {
    const slug = sanitizeSegment(options.branchName.trim());
    if (!slug) {
      throw new Error("--branch-name must include at least one alphanumeric or valid symbol after sanitization.");
    }
    normalized.branchName = slug;
  }

  if (typeof options.commitFirstLine === "string") {
    const subject = options.commitFirstLine.trim();
    if (!subject) {
      throw new Error("--commit-first-line cannot be empty.");
    }
    if (subject.includes("\n")) {
      throw new Error("--commit-first-line must be a single line. Use --commit-body for additional text.");
    }
    normalized.commitFirstLine = subject;
  }

  if (typeof options.commitBody === "string") {
    const body = options.commitBody.trim();
    if (body) {
      normalized.commitBody = body;
    }
  }

  return normalized;
}

export async function pushFlow(options: NormalizedPushOptions = {}) {
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

    const requestedPrefix = options.branchPrefix;
    const branchSlugFromOptions = options.branchName;

    let featureBranch = br;
    if (onMain || !validFeatureBranch(br, user)) {
      let branchKind = requestedPrefix ?? "";
      let branchSlug = branchSlugFromOptions ?? "";

      let rl: readline.Interface | null = null;
      try {
        if (!branchKind) {
          rl = readline.createInterface({ input, output });
          const answer = (await rl.question(`Branch type (${ALLOWED_PREFIX.join("/")}) [feat]: `)).trim().toLowerCase() || "feat";
          branchKind = ALLOWED_PREFIX.includes(answer as typeof ALLOWED_PREFIX[number]) ? answer : "feat";
        }
        if (!branchSlug) {
          if (!rl) rl = readline.createInterface({ input, output });
          const answer = sanitizeSegment((await rl.question(`Short branch message [work]: `)).trim() || "work");
          branchSlug = answer.length ? answer : "work";
        }
      } finally {
        rl?.close();
      }

      if (!ALLOWED_PREFIX.includes(branchKind as typeof ALLOWED_PREFIX[number])) {
        console.log(`[pan] Provided branch prefix "${branchKind}" is not allowed. Falling back to feat.`);
        branchKind = "feat";
      }
      if (!branchSlug.length) {
        branchSlug = "work";
      }

      if (requestedPrefix) {
        console.log(`[pan] Using provided branch prefix "${requestedPrefix}".`);
        branchKind = requestedPrefix;
      }
      if (branchSlugFromOptions) {
        console.log(`[pan] Using provided branch name "${branchSlugFromOptions}".`);
        branchSlug = branchSlugFromOptions;
      }

      featureBranch = `${user}/${branchKind}/${branchSlug}`;
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

    const cleanWorktree = await worktreeClean();
    let createdCommit = false;

    if (!cleanWorktree) {
      await stageAll();
      const defMsg = "chore: prepare for push";
      const providedSubject = options.commitFirstLine;
      const commitBody = options.commitBody;

      let subject = providedSubject ?? "";
      let rl: readline.Interface | null = null;
      try {
        if (!subject) {
          rl = readline.createInterface({ input, output });
          subject = (await rl.question(`Commit message [${defMsg}]: `)).trim() || defMsg;
        }
      } finally {
        rl?.close();
      }

      if (providedSubject) {
        console.log("[pan] Using provided commit first line.");
      }
      if (commitBody) {
        console.log("[pan] Using provided commit body.");
      }

      const c = await commit(subject, commitBody);
      if (!c.ok) throw new Error("Commit failed");

      const dic = await dirtyIndexCheck();
      if (!dic.ok) {
        console.log("dirty-index-check failed after commit. Trying lint/type-check + recommit...");
        await lintFix();
        await typeCheck();
        await stageAll();
        await runCommand("gcn");
        const dic2 = await dirtyIndexCheck();
        if (!dic2.ok) throw new Error("dirty-index-check still failing.");
      }
      createdCommit = true;
    } else {
      console.log("[pan] Working tree clean — no commit required.");
    }

    const branchStatus = await getBranchStatus();
    if (!createdCommit) {
      if (!branchStatus) {
        console.log("[pan] Unable to determine branch status. Proceeding without additional prompts.");
      } else {
        const ahead = branchStatus.ahead;
        if (ahead <= 0) {
          console.log("[pan] Nothing new to push. Exiting without pushing.");
          pushSucceeded = true;
          return;
        }

        const upstream = branchStatus.upstream || "its upstream";
        const question = `[pan] ${br} is ahead of ${upstream} by ${ahead} commit${ahead === 1 ? "" : "s"}. Push now? [Y/n] `;
        const proceed = await promptYesNo(question, true);
        if (!proceed) {
          console.log("[pan] Push cancelled at your request. Local commits remain unpushed.");
          pushSucceeded = true;
          return;
        }
      }
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
  const status = await runCommand("gss", { label: "git status --short snapshot" }, { silence: true });
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
  const pushRes = await runCommand("gsta", { message, label: "git stash push (pre-rebase)" });
  if (!pushRes.ok) {
    throw new Error("Failed to stash working tree before rebase. Inspect .repo-doctor logs for details.");
  }
  const refRes = await runCommand("gstl", { label: "git stash resolve" }, { silence: true });
  const ref = refRes.ok && refRes.stdout ? refRes.stdout.trim() : "stash@{0}";
  console.log(`[pan] stash saved as ${ref}`);
  return { ref };
}

async function applyStash(ref: string) {
  console.log(`[pan] restoring ${ref}`);
  const applyRes = await runCommand("gstaa", { ref, label: `git stash apply ${ref}` });
  if (!applyRes.ok) {
    console.log(`[pan] stash apply failed; ${ref} kept for manual inspection.`);
    return;
  }
  await runCommand("gstd", { ref, label: `git stash drop ${ref}` });
}

async function promptYesNo(question: string, defaultYes = true) {
  const rl = readline.createInterface({ input, output });
  try {
    const response = (await rl.question(question)).trim().toLowerCase();
    if (!response) return defaultYes;
    if (["y", "yes"].includes(response)) return true;
    if (["n", "no"].includes(response)) return false;
    return defaultYes;
  } finally {
    rl.close();
  }
}
