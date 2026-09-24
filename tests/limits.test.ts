import { afterEach, expect, test } from 'bun:test';
import { readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { readLimits } from '../src/limits.ts';
import { Runtime } from '../src/runtime.ts';
import { createQuery } from '../src/rlm.ts';

const names = ['PI_RLM_EXEC_TIMEOUT_MS', 'PI_RLM_REQUEST_TIMEOUT_MS', 'PI_RLM_MAX_CALLS', 'PI_RLM_MAX_TURNS'];
const original = Object.fromEntries(names.map(name => [name, process.env[name]]));
const runtimes: Runtime[] = [];
afterEach(async () => {
  for (const name of names) {
    if (original[name] === undefined) delete process.env[name];
    else process.env[name] = original[name];
  }
  for (const runtime of runtimes.splice(0)) {
    runtime.dispose();
    if (runtime.resultsPath) await rm(dirname(runtime.resultsPath), { recursive: true, force: true });
  }
});
function runtime() { const r = new Runtime(process.cwd()); runtimes.push(r); return r; }
const unused = async () => { throw new Error('Unexpected query'); };
const answer = (): AssistantMessage => ({ role: 'assistant', content: [{ type: 'text', text: 'done' }],
  api: 'anthropic-messages', provider: 'anthropic', model: 'mock', stopReason: 'stop', timestamp: Date.now(),
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });

test('limits have workflow defaults and explicit opt-out', () => {
  for (const name of names) delete process.env[name];
  expect(readLimits()).toEqual({ execTimeoutMs: 1800000, requestTimeoutMs: 300000, maxCalls: 1000, maxTurns: 64 });
  process.env.PI_RLM_EXEC_TIMEOUT_MS = '0';
  process.env.PI_RLM_REQUEST_TIMEOUT_MS = '0';
  process.env.PI_RLM_MAX_CALLS = '2500';
  process.env.PI_RLM_MAX_TURNS = '128';
  expect(readLimits()).toEqual({ execTimeoutMs: 0, requestTimeoutMs: 0, maxCalls: 2500, maxTurns: 128 });
});

test('invalid limits fail explicitly rather than overflowing timers', () => {
  for (const name of names) delete process.env[name];
  for (const value of ['-1', 'NaN', '1.5', '', '2147483648']) {
    process.env.PI_RLM_EXEC_TIMEOUT_MS = value;
    expect(() => readLimits()).toThrow('PI_RLM_EXEC_TIMEOUT_MS');
  }
  delete process.env.PI_RLM_EXEC_TIMEOUT_MS;
  process.env.PI_RLM_MAX_CALLS = '0';
  expect(() => readLimits()).toThrow('PI_RLM_MAX_CALLS');
  delete process.env.PI_RLM_MAX_CALLS;
  for (const value of ['0', '1001']) {
    process.env.PI_RLM_MAX_TURNS = value;
    expect(() => readLimits()).toThrow('PI_RLM_MAX_TURNS');
  }
});

test('configured child turn limit is enforced', async () => {
  process.env.PI_RLM_MAX_TURNS = '2';
  let calls = 0;
  const query = createQuery(process.cwd(), async () => {
    calls++;
    return { ...answer(), content: [{ type: 'toolCall', id: String(calls), name: 'exec', arguments: { code: 'print(1)' } }], stopReason: 'toolUse' };
  });
  await expect(query('task', new AbortController().signal)).rejects.toThrow('exceeded 2 model turns');
  expect(calls).toBe(2);
});

test('disabled workflow deadline still permits cancellation', async () => {
  process.env.PI_RLM_EXEC_TIMEOUT_MS = '0';
  const controller = new AbortController();
  const r = runtime();
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const running = r.exec('await llm_query("wait")', async () => {
    started();
    return new Promise<string>(() => {});
  }, controller.signal);
  await ready;
  controller.abort();
  expect((await running).text).toContain('Execution aborted');
});

test('configured workflow deadline is applied', async () => {
  process.env.PI_RLM_EXEC_TIMEOUT_MS = '50';
  expect((await runtime().exec('while (true) {}', unused)).text).toContain('timed out');
});

test('completed child results survive worker timeout and can be recovered', async () => {
  const r = runtime();
  const first = await r.exec('state.answer = await llm_query("task: private context"); print(resultsPath)', async () => 'valuable answer');
  expect(first.isError).toBe(false);
  expect(first.text.trim()).toBe(r.resultsPath!);
  const record = JSON.parse((await readFile(r.resultsPath!, 'utf8')).trim());
  expect(record.result).toBe('valuable answer');
  expect(record.prompt).toBe('task: private context');
  expect(record).not.toHaveProperty('context');
  const stopped = await r.exec('while (true) {}', unused, undefined, 30);
  expect(stopped.text).toContain(r.resultsPath!);
  const recovered = await r.exec('print(typeof state.answer); print(await readFile(resultsPath))', unused);
  expect(recovered.text).toContain('undefined');
  expect(recovered.text).toContain('valuable answer');
});

test('parallel completed results produce separate valid journal records', async () => {
  const r = runtime();
  await r.exec('await Promise.all([llm_query("a"), llm_query("b")])', async p => p);
  const records = (await readFile(r.resultsPath!, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  expect(records.map(r => r.result).sort()).toEqual(['a', 'b']);
  expect(new Set(records.map(r => r.id)).size).toBe(2);
});

test('per-request timeout aborts providers even when they ignore the signal', async () => {
  process.env.PI_RLM_REQUEST_TIMEOUT_MS = '20';
  let requestSignal!: AbortSignal;
  const query = createQuery(process.cwd(), async (_ctx, signal) => {
    requestSignal = signal;
    return new Promise<AssistantMessage>(() => {});
  });
  await expect(query('task', new AbortController().signal)).rejects.toThrow('request timed out');
  expect(requestSignal.aborted).toBe(true);
});

test('disabled request timeout still propagates parent cancellation', async () => {
  process.env.PI_RLM_REQUEST_TIMEOUT_MS = '0';
  const controller = new AbortController();
  let requestSignal!: AbortSignal;
  const query = createQuery(process.cwd(), async (_ctx, signal) => {
    requestSignal = signal;
    controller.abort(new Error('user canceled'));
    return new Promise<AssistantMessage>(() => {});
  });
  await expect(query('task', controller.signal)).rejects.toThrow('user canceled');
  expect(requestSignal.aborted).toBe(true);
});

test('configured child budget is shared across calls', async () => {
  process.env.PI_RLM_MAX_CALLS = '1';
  const query = createQuery(process.cwd(), async () => answer());
  const signal = new AbortController().signal;
  expect(await query('one', signal)).toBe('done');
  await expect(query('two', signal)).rejects.toThrow('budget exhausted');
});

test('a workflow can catch a request timeout and continue', async () => {
  process.env.PI_RLM_REQUEST_TIMEOUT_MS = '20';
  let calls = 0;
  const query = createQuery(process.cwd(), async () => {
    if (++calls === 1) return new Promise<AssistantMessage>(() => {});
    return answer();
  });
  const result = await runtime().exec(
    'try { await llm_query("slow") } catch (e) { print(String(e)) } print(await llm_query("next"))', query);
  expect(result.isError).toBe(false);
  expect(result.text).toContain('request timed out');
  expect(result.text).toContain('done');
});
