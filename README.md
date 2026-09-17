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

Use routine for tightly specified summarization, localization, extraction, classification, formatting, and simple evidence checks. Tell it the exact scope, desired output, and what not to infer. Use smart for bounded multi-step analysis. Use agi freely where stronger judgment helps, while staying token-economical by sending high-volume retrieval to routine. For example, routine can locate CI errors and return nearby lines, then agi can diagnose the cause and propose the fix:

```js
const passages = await llm_query(
  'Locate discussion of retries. Return exact quotes and offsets; do not synthesize.',
  context,
  { model: 'routine' },
);
```

## JavaScript globals

| Global | Purpose |
| --- | --- |
| `context` | Text loaded with `/rlm-load`, or supplied by the parent |
| `state` | Persistent object shared between cells in this workspace |
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

- Two child levels; 12 child calls shared across all descendants of each root `exec`.
- Eight model turns per child; at most 4096 output tokens per model response.
- Two-minute deadline per `exec`, including child calls. Cancellation propagates to children. A worker allows even infinite loops after `await` to be terminated.
- Printed output is capped at 16,000 characters per cell. Large values can remain in `state`.
- `/rlm-reset` clears the workspace. Session changes, branch navigation, and reload also clear it. State is kept across ordinary turns and compaction, but is not saved to disk.
- Timeouts and cancellation discard workspace state; the original loaded `context` is restored in the replacement worker.

Bash runs with your user's permissions; the worker is **not a security sandbox**. On Unix, cancellation kills the active shell's process group. Processes that deliberately detach may survive, and filesystem or other external effects are not rolled back. Recursive requests incur the selected provider's normal usage and are bounded per `exec`, not per conversation. Child transcripts are not added to pi's main session history.

## Development

```sh
bun run check
```

Tests use fake model responses to exercise actual worker execution, state, recursive tool loops, bounded file reads, shell logs, output limits, cancellation, and budgets without paid model calls.
