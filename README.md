# 🐐 Pan — the monorepo shepherd (son of Hermes)

**Pan** is an opinionated, interactive CLI that:

- refuses pushing main/master
- enforces branch naming: `${USER}/{ci,docs,feat,fix,perf,refactor,style}/${MESSAGE}`
- always rebases from origin/master (fallback origin/main) before push
- builds only the Yarn workspaces that changed and runs the relevant test suites
- auto-remediates build failures (cache clean, migrations, Prisma, Docker, user scripts)
- adds/commits/pushes only when the index is clean and logs every step verbosely
- stashes dirty worktrees before rebasing and restores them safely afterwards

## 🏛️ Why “Pan”?

In Greek mythology, **Pan** is the **son of Hermes** (messenger god). Pan is a **shepherd** who brings order to scattered flocks and a musician who creates **harmony** from many pipes. Your monorepo is a wild landscape; Pan guides it from **panic** to push—shepherding packages, harmonizing builds and checks, and safely delivering (pushing) changes.

## Installation

### Summary

| Platform | Install Command |
|-----------|-----------------|
| Local clone | `npm install && npm run build && npm link` |
| macOS | `brew tap pan-cli/pan && brew install pan` |
| Debian / Ubuntu | `sudo apt install ./pan_*.deb` |
| Fedora / RHEL | `sudo rpm -i pan-*.rpm` |
| Windows | `npm install && npm run build && npm link` |

### 1. Install (from source)

```sh
npm i -g pan
```

### 2. Local installation (development or direct clone)

If you cloned this repo directly and want to run **Pan** locally:

```sh
# 1. Install dependencies
npm install

# 2. Build the TypeScript source
npm run build

# 3. Link Pan globally so you can call `pan` anywhere
npm link
```

You can now run Pan globally:

```sh
pan --version
pan diagnose
pan push
```

To undo the global link later:

```sh
npm unlink -g pan
```

Or run it without linking:

```sh
# run directly from source
npx tsx src/cli.ts push
# or use the built binary
./bin/pan diagnose
```

---

### 🍎 3. macOS (Homebrew Tap)

Homebrew tap is live:

```sh
brew tap pan-cli/pan
brew install pan
```

To upgrade later:

```sh
brew update
brew upgrade pan
```

---

### 🐧 4. Linux (APT or YUM / DNF)

.deb and .rpm packages are available via GitHub Releases, you can install Pan using your system package manager.

#### Debian / Ubuntu (.deb)

```sh
wget https://github.com/pan-cli/pan/releases/latest/download/pan_0.1.0_amd64.deb
sudo apt install ./pan_0.1.0_amd64.deb
```

#### Fedora / RHEL / Amazon Linux (.rpm)

```sh
wget https://github.com/pan-cli/pan/releases/latest/download/pan-0.1.0.x86_64.rpm
sudo rpm -i pan-0.1.0.x86_64.rpm
```

#### Verify

```sh
pan --version
pan diagnose
```

---

### 🤕 5. Windows

Windows users can clone and run using Node.js:

```powershell
git clone https://github.com/pan-cli/pan.git
cd pan
npm install
npm run build
npm link
pan diagnose
```

---

## Usage

```sh
pan push       # full policy flow: branch → rebase → fix → checks → commit → push
pan diagnose   # quick checks (build/typecheck/lint) with a summarized failure report
pan fix        # smart remediation for build
pan prepush    # lint --fix, type-check, targeted tests, dirty-index-check
pan chat       # contextual LLM session; Pan runs suggested commands with you in loop
pan toolkit    # show alias catalog and quick installers (init/install)
pan help       # detailed usage guide and environment knobs

```

Add `--verbose` to `diagnose`, `fix`, `prepush`, or `push` to stream command errors inline as they occur.

### 🤖 Automating `pan push`

Pan accepts optional flags so automations can answer the interactive prompts ahead of time:

- `--branch-prefix <prefix>` — pick one of `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, or `style`.
- `--branch-name <name>` — provide the slug that follows the prefix (Pan sanitizes it for you).
- `--commit-first-line <subject>` — supply the commit subject when Pan needs to create a commit.
- `--commit-body <body>` — optional commit body passed as an additional `git commit -m` argument.
- `--answers <file>` — load a JSON/YAML file that pre-populates any of the above (file values take priority; flags fill in the gaps).

Omitted flags fall back to the usual interactive questions, so you can mix scripted and manual flows. Example automation:

```sh
pan push \
  --branch-prefix docs \
  --branch-name agent-guide \
  --commit-first-line "docs: refresh agent guide" \
  --commit-body "Explain the new non-interactive flags for future agents."
```

Prefer a declarative setup? Drop the answers into a file and point `pan push` at it:

```yaml
# pan-push.answers.yaml
push:
  branch:
    prefix: docs
    name: agent-guide
  commit:
    firstLine: "docs: refresh agent guide"
    body: |
      Explain the new non-interactive flags for future agents.
