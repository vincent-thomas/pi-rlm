import { afterEach, expect, test } from 'bun:test';
import type { AssistantMessage, Context } from '@earendil-works/pi-ai';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Runtime } from '../src/runtime.ts';
import { autonomyInstructions, childInstructions, createQuery, instructions, orchestrationInstructions } from '../src/rlm.ts';

const runtimes: Runtime[] = [];
function runtime(context = '') {
  const value = new Runtime(process.cwd(), context);
  runtimes.push(value);
  return value;
}
afterEach(() => { for (const item of runtimes.splice(0)) item.dispose(); });
const unused = async () => { throw new Error('Unexpected child call'); };
function response(content: AssistantMessage['content']): AssistantMessage {
  return { role: 'assistant', content, api: 'anthropic-messages', provider: 'anthropic', model: 'mock',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: content.some(x => x.type === 'toolCall') ? 'toolUse' : 'stop', timestamp: Date.now() };
}
test('JavaScript supports await, persistent state, context, and cwd-relative files', async () => {
  const repl = runtime('big document');
  expect((await repl.exec("state.n = await Promise.resolve(41); print(context); print((await readFile('package.json')).includes('pi-rlm'));", unused)).text).toBe('big document\ntrue\n');
  expect((await repl.exec('print(state.n + 1)', unused)).text).toBe('42\n');
});
test('errors are recoverable and output is capped', async () => {
  const repl = runtime();
  expect((await repl.exec('throw new Error("oops")', unused)).isError).toBe(true);
  const output = await repl.exec('print("x".repeat(100000));', unused);
  expect(output.text.length).toBeLessThan(16100);
  expect(output.text).toContain('truncated');
  expect((await repl.exec('print(42)', unused)).text).toBe('42\n');
});
test('timed-out workers terminate before replacement execution begins', async () => {
  const repl = runtime();
  const timedOut = repl.exec('state.x = 1; await Promise.resolve(); while (true) {}', unused, undefined, 150);
  await new Promise(resolve => setTimeout(resolve, 10));
  const oldWorker = (repl as any).worker;
  let oldWorkerExited = false;
  oldWorker.once('exit', () => { oldWorkerExited = true; });
  expect((await timedOut).text).toContain('timed out');

  let oldWorkerStopped = false;
  const replacement = await repl.exec('print(await llm_query("check")); print(typeof state.x)', async () => {
    oldWorkerStopped = oldWorkerExited;
    return 'ready';
  });
  expect(oldWorkerStopped).toBe(true);
  expect(replacement.text).toBe('ready\nundefined\n');
});
test('cancellation propagates to in-flight child requests', async () => {
  const repl = runtime();
  const controller = new AbortController();
  let childAborted = false;
  const result = repl.exec('return await llm_query("question")', async (_p, _c, signal) => {
    controller.abort();
    childAborted = signal.aborted;
    return 'unused';
  }, controller.signal);
  expect((await result).isError).toBe(true);
  expect(childAborted).toBe(true);
});
test('parallel child results are correlated correctly', async () => {
  const result = await runtime().exec('state.answers = await Promise.all([llm_query("a", "one"), llm_query("b", "two")]); print(state.answers.join(","))', async (p, c) => p + c);
  expect(result.text).toBe('aone,btwo\n');
});
test('child model tiers default to routine and explicit tiers are forwarded', async () => {
  const seen: string[] = [];
  const result = await runtime().exec(
    `print(await llm_query("localize", "one")); print(await llm_query("synthesize", "two", { model: "agi" }))`,
    async (_prompt, _context, _signal, options) => {
      seen.push(options?.model ?? 'missing');
      return options?.model ?? 'missing';
    },
  );
  expect(result.text).toBe('routine\nagi\n');
  expect(seen).toEqual(['routine', 'agi']);
});


