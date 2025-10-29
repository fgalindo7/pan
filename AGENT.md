# Pan Agent Guide

## Purpose

- Shepherd Yarn or npm monorepos through a safe `push` flow.
- Automate build remediation, linting, type-checking, and git hygiene before changes reach the remote.
- Provide optional hooks for local LLMs to help diagnose failures.

## Core Commands

- `pan diagnose`: Run `yarn type-check`, `yarn lint -s`, and `yarn build -s` to surface issues quickly.
- `pan fix`: Attempt a smart build repair (targeted workspace builds, Prisma generate, cache cleanup, optional Docker remediation, fix scripts).
- `pan prepush`: Execute lint fix, type-check, relevant workspace tests, and dirty index validation.
- `pan push`: Complete workflow; stashes dirty state, rebases from `origin/{master|main}`, enforces feature branch naming, runs fix + checks, commits, and pushes.
- `pan chat`: Launch a GPT-5 Codex session that shares repo context, lets the user supply extra instructions, and executes suggested commands automatically.
- `pan help`: Print the full usage guide, environment variables, and workflow expectations.

## Agent Best Practices

- **Drive `pan push` with scripted input.** The CLI expects interactive answers (branch confirmations, commit message, instructions). When automating, collect responses in a multiline heredoc/printf and pipe them in: `printf 'y\ncommit subject\ncommit body\n' | pan push`. This keeps the run deterministic and avoids deadlocks while waiting for stdin.
- **Summarize actions in the prompt.** Before invoking `pan push`, echo the intended high-level plan (e.g., tests run, files touched). The CLI records the prompt in `.repo-doctor/` and surfaces it during verbose mode, making later debugging easier.
- **Lean on `--verbose` when debugging.** Add `--verbose` to `pan diagnose|fix|prepush|push` to stream raw stdout/stderr and append detailed logs to the failure summary. Without it, Pan prints a concise red summary of the last failing command and the log file path.
- **Respect branch policy upfront.** Ensure the current branch follows `<user>/(feat|fix|docs|ci|perf|refactor|style)/message` before calling `pan push`; automated runs fail fast if the name violates the policy.
- **Keep the working tree tidy.** Run `git status -sb` prior to invoking Pan so you can stash or commit unrelated changes. `pan push` will auto-stash, but surfacing surprises early avoids conflicts.
- **Watch the `.repo-doctor` logs.** Each step writes `*.log` artifacts. Tail them when a command exits non-zero; Pan links the most recent failure in its summary.
- **Reuse `pan fix` before retries.** After manual remediation, rerun `pan fix` (or `pan push` with `--resume` once implemented) to let Pan regenerate caches, reinstall dependencies, or rerun targeted workspace builds.

## Workflow Expectations

1. Repository uses Git with an `origin` remote and Yarn workspaces (or compatible scripts).
2. Pan inspects `git status` and `yarn workspaces list` to build/test only workspaces touched by current changes.
3. Default branch is `main` or `master`; feature branches follow `<user>/<feat|fix>/<message>`.
4. `pan push` prompts for branch creation when policy is violated and for commit messages before pushing.
5. Logs for each step are written to `.repo-doctor/` for post-run inspection and echoed in real time.

## Environment Variables

- `LLM_COMMAND`: Shell command invoked with stdin prompt to obtain AI suggestions (e.g., `ollama run llama3`). Leave unset to skip AI integration.
- `PAN_DOCKER_DEV_CMD`: Optional command executed when build logs mention Docker connectivity problems (e.g., `yarn workspace services docker:dev`).
- `PAN_CHATGPT_ENABLED` (default 1): Set to `0` to prevent Pan from offering ChatGPT escalation.
- `PAN_OPENAI_API_KEY` / `OPENAI_API_KEY`: Provide the ChatGPT API key tied to the operator’s account.
- `PAN_ASSISTANT_MODE`: `openai` (default) or `local`. Local mode uses `PAN_LOCAL_LLM_COMMAND` / `PAN_LLM_COMMAND` / `LLM_COMMAND` to run an external CLI (e.g., `ollama run llama3`).
- `PAN_CHATGPT_CONFIRM` (default 1): Set to `0` to skip the confirmation prompt before contacting ChatGPT.
- `PAN_CHATGPT_MODEL` (default `gpt-5-codex`), `PAN_CHATGPT_BASE_URL`, `PAN_CHATGPT_TIMEOUT_MS`, `PAN_CHATGPT_MAX_TOKENS`, `PAN_CHATGPT_MAX_ROUNDS`: fine-tune the API request and chat loop length.
- `PAN_LLAMA_DOCKER_IMAGE`, `PAN_LLAMA_DOCKER_CONTAINER`, `PAN_LLAMA_MODEL`: Override the defaults (`ollama/ollama:latest`, `pan-llama3`, `llama3`) used when Pan auto-installs the local Docker LLM.

## Guardrails

- Refuses to push directly to `main`/`master`.
- Automatically stashes (with a Pan-labelled message) and reapplies dirty state around rebases.
- Stops the flow on failed rebases, lint/type-check/test violations, or dirty working tree after commit.
- Expects `yarn type-check`, `yarn lint`, `yarn build`, and `yarn dirty-index-check` scripts to exist. Provide stubs or adjust scripts before using the CLI.

## Troubleshooting

- Inspect `.repo-doctor/*.log` for verbose stdout/stderr of failing steps.
- Re-run `pan fix` or `pan push` after manual remediation; CLI is idempotent except for git mutations already applied.
- Configure `PAN_DOCKER_DEV_CMD` if your monorepo requires Docker services to be up for a successful build.
- When Pan escalates to ChatGPT (via `pan chat` or failure fallbacks), it carries out a friendly terminal chat, automatically runs any suggested shell commands, and streams the transcript; redact sensitive log lines before re-running if necessary.
- Add custom remediation scripts (e.g., `fix:*`, `*:migrate`, `*:clean`) to package.json; Pan will invoke matching scripts when failures mention related keywords.
- Local default (`llama3`): When selected, Pan pulls `ollama/ollama:latest`, ensures a container named `pan-llama3` is running, downloads the `llama3` model, and uses `docker exec pan-llama3 ollama run llama3` for subsequent prompts. Docker must be installed and running.
