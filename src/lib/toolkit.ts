export const FFYC_COMMAND = "find packages -name \"build\" -type d -exec rm -rf {} + 2>/dev/null && find packages -name \"tsconfig.tsbuildinfo\" -type f -delete && find . -name \"node_modules\" -type d -exec rm -rf {} + 2>/dev/null";

export interface ToolkitEntry {
	alias: string;
	command: string;
	description?: string;
	source: "core" | "env";
}

const BASE_TOOLKIT: ToolkitEntry[] = [
	{
		alias: "git-fetch",
		command: "git fetch --prune",
		description: "Fetch remote refs and prune stale branches",
		source: "core",
	},
	{
		alias: "git-rebase",
		command: "git rebase --autostash origin/master",
		description: "Rebase current branch onto origin/master with autostash",
		source: "core",
	},
	{
		alias: "ycc",
		command: "yarn cache clean",
		description: "Clear Yarn cache",
		source: "core",
	},
	{
		alias: "yi",
		command: "yarn install",
		description: "Install dependencies",
		source: "core",
	},
	{
		alias: "yb",
		command: "yarn build",
		description: "Run root build script",
		source: "core",
	},
	{
		alias: "yl",
		command: "yarn lint",
		description: "Run lint checks",
		source: "core",
	},
	{
		alias: "ytc",
		command: "yarn type-check",
		description: "Run TypeScript type-check",
		source: "core",
	},
	{
		alias: "ffyc",
		command: FFYC_COMMAND,
		description: "Deep clean build artifacts, tsbuildinfo, and node_modules",
		source: "core",
	},
];

export function getToolkitCommands(): ToolkitEntry[] {
	const entries: ToolkitEntry[] = [...BASE_TOOLKIT];
	const docker = process.env.PAN_DOCKER_DEV_CMD?.trim();
	if (docker) {
		entries.push({
			alias: "docker-dev",
			command: docker,
			description: "Custom Docker remediation (PAN_DOCKER_DEV_CMD)",
			source: "env",
		});
	}

	return entries.sort((a, b) => a.alias.localeCompare(b.alias));
}