```

```sh
pan push --answers pan-push.answers.yaml
```

Set the environment variable `PAN_DOCKER_DEV_CMD` to a custom remediation command if your monorepo relies on starting local Docker services during the build (optional).

Pan inspects `yarn workspaces list`, `git status`, and package.json scripts to determine which builds/tests to run. When a build fails, Pan tries the best repair scripts it can find (e.g., `yarn cache clean`, `npx prisma generate`, workspace `migrate`/`fix:*` scripts) before retrying targeted builds.

### 📝 Commit message providers

During `pan push`, Pan now collects branch metadata, the staged diff, and a log of remediation commands. If an assistant is available (`PAN_ASSISTANT_MODE=openai` with an API key or `PAN_ASSISTANT_MODE=local` with a shell command), that context seeds a suggested message which opens in `vi` for review. Without an assistant, the same template opens in `vi` so you can craft the commit manually.

You can still steer the flow:

- **Static message** — set `PAN_COMMIT_MESSAGE_TEXT="subject\n\nbody"` to skip the assistant/editor entirely (useful for CI or scripted pushes).
- **Custom editor** — provide `PAN_COMMIT_MESSAGE_EDITOR` (for example `code --wait`) or `PAN_COMMIT_MESSAGE_USE_EDITOR=1` to launch something other than `vi`. On Windows Pan falls back to `notepad` by default.
- **Prompt only** — export `PAN_NO_COMMIT_EDITOR=1` to skip the editor and answer an inline prompt instead.

All modes honour `--commit-first-line` / `--commit-body`; provided values override both assistant suggestions and templates. The editor file mirrors Git’s `COMMIT_EDITMSG` layout (subject, blank line, body) followed by comment-prefixed context (changed files, diffstat, automated steps). Comment lines beginning with `#` are stripped before committing.

### Toolkit aliases

Pan ships a handful of remediation shortcuts (for example `ycc` → `yarn cache clean` and `yi` → `yarn install`).

- Preferred: `pan toolkit install` — appends the alias block to your shell profile (Pan detects `~/.zshrc` / `~/.bashrc`; override with `--profile`).
- Quick session: run `eval "$(pan toolkit init)"` in your terminal to enable aliases immediately.
- `pan toolkit` prints the alias catalog and reminds you of both setup options.

All remediation commands now live in a single registry (`src/lib/commands.ts`), so the same aliases power `pan fix`, `pan push`, the toolkit output, and the recorded command log. Updating the registry automatically updates every flow.

## 🧠 AI Integration

Set the environment variable `LLM_COMMAND` to any shell command that reads a prompt from STDIN and prints a text suggestion.  
Examples:

```sh
export LLM_COMMAND="ollama run llama3"
# or
export LLM_COMMAND="lmstudio generate --model 'MyLocalModel'"
```

### LLM Escalation (last resort)

When every automated remediation fails, Pan opens a terminal chat with ChatGPT (`gpt-5-codex`) or a local LLM, automatically runs any commands it suggests, and reports the outcome back into the same conversation. You can jump in at any point to add clarifications or stop the loop.

- `PAN_CHATGPT_ENABLED` (default: `1`): set to `0` to disable the escalation entirely.
- `PAN_OPENAI_API_KEY` / `OPENAI_API_KEY`: supply your ChatGPT account key so the session uses your history and permissions.
- `PAN_CHATGPT_CONFIRM` (default: `1`): set to `0` to skip the initial confirmation prompt.
- `PAN_CHATGPT_MODEL` (default: `gpt-5-codex`): override the model if you prefer a different variant.
- `PAN_CHATGPT_BASE_URL` (default: `https://api.openai.com/v1`): point to a proxy or Azure OpenAI endpoint.
- `PAN_CHATGPT_TIMEOUT_MS`, `PAN_CHATGPT_MAX_TOKENS`, and `PAN_CHATGPT_MAX_ROUNDS` control request/runtime limits.
- `PAN_ASSISTANT_MODE` can be set to `openai` (default) or `local` to use a shell-accessible LLM command instead of ChatGPT; configure `PAN_LOCAL_LLM_COMMAND`, `PAN_LLM_COMMAND`, or `LLM_COMMAND` (e.g., `ollama run llama3`).

Pan prints the shared log paths and echoes the chat transcript (`[pan]`, `[chatgpt]`, `[you]`) so you can monitor or intervene before the next command runs.

Example (local LLM via Ollama):

```sh
export PAN_ASSISTANT_MODE=local
export PAN_LOCAL_LLM_COMMAND="ollama run llama3"
pan chat
```

If you leave the command blank when prompted, Pan can bootstrap a Docker-based setup automatically (defaults to the `ollama/ollama:latest` image, container name `pan-llama3`, and model `llama3`). Ensure Docker is running and you have permission to pull images before selecting the auto-setup option.

> Note: When using ChatGPT, Pan relies on OpenAI's authenticated API. There is currently no supported browser-login handoff or device-auth flow for external CLIs, so an API key (or compatible proxy token) is required unless you switch to `PAN_ASSISTANT_MODE=local` with a shell-accessible LLM command.

---

## Testing

Pan ships with a Vitest suite that exercises both focused units and higher-level push-flow contracts.

- **Quick sweep:** `yarn test` runs the entire suite (unit + service contracts) in a single pass.
- **Targeted runs:**
  - `yarn test:unit` limits execution to `tests/unit/**`.
  - `yarn test:integration` drives the end-to-end push harness, including macOS TextEdit simulations and prompt automation.
- **Watch mode:** `yarn test:watch` keeps Vitest running while you iterate.

Service-level specs in `tests/service/pushFlow.test.ts` rely on the shared harness in `tests/service/pushHarness.ts`, which mocks shell commands (`run`), Git plumbing, remediation (`smartBuildFix`), and pre-push checks. Reset the harness with `resetPushMockState()` before each scenario to isolate state.

Integration specs in `tests/integration/panPushNonInteractive.test.ts` spawn the real CLI with a temp Git repository. The harness listens for prompt text and feeds replies as soon as they appear, making the tests deterministic without sleep-based timers. To exercise the editor path in CI, the suite points `PAN_COMMIT_MESSAGE_EDITOR` at a tiny Node script that writes the commit message to the temp file—no macOS GUI required.

When adding new behaviors to the push workflow, prefer extending the service tests to cover success and failure paths, then layer in unit tests for pure helpers. The harness records dispatched operations, making it easy to assert that Pan staged, committed, pushed, or halted at the right boundaries.

## 🤝 Contributing

PRs welcome — help Pan shepherd more monorepos from chaos to calm 🐐.
