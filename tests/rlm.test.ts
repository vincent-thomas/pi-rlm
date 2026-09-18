import { afterEach, expect, test } from 'bun:test';
import type { AssistantMessage, Context } from '@earendil-works/pi-ai';
import { Runtime } from '../src/runtime.ts';
import { childInstructions, createQuery, instructions, orchestrationInstructions } from '../src/rlm.ts';

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
  await expect(createQuery(process.cwd(), complete)('', '', new AbortController().signal)).rejects.toThrow('8 model turns');
});

test('routing guidance preserves top-tier attention through delegation', () => {
  expect(orchestrationInstructions).toContain('not as the default worker');
  expect(orchestrationInstructions).toContain('minimizing top-level context is a benefit in itself');
  expect(orchestrationInstructions).toContain('mechanical changes');
  expect(orchestrationInstructions).toContain('worker followed by an independent reviewer');
  expect(orchestrationInstructions).toContain('Do not equate a task being easy');
  expect(orchestrationInstructions).toContain('evidence requirements, and stopping rule');
  expect(orchestrationInstructions).toContain('Check returned evidence against sources');
  expect(childInstructions).toContain('Use deterministic JavaScript or shell commands');
  expect(childInstructions).toContain('Own and complete the assigned scope');
  expect(childInstructions).toContain('do not re-delegate merely because the work is semantic');
});
