# pi-rlm

A [pi](https://github.com/earendil-works/pi) extension that turns the agent into a [recursive language model](https://arxiv.org/abs/2512.24601): inspect large context in a JavaScript workspace, delegate focused questions to child models, and combine their answers.

## Run

Targets pi **0.85.1** (`@earendil-works` packages).

```sh
bun install
bun start
```

With pi already installed, run `pi -e ./index.ts`, or install this directory with `pi install /absolute/path/to/pi-rlm`. The package declares its extension in `package.json`.

The extension activates **only `exec`** when a session starts. It runs JavaScript, including top-level `await`. Child calls use pi's selected model, provider configuration, and authentication.

For ordinary coding requests, the injected execution policy tells the top-level model to inspect, implement, verify, commit, and push a task branch or prepare a pull request without asking permission for each routine step. Important branches retain a human merge gate: the agent may not merge a pull request or push directly to a default, main, release, production, protected, or similar branch without the human user's explicit instruction for that integration. Creating or updating a pull request is never itself merge authorization.

Tool calls display only the JavaScript source. Expand the tool view with **Ctrl+O** to see the result, including any execution error.

## Load context

In pi:

```text
/rlm-load path/to/large-document.txt
Find the main disagreements in the loaded context and cite relevant excerpts.
```

The file is loaded into `context` without inserting its contents into the model prompt. The path can contain spaces; pass it without quotes. Loading a file clears the previous workspace. You can also ask the model to read bounded file slices directly into `state`.

Example `exec` code:

```js
state.document = await readFile('large-document.txt', 40000, 0);
print(state.document.length);
print(state.document.slice(0, 1000));
```

A later cell can delegate selected chunks:

```js
state.answers = await Promise.all([
  llm_query('Extract claims and exact supporting quotes; do not infer.', state.document.slice(0, 20000), { model: 'routine' }),
  llm_query('Extract claims and exact supporting quotes; do not infer.', state.document.slice(20000, 40000), { model: 'routine' }),
]);
print(state.answers);
```

Each child has its own JavaScript workspace and receives the supplied text in `context`. It can inspect that text with `exec` and recursively delegate further. Only its final answer returns to the parent.

### Model tiers

The model selected in pi is the top-level **agi** tier. Configure optional lower tiers with exact model references:

```sh
export PI_RLM_ROUTINE_MODEL=provider/model-id
export PI_RLM_SMART_MODEL=provider/model-id
```

A requested `routine` tier falls back to `smart`, then to the selected agi model; `smart` falls back to agi. Configured models must be available and, when pi model scoping is active, included in that scope.

This is model guidance, not an automatic runtime router. Use deterministic code for counting, filtering, exact search, comparison, and formatting; keep small tasks local. Delegate only when expected gains in accuracy, context management, or useful parallelism outweigh setup, latency, and cost. Use routine for bounded semantic extraction or classification, smart for bounded multi-step reasoning, and agi directly for ambiguity, conflicting evidence, or consequential judgments—no routine attempt is required first. Children should solve their scope locally unless further delegation materially helps. Each delegation must specify the objective, scope, output format, evidence requirements, and stopping rule. Verify the evidence and escalate on conflicts or failed checks, rather than relying on self-reported confidence. For example, delegate bounded semantic extraction:

```js
const claims = await llm_query(
  'Extract reasons users distrust the proposed rollout from this excerpt only. Return a JSON array of { reason, quote } with exact supporting quotes; do not infer missing reasons. Stop after reviewing the excerpt; return [] if none are supported.',
  state.rolloutExcerpt,
  { model: 'routine' },
);
```

## JavaScript globals

| Global | Purpose |
| --- | --- |
| `context` | Text loaded with `/rlm-load`, or supplied by the parent |
| `state` | Persistent object shared between cells in this workspace |
| `resultsPath` | Completed child-result journal path, initially undefined; survives worker resets |
| `print(...)` | Explicitly send values to the model |
| `await bash(command)` | Run Bash; return only `{ exitCode, stdoutPath, stderrPath }` |
| `await readFile(path, len = 16000, offset = 0)` | Read a bounded UTF-8 slice; length and offset are in bytes |
| `await llm_query(prompt, contextText, { model })` | Query a child RLM using `routine`, `smart`, or `agi`; defaults to `routine` |

Use `state.name = value` to retain values. Local `let`, `const`, and `var` declarations are cell-local. Only `print()` emits values; cell return values are ignored. Execution errors are reported automatically. Await all asynchronous work before ending a cell. `console`, `fs`, `require`, and `cwd` are not exposed as REPL helpers.

## Command output

```js
state.run = await bash("rg TODO .");
print(state.run); // exit code and two absolute log paths

// Inspect only the desired slice, then explicitly show it.
state.chunk = await readFile(state.run.stdoutPath, 2000, 0);
print(state.chunk);
print(await readFile(state.run.stderrPath, 2000, 0));
```

Bash stdout and stderr stream directly into separate files in a private `pi-rlm-*` directory under the system temporary directory. No command output enters the model context automatically. Nonzero command exits are returned in `exitCode`; launch failures throw. Commands start in pi's working directory with its environment and `pipefail` enabled. Working-directory and environment changes inside one command do not persist to the next. Run foreground commands and await them.

Logs remain available after resets and child completion, until explicitly deleted or cleaned by the OS; the extension does not automatically delete them. `readFile` resolves relative paths from pi's working directory, accepts a maximum length of 1 MiB, and returns an empty string at EOF. Offsets and lengths are bytes, so splitting a multibyte UTF-8 character can produce a replacement character.

## Limits and lifecycle

- Two child levels; by default, 1,000 child calls shared across all descendants of each root `exec` (`PI_RLM_MAX_CALLS`).
- Eight model turns per child; at most 4096 output tokens per model response.
- Thirty-minute deadline per `exec`, including child calls; five-minute timeout per provider request. Both are configurable and can be disabled. Cancellation propagates to children. A worker allows even infinite loops after `await` to be terminated.
- Printed output is capped at 16,000 characters per cell. Large values can remain in `state`.
- `/rlm-reset` clears the workspace. Session changes, branch navigation, and reload also clear it. State is kept across ordinary turns and compaction, but is not saved to disk.
- Timeouts and cancellation discard workspace state; the original loaded `context` is restored in the replacement worker.

Bash runs with your user's permissions; the worker is **not a security sandbox**. On Unix, cancellation kills the active shell's process group. Processes that deliberately detach may survive, and filesystem or other external effects are not rolled back. Recursive requests incur the selected provider's normal usage and are bounded per `exec`, not per conversation. Child transcripts are not added to pi's main session history.

### Workflow configuration

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `PI_RLM_EXEC_TIMEOUT_MS` | `1800000` (30 min) | Whole-cell deadline, including all child work; `0` disables |
| `PI_RLM_REQUEST_TIMEOUT_MS` | `300000` (5 min) | Timeout for each child model response; `0` disables |
| `PI_RLM_MAX_CALLS` | `1000` | Positive child-call budget shared across descendants per root cell |

Settings are read from the process environment. Timeout values are integer milliseconds from 0 to 2147483647. Request timeouts abort the provider signal and return an error to the calling workspace; code may catch it and continue. Disabling deadlines does not disable user cancellation. Recursion depth and per-child turn/output limits remain unchanged.

### Recovering completed results

Each workspace journals successful child answers before returning them to JavaScript. The `resultsPath` global is initially undefined, then holds an absolute JSONL path in a private temporary directory. Records contain an ID, task prompt, requested model tier, answer, and completion timestamp—not the supplied context. Concurrent completions are serialized into separate records.

On timeout or cancellation, the error includes the journal path if available. A replacement worker in the same runtime can read `resultsPath` with `readFile(resultsPath)`. This is **not** automatic replay or a checkpoint of arbitrary `state`; in-memory state is still discarded. Journals remain on disk after reset/session changes, but the new session does not automatically rediscover them. Save the path if needed. Nested workspaces have their own journals.

Journals may contain sensitive prompts and answers. They are not automatically deleted and remain until explicitly removed or cleaned by the OS, like shell logs.

## Development

```sh
bun run check
```

Tests use fake model responses to exercise actual worker execution, state, recursive tool loops, bounded file reads, shell logs, output limits, cancellation, and budgets without paid model calls.

## Autonomous benchmark improvement (experimental)

When a user gives a measurable optimization target such as “improve this benchmark by at least 10%,” the top-level agent can start the `start_long_horizon` tool automatically. The user does not create a project, issue continuation prompts, or manage checkpoints.

The tool creates an isolated Git worktree and branch, then launches a detached supervisor. Each iteration starts a fresh Pi SDK session, asks it for one bounded change, runs the canonical verifier outside the model, and commits only a strict valid improvement. Regressions, correctness failures, edits to declared benchmark/correctness paths, and agent-created commits are reverted. The supervisor stops after independent verification reaches the target or its deadline/iteration budget expires.

Durable job state and logs live under `~/.pi/agent/rlm-jobs/<job-id>/`; accepted changes live on the reported `rlm/<job-id>` branch. If Pi remains open, the extension reports completion automatically. Otherwise it reports completed jobs when a session for the source repository next starts.

The verifier must be deterministic enough to compare runs and print exactly one JSON object:

```json
{"valid":true,"score":123.4,"summary":"tests passed"}
```

The feature currently assumes Git, Bun on `PATH`, configured Pi model credentials, and a maximize-style score. The detached supervisor survives the originating Pi session, but not a host reboot unless it is started again from its persisted state.
