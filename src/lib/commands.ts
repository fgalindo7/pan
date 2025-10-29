export type CommandAlias =
  | "docker-exec-pull"
  | "docker-exec-run"
  | "docker-inspect"
  | "docker-pull"
  | "docker-run"
  | "docker-start"
  | "ffyc"
  | "gaa"
  | "gcb"
  | "gcmsg"
  | "gcn"
  | "gfo"
  | "gpsup"
  | "grb"
  | "grba"
  | "gsb"
  | "gss"
  | "gsta"
  | "gstaa"
  | "gstd"
  | "gstl"
  | "prisma-generate"
  | "workspace-script"
  | "yb"
  | "ycc"
  | "ydik"
  | "yi"
  | "yl"
  | "ylf"
  | "ytc"
  | "ywls";

type CommandCategory = "git" | "yarn" | "docker" | "remediation" | "workspace" | "utility";

export interface CommandContext {
  command?: string;
  label?: string;
  target?: string;
  autostash?: boolean;
  message?: string;
  ref?: string;
  branch?: string;
  name?: string;
  path?: string;
  image?: string;
  container?: string;
  model?: string;
}

export interface CommandInstance {
  alias: CommandAlias;
  command: string;
  label: string;
  description: string;
  categories: CommandCategory[];
  toolkit: boolean;
}

interface CommandDefinition {
  alias: CommandAlias;
  description: string;
  categories: CommandCategory[];
  toolkit?: boolean;
  build: (ctx?: CommandContext) => { command: string; label?: string };
}

export const FFYC_COMMAND =
  "find packages -name \"build\" -type d -exec rm -rf {} + 2>/dev/null && find packages -name \"tsconfig.tsbuildinfo\" -type f -delete && find . -name \"node_modules\" -type d -exec rm -rf {} + 2>/dev/null";

