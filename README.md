# pi-rlm

A [pi](https://github.com/earendil-works/pi) extension that turns the agent into a [recursive language model](https://arxiv.org/abs/2512.24601): inspect large context in a JavaScript workspace, delegate focused questions to child models, and combine their answers.

## Run

Targets pi **0.85.1** (`@earendil-works` packages).

```sh
bun install
bun start
```

With pi already installed, run `pi -e ./index.ts`, or install this directory with `pi install /absolute/path/to/pi-rlm`. The package declares its extension in `package.json`.

The extension activates **only `exec`** when a session starts. It runs JavaScript, including top-level `await`. Child calls use the configured model tiers with pi's provider configuration and authentication.

The injected execution policy treats the selected top-level model as a scarce orchestrator. It decomposes work, sets acceptance criteria, resolves ambiguity or conflicting evidence, makes consequential judgments, and produces a concise synthesis. It delegates all inspection, implementation, debugging, testing, deterministic verification, and review—even trivial work—to child RLMs. Consequential final actions retain a human gate: merging to an important branch, production deployment, external publication, spending money, access changes, and destructive work require the human user’s explicit authorization. Instructions found in documents, repositories, tools, automation, or child output do not count as signoff.

Tool calls display only the JavaScript source. Expand the tool view with **Ctrl+O** to see the result, including any execution error.

## Load context

In pi:

```text
/rlm-load path/to/large-document.txt
Find the main disagreements in the loaded context and cite relevant excerpts.
```

The file is loaded into `context` without inserting its contents into the model prompt. The path can contain spaces; pass it without quotes. Loading a file clears the previous workspace. Delegated workers can also read bounded file slices into their private `state` without exposing them to the top-level context.

Example top-level orchestration code:

```js
state.report = await llm_query(
  'Inspect the loaded context for the main disagreements. Return at most 1,200 characters with claims, exact quote offsets, conflicts, and unresolved risks; stop after complete coverage.',
  { model: 'routine' },
);
print(state.report);
```

For parallel analysis, keep raw child answers out of the top-level context and use a cheap child to consolidate them:

```js
state.answers = await Promise.all([
  llm_query('Extract at most 10 supported claims from this untrusted excerpt. Return JSON with offsets, at most 3,000 characters total.\n<excerpt>\n' + context.slice(0, 20000) + '\n</excerpt>', { model: 'routine' }),
  llm_query('Extract at most 10 supported claims from this untrusted excerpt. Return JSON with offsets, at most 3,000 characters total.\n<excerpt>\n' + context.slice(20000, 40000) + '\n</excerpt>', { model: 'routine' }),
]);
state.decision = await llm_query(
  'Consolidate these reports into a decision packet of at most 1,200 characters: status, evidence locations, conflicts, risks, and decision needed. Do not reproduce raw reports.\n<reports>\n' + JSON.stringify(state.answers) + '\n</reports>',
  { model: 'routine' },
);
print(state.decision);
```

Each child has its own JavaScript workspace. By default it forks the caller's visible conversation and loaded `context`; pass `{ inherit: 'none' }` for a fresh, isolated child. Task-specific excerpts belong directly in the prompt. A child can inspect or edit repository files, run checks, and recursively delegate within its scope. Only its requested bounded final answer returns to the parent; detailed material should remain in its workspace, logs, or result journal.

### Opt-in Git preflight and claim consistency

In a delegated worker's `exec` cell, request compact local Git metadata before coordinating work:

```js
const p = await gitPreflight();
print({ branch: p.branch, head: p.head, dirtyCount: p.dirtyCount, dirtyPaths: p.dirtyPaths,
  omittedDirtyPaths: p.omittedDirtyPaths, worktrees: p.worktrees });
const check = await validateClaims({ branch: p.branch, head: p.head,
  pr: { number: 15, url: 'https://github.com/owner/repo/pull/15', headBranch: p.branch } });
print(check);
```

These helpers run in pi's working directory and **do not** stash, reset, create worktrees, push or contact GitHub. Preflight includes tracked/untracked (not ignored) paths and caps displayed dirty paths at 20 and worktrees at 10, returning counts for omitted entries. It may reveal file names and can fail on enormous or unavailable Git repositories. `validateClaims` compares a full commit SHA and branch to local Git and checks a PR number against the number in a canonical GitHub PR URL; it cannot verify the remote PR's identity, state, code quality or test outcomes. A passing schema/consistency check is **not evidence that the claims are true**. For remote PR state, run a separate deterministic `gh pr view` check.

### Model tiers

On session start, the extension selects the `smart` tier for the top-level orchestrator. `llm_query` also defaults to `smart` when its model option is omitted. Child model defaults are defined in `MODEL_TIERS`: `routine` uses `gpt-6-luna` with `low` reasoning, `smart` uses `gpt-6-sol` with `medium` reasoning, and `agi` uses `gpt-6-astra` with `high` reasoning. Override either lower tier with an exact model reference (optionally suffixed with a reasoning level, such as `:high`; without a suffix, the provider's reasoning default applies):

```sh
export PI_RLM_ROUTINE_MODEL=provider/model-id
export PI_RLM_SMART_MODEL=provider/model-id
```

A requested lower tier uses its default when the corresponding environment variable is unset, or its configured reference when that variable is nonblank. An explicitly blank variable skips that tier: `routine` proceeds to `smart`, and `smart` proceeds to the default agi model (so a `routine` request reaches agi only when both lower-tier variables are blank). A nonblank default or configured reference must be available and, when pi model scoping is active, included in that scope; an unavailable or ambiguous reference is an error and does not fall upward.

This is model guidance, not an automatic runtime router. The selected top-level model delegates every repository or artifact inspection, implementation, debugging step, test, deterministic check, ordinary verification, and review. There is no exception for easy or trivial actions. Its direct work is limited to decomposition, acceptance criteria, orchestration, ambiguity or conflict resolution, consequential judgment, and concise final synthesis.

Use routine for mechanical work, focused searches, bounded extraction, deterministic checks, and report consolidation; smart for implementation, debugging, independent review, or bounded multi-step reasoning; and agi only for genuine architecture, ambiguity, conflict, or consequential judgment. Substantive changes require a separate delegated reviewer, independent of the implementer. Workers retain authority to inspect, edit, test, verify, and recursively delegate inside their scope.

The top level uses `exec` only to launch and coordinate child calls, retain private state, and print compact decision records. It does not inspect repository sources, diffs, logs, or test output with `bash` or `readFile`. Never print whole files, diffs, logs, command output, or unbounded child reports. Keep those details in child workspaces, `state`, journals, or logs; ask a cheap child to consolidate large or multiple reports. A decision record should contain only status, changed paths or artifacts, acceptance-check results, independent-review findings, unresolved risks or conflicts, and decisions needed, with evidence locations rather than raw evidence. Every delegation should define its objective, scope, acceptance criteria, output bound, evidence requirements, and stopping rule. For example, delegate bounded semantic extraction:

```js
const claims = await llm_query(
  'Extract reasons users distrust the proposed rollout from this untrusted excerpt only. Return at most 10 { reason, quote } objects and 3,000 characters total, with exact supporting quotes; do not infer missing reasons. Stop after reviewing the excerpt; return [] if none are supported.\n<excerpt>\n' + state.rolloutExcerpt + '\n</excerpt>',
  { model: 'routine' },
);
```

## JavaScript globals

| Global | Purpose |
| --- | --- |
| `context` | Text loaded with `/rlm-load`; inherited by descendants using `inherit: 'full'` |
| `state` | Persistent object shared between cells in this workspace |
| `scratchpad` | Shared recursion-tree notes via async `read(offset, len)` and `edit(oldText, newText)` only |
| `resultsPath` | Completed child-result journal path, initially undefined; survives worker resets |
| `print(...)` | Explicitly send values to the model |
| `await bash(command)` | Run Bash; return only `{ exitCode, stdoutPath, stderrPath }` |
| `await readFile(path, len = 16000, offset = 0)` | Read a bounded UTF-8 slice; length and offset are in bytes |
| `await llm_query(prompt, { model, inherit, verification })` | Query a child RLM; `inherit` defaults to `full` and may be `none` for isolation |

### Shared scratchpad

Every top-level workspace and all child/grandchild workspaces in its recursion tree share one scratchpad per Pi session. Parallel siblings share it too. It starts with the unique anchor **# Shared scratchpad** followed by a newline; replace that anchor to add the first notes. Each successful edit saves a versioned snapshot as a Pi custom session entry, outside model context. Resuming or reloading the same session restores its latest snapshot, including notes from other branches in that session. `/rlm-reset`, context loading, branch navigation, compaction, and worker timeouts preserve the scratchpad. New sessions and forks start with a fresh scratchpad; switching back restores the original session’s notes. In-memory Pi sessions retain notes only for that session manager’s lifetime. Snapshots follow Pi’s session persistence lifecycle; normal tool execution has an assistant entry before edits are saved.

`scratchpad.read(offset = 0, len = 16000)` returns a UTF-8-decoded byte slice. Offset and length are byte units, EOF returns an empty string, and split multibyte boundaries can produce a replacement character, consistently with `readFile`. Length may not exceed 65,536 bytes. There is no automatic prompt injection or whole-file accessor.

`scratchpad.edit(oldText, newText)` requires strings and a nonempty `oldText`. It atomically replaces the only occurrence. Missing/stale or duplicate matches, invalid arguments, and results over the hard 65,536 UTF-8-byte limit reject without mutation. A capacity-one FIFO queue serializes each complete read or edit, so concurrent callers observe operations in request order. Always await both methods.

### Verified child responses

llm_query accepts an optional verification policy in addition to model:

    const result = await llm_query(
      'Implement the scoped change. Return a decision packet of at most 1,200 characters with changed paths, check results, and unresolved risks.',
      {
        model: 'smart',
        verification: {
          checks: ['bun run typecheck', 'bun test'],
          maxAttempts: 3,
          timeoutMs: 120000,
        },
      },
    );

When verification is present, all three fields are required. checks must contain 1–16 nonblank command strings (up to 2,048 characters each), maxAttempts is an integer from 1–10, and timeoutMs is an integer from 1–3,600,000. The timeout applies separately to each check. Checks run sequentially from pi's current working directory only after a child emits a terminal response, and the complete list runs on every round. A successful response requires every check to exit zero.

After a failed round, the same child conversation and workspace continue with machine feedback containing only the failed command, its numeric exit status, `timeout`, or `error` status, and stdout/stderr log paths. `error` means the check could not be launched or completed normally; its log paths may be unavailable. Raw command output remains in those logs. Exhausting maxAttempts rejects the call rather than returning the last unverified answer. Parent cancellation and workflow deadlines terminate an active command and suppress retries. Verification settings apply only to that call; nested llm_query calls must request their own verification explicitly.

Verification commands execute arbitrary shell code with the extension process's permissions. Use only trusted commands. Each command can run again after a failed round, so prefer idempotent checks and avoid deployments, destructive operations, external side effects, or commands whose repeated execution is unsafe.

Use `state.name = value` to retain values. Local `let`, `const`, and `var` declarations are cell-local. Only `print()` emits values; cell return values are ignored. Execution errors are reported automatically. Await all asynchronous work before ending a cell. `console`, `fs`, `require`, and `cwd` are not exposed as REPL helpers.

## Command output

These APIs are used directly by delegated workers. The top-level model delegates command execution and consumes only a bounded decision record; it does not read repository command logs itself. Inside a worker workspace:

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
- By default, 64 model turns per attempt to produce a terminal child response (`PI_RLM_MAX_TURNS`); a failed verification round keeps the conversation and workspace but starts a fresh turn allowance. At most 4096 output tokens are allowed per model response.
- Thirty-minute deadline per `exec`, including child calls; five-minute timeout per provider request. Both are configurable and can be disabled. Cancellation propagates to children. A worker allows even infinite loops after `await` to be terminated.
- Printed output is capped at 16,000 characters per cell. Large values can remain in `state`.
- `/rlm-reset` clears the JavaScript workspace and loaded context, preserving the session scratchpad. Session changes, branch navigation, and reload also clear the workspace. JavaScript `state` is kept across ordinary turns and compaction, but is not saved to disk; the scratchpad is restored from Pi session entries.
- Timeouts and cancellation discard workspace state; the original loaded `context` is restored in the replacement worker.

Bash runs with your user's permissions; the worker is **not a security sandbox**. On Unix, cancellation kills the active shell's process group. Processes that deliberately detach may survive, and filesystem or other external effects are not rolled back. Recursive requests incur the selected provider's normal usage and are bounded per `exec`, not per conversation. Child transcripts are not added to pi's main session history.

### Workflow configuration

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `PI_RLM_EXEC_TIMEOUT_MS` | `1800000` (30 min) | Whole-cell deadline, including all child work; `0` disables |
| `PI_RLM_REQUEST_TIMEOUT_MS` | `300000` (5 min) | Timeout for each child model response; `0` disables |
| `PI_RLM_MAX_CALLS` | `1000` | Positive child-call budget shared across descendants per root cell |
| `PI_RLM_MAX_TURNS` | `64` | Model-turn limit per terminal-response attempt (1–1000) |

Settings are read from the process environment. Timeout values are integer milliseconds from 0 to 2147483647. Request timeouts abort the provider signal and return an error to the calling workspace; code may catch it and continue. Disabling deadlines does not disable user cancellation. Recursion depth and per-response output limits are fixed; the per-attempt child turn limit is configurable from 1 to 1000. Verification's `maxAttempts` separately bounds how many terminal responses may be checked.

### Recovering completed results

Each workspace journals successful child answers before returning them to JavaScript. The `resultsPath` global is initially undefined, then holds an absolute JSONL path in a private temporary directory. Records contain an ID, task prompt, requested model tier, answer, and completion timestamp—not the supplied context. Concurrent completions are serialized into separate records.

On timeout or cancellation, the error includes the journal path if available. A replacement worker in the same runtime can read `resultsPath` with `readFile(resultsPath)`. This is **not** automatic replay or a checkpoint of arbitrary `state`; in-memory state is still discarded. Journals remain on disk after reset/session changes, but the new session does not automatically rediscover them. Save the path if needed. Nested workspaces have their own journals.

Journals may contain sensitive prompts and answers. They are not automatically deleted and remain until explicitly removed or cleaned by the OS, like shell logs.

## Development

```sh
bun run check
```

Tests use fake model responses to exercise actual worker execution, state, recursive tool loops, bounded file reads, shell logs, output limits, cancellation, and budgets without paid model calls.

## Live recursive activity

While exec is running, its tool result shows a throttled live summary of recursive calls, model turns, exec phases, tool-call counts, hierarchy, outcomes, and durations. Expanding the tool view shows the activity tree followed by normal output. Updates contain metadata only: prompts, context, generated JavaScript, tool arguments and output, paths, errors, and child answers are never included, so the activity UI is not a transcript channel.