test('verification retries the same conversation, runs every check sequentially, and returns only a verified answer', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'rlm-verification-'));
  try {
    let completions = 0;
    const query = createQuery(cwd, async ctx => {
      completions++;
      if (completions === 2) {
        const feedback = String(ctx.messages.at(-1)?.content);
        expect(feedback).toContain('Machine verification round 1/2 failed');
        expect(feedback).toContain('stdoutPath');
        expect(feedback).toContain('stderrPath');
        expect(feedback).not.toContain('ACTUAL');
        await writeFile(join(cwd, 'repaired'), 'yes');
      }
      return response([{ type: 'text', text: completions === 1 ? 'unverified' : 'verified' }]);
    });
    const result = await query('work', '', new AbortController().signal, { verification: {
      checks: ["printf '\\101\\103\\124\\125\\101\\114' >&2; test -f repaired", "printf x >> order"], maxAttempts: 2, timeoutMs: 1000,
    } });
    expect(result).toBe('verified');
    expect(completions).toBe(2);
    expect(await readFile(join(cwd, 'order'), 'utf8')).toBe('xx');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('verification repair gets a fresh model-turn allowance and full bounded check text', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'rlm-verification-turns-'));
  const longCheck = 'test -f repaired #' + 'x'.repeat(300);
  try {
    let calls = 0;
    const query = createQuery(cwd, async ctx => {
      calls++;
      if (calls < 3) return response([{ type: 'toolCall', id: String(calls), name: 'exec', arguments: { code: 'print(1)' } }]);
      if (calls === 4) {
        expect(String(ctx.messages.at(-1)?.content)).toContain(longCheck);
        await writeFile(join(cwd, 'repaired'), 'yes');
      }
      return response([{ type: 'text', text: calls === 3 ? 'first' : 'verified' }]);
    }, { remaining: 1 }, 0, 3);
    expect(await query('work', '', new AbortController().signal, { verification: {
      checks: [longCheck], maxAttempts: 2, timeoutMs: 1000,
    } })).toBe('verified');
    expect(calls).toBe(4);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('verification exhaustion rejects with statuses and evidence paths', async () => {
  const query = createQuery(process.cwd(), async () => response([{ type: 'text', text: 'never return me' }]));
  const failure = query('work', '', new AbortController().signal, { verification: {
    checks: ['exit 7'], maxAttempts: 2, timeoutMs: 1000,
  } });
  await expect(failure).rejects.toThrow(/verification failed after 2 rounds.*status.*7.*stdoutPath.*stderrPath/);
});

test('verification timeout and parent cancellation stop checks without retrying', async () => {
  let timeoutCalls = 0;
  const timed = createQuery(process.cwd(), async () => { timeoutCalls++; return response([{ type: 'text', text: 'x' }]); });
  await expect(timed('work', '', new AbortController().signal, { verification: {
    checks: ['sleep 2'], maxAttempts: 1, timeoutMs: 30,
  } })).rejects.toThrow(/status.*timeout.*stdoutPath.*stderrPath/);
  expect(timeoutCalls).toBe(1);

  let cancelCalls = 0;
  const controller = new AbortController();
  const cancelled = createQuery(process.cwd(), async () => {
    cancelCalls++;
    setTimeout(() => controller.abort(new DOMException('root deadline', 'AbortError')), 30);
    return response([{ type: 'text', text: 'x' }]);
  });
  await expect(cancelled('work', '', controller.signal, { verification: {
    checks: ['sleep 2'], maxAttempts: 3, timeoutMs: 1000,
  } })).rejects.toThrow();
  expect(cancelCalls).toBe(1);
});

test('verification options are validated and forwarded only when explicitly requested', async () => {
  const seen: any[] = [];
  const repl = runtime();
  const good = await repl.exec('print(await llm_query("x", "", { model: "smart", verification: { checks: ["true"], maxAttempts: 2, timeoutMs: 50 } }))',
    async (_prompt, _context, _signal, options) => { seen.push(options); return 'ok'; });
  expect(good.text).toBe('ok\n');
  expect(seen[0]).toEqual({ model: 'smart', verification: { checks: ['true'], maxAttempts: 2, timeoutMs: 50 } });
  for (const verification of [null, {}, { checks: [], maxAttempts: 1, timeoutMs: 1 }, { checks: [' '], maxAttempts: 1, timeoutMs: 1 }, { checks: ['true'], maxAttempts: 0, timeoutMs: 1 }, { checks: ['true'], maxAttempts: 1, timeoutMs: 1.5 }]) {
    const code = 'await llm_query("x", "", { verification: ' + JSON.stringify(verification) + ' })';
    expect((await repl.exec(code, unused)).isError).toBe(true);
  }
});

test('createQuery passes the requested tier to model completion', async () => {
  let seen = '';
  const query = createQuery(process.cwd(), async (ctx, _signal, tier) => {
    expect(ctx.systemPrompt).toContain(instructions);
    expect(ctx.systemPrompt).toContain(childInstructions);
    expect(ctx.systemPrompt).toContain('Own and complete the assigned scope');
    expect(ctx.systemPrompt).not.toContain(orchestrationInstructions);
    seen = tier;
    return response([{ type: 'text', text: 'done' }]);
  });
  expect(await query('verify', 'evidence', new AbortController().signal, { model: 'smart' })).toBe('done');
  expect(seen).toBe('smart');
});

test('child context stays outside the model prompt and can be inspected with exec', async () => {
  let count = 0;
  const query = createQuery(process.cwd(), async (ctx: Context) => {
    if (count++ === 0) {
      expect(JSON.stringify(ctx)).not.toContain('SECRET DOCUMENT');
      return response([{ type: 'toolCall', id: '1', name: 'exec', arguments: { code: 'print(context)' } }]);
    }
    expect(JSON.stringify(ctx.messages.at(-1))).toContain('SECRET DOCUMENT');
    return response([{ type: 'text', text: 'summary' }]);
  });
  expect(await query('summarize', 'SECRET DOCUMENT', new AbortController().signal)).toBe('summary');
});
test('children recursively invoke children with a shared call budget', async () => {
  let calls = 0;
  const query = createQuery(process.cwd(), async ctx => {
    calls++;
    if (ctx.messages.length > 1) return response([{ type: 'text', text: 'parent answer' }]);
    if (ctx.messages[0]?.content === 'nested') return response([{ type: 'text', text: 'child answer' }]);
    return response([{ type: 'toolCall', id: '1', name: 'exec', arguments: { code: 'print(await llm_query("nested", context))' } }]);
  }, { remaining: 2 });
  expect(await query('root', 'data', new AbortController().signal)).toBe('parent answer');
  expect(calls).toBe(3);
  await expect(query('again', '', new AbortController().signal)).rejects.toThrow('budget exhausted');
});
test('depth and model turn limits fail explicitly', async () => {
  const complete = async () => response([{ type: 'toolCall', id: '1', name: 'exec', arguments: { code: 'print(1)' } }]);
  await expect(createQuery(process.cwd(), complete, { remaining: 1 }, 2)('', '', new AbortController().signal)).rejects.toThrow('depth limit');
  await expect(createQuery(process.cwd(), complete, { remaining: 1 }, 0, 3)('', '', new AbortController().signal)).rejects.toThrow('3 model turns');
});

test('top-level policy enforces scarce-model delegation and context firewall', () => {
  expect(orchestrationInstructions).toContain('never the execution or inspection worker');
  expect(orchestrationInstructions).toContain('even when the action is trivial, quick, or easy');
  expect(orchestrationInstructions).toContain('Delegation overhead is not an exception');
  expect(orchestrationInstructions).toContain('must not use bash or readFile to inspect sources');
  expect(orchestrationInstructions).toContain('Never print whole files, diffs, logs, command output, or unbounded child answers');
  expect(orchestrationInstructions).toContain('delegate their consolidation to a cheap child');
  expect(orchestrationInstructions).toContain('A decision packet must be concise');
  expect(orchestrationInstructions).toContain('requires an independent delegated review by a child other than the implementer');
  expect(orchestrationInstructions).toContain('All deterministic checks must also be delegated');
  expect(orchestrationInstructions).toContain('it does not reopen sources to verify them directly');

  // Reject the former loopholes rather than merely adding stronger prose nearby.
  expect(orchestrationInstructions).not.toContain('Work directly only');
  expect(orchestrationInstructions).not.toContain('truly trivial action');
  expect(orchestrationInstructions).not.toContain('Check returned evidence against sources');
  expect(orchestrationInstructions).not.toContain('prefer a worker');
  expect(autonomyInstructions).toContain('through delegation, acceptance decisions, and concise synthesis');
  expect(autonomyInstructions).toContain('compact delegated evidence');
  expect(autonomyInstructions).not.toContain('This includes inspecting inputs');
  expect(autonomyInstructions).not.toContain('inspect, diagnose, act, and verify');
});

test('top-level policy rejects semantic variants of direct-work loopholes', () => {
  const forbidden = [
    /top[- ]level[\s\S]{0,120}(?:may|can|should)[\s\S]{0,80}(?:directly|itself|locally)[\s\S]{0,100}(?:inspect|implement|edit|debug|test|verif|review|check)/i,
    /(?:trivial|easy|quick|small)[\s\S]{0,100}(?:without delegat|do(?:ing)? it (?:directly|locally)|direct action)/i,
    /delegation overhead[\s\S]{0,80}(?:greater|exceed|too (?:high|large)|avoid|skip)/i,
    /top[- ]level[\s\S]{0,100}(?:check|verify)[\s\S]{0,60}(?:source|diff|log|test output)/i,
  ];
  for (const loophole of forbidden) expect(orchestrationInstructions).not.toMatch(loophole);
  expect(autonomyInstructions).not.toMatch(/authorization to (?:perform|do)[\s\S]{0,180}(?:inspect|implement|edit|debug|test|verify)/i);

  const normalized = orchestrationInstructions.toLowerCase();
  for (const work of ['inspection', 'implementation', 'debugging', 'test run', 'verification', 'deterministic check', 'review']) {
    expect(normalized).toContain(work);
  }
  expect(normalized).toMatch(/delegate every[\s\S]*even when[\s\S]*(?:trivial|easy)/);
});
test('worker policy preserves implementation and recursive autonomy without leaking details', () => {
  expect(childInstructions).toContain('inspect all needed repository files and artifacts');
  expect(childInstructions).toContain('edit and implement, debug, run tests and deterministic checks');
  expect(childInstructions).toContain('Recursively delegate separable work when useful');
  expect(childInstructions).toContain('Descendants receive the same worker authority');
  expect(childInstructions).toContain('never an unrequested data dump');
  expect(childInstructions).not.toContain('not the top-level model');
});

test('shipped delegation examples specify measurable output bounds', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const prompts = [instructions, readme].flatMap(text =>
    [...text.matchAll(/llm_query\(\s*(['"`])([\s\S]*?)\1\s*,/g)].map(match => match[2]!),
  );
  expect(prompts.length).toBeGreaterThanOrEqual(5);
  for (const prompt of prompts) {
    expect(prompt).toMatch(/(?:at most|maximum|no more than|<=)\s*(?:\d|one|two|three|four|five|six|seven|eight|nine|ten)/i);
  }
});