export const COMMAND_DEFINITIONS: CommandDefinition[] = [
  {
    alias: "ffyc",
    description: "Deep clean build artifacts, tsbuildinfo, and node_modules",
    categories: ["remediation"],
    toolkit: true,
    build: ctx => {
      const command = ctx?.command ?? FFYC_COMMAND;
      const label = ctx?.label ?? "ffyc deep clean";
      return { command, label };
    },
  },
  {
    alias: "gfo",
    description: "Fetch remote refs and prune stale branches",
    categories: ["git"],
    toolkit: true,
    build: ctx => {
      const command = ctx?.command ?? "git fetch origin --prune";
      const label = ctx?.label ?? "git fetch origin --prune";
      return { command, label };
    },
  },
  {
    alias: "grb",
    description: "Rebase current branch onto a remote target",
    categories: ["git"],
    toolkit: true,
    build: ctx => {
      const target = ctx?.target ?? "origin/master";
      const autostash = ctx?.autostash ?? true;
      const command = ctx?.command ?? `git rebase${autostash ? " --autostash" : ""} ${target}`;
      const label = ctx?.label ?? `git rebase ${target}`;
      return { command, label };
    },
  },
  {
    alias: "grba",
    description: "Abort the in-progress git rebase",
    categories: ["git"],
    build: ctx => {
      const command = ctx?.command ?? "git rebase --abort";
      const label = ctx?.label ?? "git rebase --abort";
      return { command, label };
    },
  },
  {
    alias: "gsb",
    description: "Inspect branch status with ahead/behind counters",
    categories: ["git"],
    build: ctx => {
      const command = ctx?.command ?? "git status --short --branch";
      const label = ctx?.label ?? command;
      return { command, label };
    },
  },
  {
    alias: "gss",
    description: "Inspect worktree short status",
    categories: ["git"],
    build: ctx => {
      const command = ctx?.command ?? "git status --short";
      const label = ctx?.label ?? command;
      return { command, label };
    },
  },
  {
    alias: "gsta",
    description: "Create a stash snapshot including untracked files",
    categories: ["git"],
    build: ctx => {
      const message = ctx?.message ?? "pan stash";
      const command = ctx?.command ?? `git stash push --include-untracked -m ${JSON.stringify(message)}`;
      const label = ctx?.label ?? "git stash push";
      return { command, label };
    },
  },
  {
    alias: "gstl",
    description: "Resolve most recent stash reference",
    categories: ["git"],
    build: ctx => {
      const command = ctx?.command ?? "git stash list --format=%gd -1";
      const label = ctx?.label ?? "git stash resolve";
      return { command, label };
    },
  },
  {
    alias: "gstaa",
    description: "Apply a stash back onto the worktree",
    categories: ["git"],
    build: ctx => {
      const ref = ctx?.ref ?? "stash@{0}";
      const command = ctx?.command ?? `git stash apply ${ref}`;
      const label = ctx?.label ?? `git stash apply ${ref}`;
      return { command, label };
    },
  },
  {
    alias: "gstd",
    description: "Drop a stash entry",
    categories: ["git"],
    build: ctx => {
      const ref = ctx?.ref ?? "stash@{0}";
      const command = ctx?.command ?? `git stash drop ${ref}`;
      const label = ctx?.label ?? `git stash drop ${ref}`;
      return { command, label };
    },
  },
  {
    alias: "gaa",
    description: "Stage all changes",
    categories: ["git"],
    build: ctx => {
      const command = ctx?.command ?? "git add --all";
      const label = ctx?.label ?? "git add --all";
      return { command, label };
    },
  },
  {
    alias: "gcmsg",
    description: "Create a git commit",
    categories: ["git"],
    build: ctx => {
      const message = ctx?.message ?? "chore: prepare for push";
      const command = ctx?.command ?? `git commit --message ${JSON.stringify(message)}`;
      const label = ctx?.label ?? `git commit --message ${message}`;
      return { command, label };
    },
  },
  {
    alias: "gcn",
    description: "Amend commit without editing message",
    categories: ["git"],
    build: ctx => {
      const command = ctx?.command ?? "git commit --no-edit || true";
      const label = ctx?.label ?? "git commit --no-edit";
      return { command, label };
    },
  },
  {
    alias: "gpsup",
    description: "Push branch with upstream tracking",
    categories: ["git"],
    build: ctx => {
      const branch = ctx?.branch ?? "HEAD";
      const command = ctx?.command ?? `git push -u origin ${branch}`;
      const label = ctx?.label ?? `git push -u origin ${branch}`;
      return { command, label };
    },
  },
  {
    alias: "gcb",
    description: "Create and checkout a new branch",
    categories: ["git"],
    build: ctx => {
      const name = ctx?.name ?? "feature";
      const command = ctx?.command ?? `git checkout -b ${name}`;
      const label = ctx?.label ?? `git checkout -b ${name}`;
      return { command, label };
    },
  },
  {
    alias: "ycc",
    description: "Clear Yarn cache",
    categories: ["yarn"],
    toolkit: true,
    build: ctx => {
      const command = ctx?.command ?? "yarn cache clean";
      const label = ctx?.label ?? "yarn cache clean";
      return { command, label };
    },
  },
  {
    alias: "yi",
    description: "Install dependencies",
    categories: ["yarn"],
    toolkit: true,
    build: ctx => {
      const command = ctx?.command ?? "yarn install";
      const label = ctx?.label ?? "yarn install";
      return { command, label };
    },
  },
  {
    alias: "yb",
    description: "Run workspace build",
    categories: ["yarn", "workspace"],
    toolkit: true,
    build: ctx => {
      const command = ctx?.command ?? "yarn build";
      const label = ctx?.label ?? "yarn build";
      return { command, label };
    },
  },
  {
    alias: "yl",
    description: "Run lint checks",
    categories: ["yarn", "workspace"],
    toolkit: true,
    build: ctx => {
      const command = ctx?.command ?? "yarn lint";
      const label = ctx?.label ?? "yarn lint";
      return { command, label };
    },
  },
  {
    alias: "ytc",
    description: "Run TypeScript type-check",
    categories: ["yarn", "workspace"],
    toolkit: true,
    build: ctx => {
      const command = ctx?.command ?? "yarn type-check";
      const label = ctx?.label ?? "yarn type-check";
      return { command, label };
    },
  },
  {
    alias: "ylf",
    description: "Run lint --fix",
    categories: ["yarn"],
    build: ctx => {
      const command = ctx?.command ?? "yarn lint --fix";
      const label = ctx?.label ?? "lint --fix";
      return { command, label };
    },
  },
  {
    alias: "ydik",
    description: "Ensure repository index is clean",
    categories: ["yarn"],
    build: ctx => {
      const command = ctx?.command ?? "yarn dirty-index-check";
      const label = ctx?.label ?? "dirty-index-check";
      return { command, label };
    },
  },
  {
    alias: "ywls",
    description: "List Yarn workspaces as JSON",
    categories: ["yarn"],
    build: ctx => {
      const command = ctx?.command ?? "yarn workspaces list --json";
      const label = ctx?.label ?? "yarn workspaces list";
      return { command, label };
    },
  },
  {
    alias: "prisma-generate",
    description: "Regenerate Prisma client",
    categories: ["remediation"],
    build: ctx => {
      const command = ctx?.command ?? "npx prisma generate";
      const label = ctx?.label ?? "prisma generate";
      return { command, label };
    },
  },
  {
    alias: "workspace-script",
    description: "Run a workspace package.json script",
    categories: ["workspace"],
    toolkit: false,
    build: ctx => {
      if (!ctx?.command) {
        throw new Error("workspace-script command requires ctx.command");
      }
      const label = ctx.label ?? ctx.command;
      return { command: ctx.command, label };
    },
  },
  {
    alias: "docker-pull",
    description: "Pull a Docker image",
    categories: ["docker"],
    build: ctx => {
      const image = ctx?.image ?? "ollama/ollama:latest";
      const command = ctx?.command ?? `docker pull ${image}`;
      const label = ctx?.label ?? `docker pull ${image}`;
      return { command, label };
    },
  },
  {
    alias: "docker-inspect",
    description: "Inspect Docker container",
    categories: ["docker"],
    build: ctx => {
      const container = ctx?.container ?? "pan-llama3";
      const command = ctx?.command ?? `docker inspect ${container}`;
      const label = ctx?.label ?? `docker inspect ${container}`;
      return { command, label };
    },
  },
  {
    alias: "docker-run",
    description: "Run Docker container in background",
    categories: ["docker"],
    build: ctx => {
      const container = ctx?.container ?? "pan-llama3";
      const image = ctx?.image ?? "ollama/ollama:latest";
      const command =
        ctx?.command ??
        `docker run -d --name ${container} -p 11434:11434 ${image}`;
      const label = ctx?.label ?? `docker run ${container}`;
      return { command, label };
    },
  },
  {
    alias: "docker-start",
    description: "Start Docker container",
    categories: ["docker"],
    build: ctx => {
      const container = ctx?.container ?? "pan-llama3";
      const command = ctx?.command ?? `docker start ${container}`;
      const label = ctx?.label ?? `docker start ${container}`;
      return { command, label };
    },
  },
  {
    alias: "docker-exec-pull",
    description: "Pull model inside Docker container",
    categories: ["docker"],
    build: ctx => {
      const container = ctx?.container ?? "pan-llama3";
      const model = ctx?.model ?? "llama3";
      const command = ctx?.command ?? `docker exec -i ${container} ollama pull ${model}`;
      const label = ctx?.label ?? `docker exec ${container} ollama pull ${model}`;
      return { command, label };
    },
  },
  {
    alias: "docker-exec-run",
    description: "Run model inside Docker container",
    categories: ["docker"],
    build: ctx => {
      const container = ctx?.container ?? "pan-llama3";
      const model = ctx?.model ?? "llama3";
      const command = ctx?.command ?? `docker exec -i ${container} ollama run ${model}`;
      const label = ctx?.label ?? `docker exec ${container} ollama run ${model}`;
      return { command, label };
    },
  },
];

const COMMAND_MAP = new Map<CommandAlias, CommandDefinition>(
  COMMAND_DEFINITIONS.map((def: CommandDefinition) => [def.alias, def])
);

export function resolveCommand(alias: CommandAlias, context: CommandContext = {}): CommandInstance {
  const definition = COMMAND_MAP.get(alias);
  if (!definition) {
    throw new Error(`Unknown command alias: ${alias}`);
  }
  const built = definition.build(context);
  const command = context.command ?? built.command;
  const label = context.label ?? built.label ?? command;
  return {
    alias,
    command,
    label,
    description: definition.description,
    categories: definition.categories,
    toolkit: Boolean(definition.toolkit),
  };
}

export function listToolkitCommands(): CommandInstance[] {
  return COMMAND_DEFINITIONS
    .filter(def => def.toolkit !== false)
    .map(def => resolveCommand(def.alias))
    .sort((a, b) => a.alias.localeCompare(b.alias));
}

export function listAllCommands(): CommandInstance[] {
  return COMMAND_DEFINITIONS.map(def => resolveCommand(def.alias));
}
