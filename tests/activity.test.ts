import { expect, test } from 'bun:test';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { ActivityPublisher, ActivityUpdateSink, emptyActivitySnapshot, reduceActivity } from '../src/activity.ts';
import { formatActivity } from '../src/render-activity.ts';
import { createQuery } from '../src/rlm.ts';

function response(content: AssistantMessage['content']): AssistantMessage {
  return { role: 'assistant', content, api: 'anthropic-messages', provider: 'anthropic', model: 'mock', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: content.some(x => x.type === 'toolCall') ? 'toolUse' : 'stop', timestamp: 0 };
}
function setup(retention = 100) { let time = 0, n = 0; const history: any[] = []; const value = new ActivityPublisher(s => history.push(s), { terminalRetention: retention, now: () => ++time, id: () => 'id-' + ++n }); return { value, history }; }

test('lifecycle counts turns and tools and publishes one sanitized terminal snapshot', async () => {
  const { value, history } = setup(); let n = 0;
  const query = createQuery(process.cwd(), async () => ++n === 1 ? response([{ type: 'toolCall', id: 't', name: 'exec', arguments: { code: 'print(1)' } }]) : response([{ type: 'text', text: 'done' }]), { remaining: 1 }, 0, 3, { reporter: value });
  expect(await query('PROMPT_SENTINEL', new AbortController().signal)).toBe('done');
  expect(value.snapshot().calls[0]).toMatchObject({ depth: 1, turn: 2, toolCallCount: 1, phase: 'model', status: 'succeeded' });
  expect(value.snapshot().totals).toMatchObject({ calls: 1, active: 0, succeeded: 1, modelTurns: 2, toolCalls: 1 });
  expect(history.flatMap(s => s.calls).filter((c: any) => c.status !== 'active')).toHaveLength(1);
  expect(JSON.stringify(history)).not.toMatch(/SENTINEL/);
});

test('verification is represented as live activity', async () => {
  const { value, history } = setup();
  const query = createQuery(process.cwd(), async () => response([{ type: 'text', text: 'done' }]), { remaining: 1 }, 0, 2, { reporter: value });
  expect(await query('work', new AbortController().signal, { verification: { checks: ['true'], maxAttempts: 1, timeoutMs: 1000 } })).toBe('done');
  expect(history.flatMap(snapshot => snapshot.calls).some(call => call.phase === 'verification' && call.verificationRound === 1)).toBe(true);
  expect(value.snapshot().calls[0]).toMatchObject({ status: 'succeeded', verificationRound: 1 });
});

test('recursion inherits reporter and parent relationship', async () => {
  const { value } = setup();
  const query = createQuery(process.cwd(), async ctx => {
    if (ctx.messages.at(-1)?.content === 'nested') return response([{ type: 'text', text: 'child' }]);
    if (ctx.messages.length > 1) return response([{ type: 'text', text: 'parent' }]);
    return response([{ type: 'toolCall', id: 't', name: 'exec', arguments: { code: 'print(await llm_query("nested"))' } }]);
  }, { remaining: 2 }, 0, 3, { reporter: value });
  await query('root', new AbortController().signal, { verification: { checks: ['true'], maxAttempts: 1, timeoutMs: 1000 } });
  const [parent, child] = value.snapshot().calls;
  expect(parent).toMatchObject({ id: 'id-1', depth: 1, status: 'succeeded', verificationRound: 1 });
  expect(child).toMatchObject({ parentId: 'id-1', depth: 2, status: 'succeeded', verificationRound: 0 });
});

test('concurrent IDs are unique with out-of-order completion', async () => {
  const { value } = setup(); const release: Array<(x: AssistantMessage) => void> = [];
  const query = createQuery(process.cwd(), () => new Promise(resolve => release.push(resolve)), { remaining: 2 }, 0, 1, { reporter: value });
  const a = query('a', new AbortController().signal), b = query('b', new AbortController().signal);
  expect(value.snapshot().calls.map(c => c.id)).toEqual(['id-1', 'id-2']);
  await Promise.resolve();
  release[1]!(response([{ type: 'text', text: 'b' }])); await b;
  expect(value.snapshot().calls[0]?.status).toBe('active');
  release[0]!(response([{ type: 'text', text: 'a' }])); await a;
  expect(value.snapshot().totals.succeeded).toBe(2);
});

test('failure and abort outcomes leak no errors', async () => {
  const { value } = setup();
  await expect(createQuery(process.cwd(), async () => { throw new Error('ERROR_SENTINEL'); }, { remaining: 1 }, 0, 1, { reporter: value })('secret', new AbortController().signal)).rejects.toThrow();
  const c = new AbortController(); c.abort(new DOMException('ABORT_SENTINEL', 'AbortError'));
  await expect(createQuery(process.cwd(), async () => response([]), { remaining: 1 }, 0, 1, { reporter: value })('x', c.signal)).rejects.toThrow();
  expect(value.snapshot().calls.map(x => x.status)).toEqual(['failed', 'aborted']);
  expect(JSON.stringify(value.snapshot())).not.toMatch(/SENTINEL|secret/);
});

test('retention bounds terminals without evicting active calls', () => {
  let s = emptyActivitySnapshot(0);
  for (let i = 0; i < 4; i++) s = reduceActivity(s, { type: 'started', id: String(i), depth: 1, tier: 'routine', at: i }, 1);
  for (let i = 0; i < 3; i++) s = reduceActivity(s, { type: 'terminal', id: String(i), status: 'succeeded', at: i + 10 }, 1);
  expect(s.calls.map(c => c.id).sort()).toEqual(['2', '3']); expect(s.totals).toMatchObject({ calls: 4, active: 1, succeeded: 3 });
});

test('updates are immediate, coalesced, finally flushed, and never late', async () => {
  const seen: number[] = []; const snap = (n: number) => ({ ...emptyActivitySnapshot(n), updatedAt: n }); const sink = new ActivityUpdateSink(s => seen.push(s.updatedAt), 30);
  sink.push(snap(1)); sink.push(snap(2)); sink.push(snap(3)); expect(seen).toEqual([1]);
  sink.finish(snap(4)); expect(seen).toEqual([1, 4]); await new Promise(r => setTimeout(r, 50)); expect(seen).toEqual([1, 4]);
  const bad = new ActivityUpdateSink(() => { throw new Error('ui'); }); expect(() => { bad.push(snap(1)); bad.finish(snap(2)); }).not.toThrow();
});

test('collapsed rendering is bounded and expanded rendering is hierarchical', () => {
  const { value } = setup(); const root = value.start({ depth: 1, tier: 'smart' }); const child = value.start({ parentId: root, depth: 2, tier: 'routine' }); value.terminal(child, 'succeeded');
  for (let i = 0; i < 5; i++) { const id = value.start({ depth: 1, tier: 'routine' }); value.terminal(id, 'failed'); }
  const collapsed = formatActivity(value.snapshot(), false); expect(collapsed.trim()).not.toBe(''); expect(collapsed.split('\n').length).toBeLessThanOrEqual(9); expect(collapsed).toContain('├─ ● #1 smart'); expect(collapsed).toContain('│  └─ ✓ #2 routine');
  const expanded = formatActivity(value.snapshot(), true); expect(expanded).toContain('├─ ● #1 smart'); expect(expanded).toContain('│  └─ ✓ #2 routine');
});

test('retained labels stay stable, report omissions, and identify orphaned descendants', () => {
  const { value } = setup(1);
  const parent = value.start({ depth: 1, tier: 'smart' });
  const child = value.start({ parentId: parent, depth: 2, tier: 'routine' });
  value.terminal(parent, 'succeeded');
  value.terminal(child, 'succeeded');
  const snapshot = value.snapshot();
  expect(snapshot.calls).toHaveLength(1);
  expect(snapshot.calls[0]).toMatchObject({ sequence: 2, parentSequence: 1 });
  const rendered = formatActivity(snapshot, true);
  expect(rendered).toContain('1 earlier omitted');
  expect(rendered).toContain('#2 routine'); expect(rendered).toContain('parent #1 omitted');
  value.start({ depth: 1, tier: 'routine' });
  expect(formatActivity(value.snapshot(), true)).toContain('#3 routine');
});


test('phase timings accumulate across success and verification', async () => {
  const { value } = setup();
  const times = [0, 11, 11, 29, 29, 37, 37, 54];
  let n = 0;
  const query = createQuery(process.cwd(), async () => ++n === 1
    ? response([{ type: 'toolCall', id: 'timed-tool', name: 'exec', arguments: { code: 'print(1)' } }])
    : response([{ type: 'text', text: 'done' }]), { remaining: 1 }, 0, 3,
    { reporter: value }, undefined, undefined, '', () => times.shift()!);
  expect(await query('secret prompt', new AbortController().signal, {
    verification: { checks: ['true'], maxAttempts: 1, timeoutMs: 1000 },
  })).toBe('done');
  expect(times).toHaveLength(0);
  expect(value.snapshot().calls[0]).toMatchObject({ modelMs: 19, execMs: 18, verificationMs: 17, status: 'succeeded' });
  expect(value.snapshot().totals).toMatchObject({ modelMs: 19, execMs: 18, verificationMs: 17 });
  expect(formatActivity(value.snapshot(), true)).toContain('model 19ms / exec 18ms / verify 17ms');
  expect(JSON.stringify(value.snapshot())).not.toContain('secret prompt');
});

test('failed and cancelled requests retain elapsed model time without exposing errors', async () => {
  const { value } = setup();
  const times = [0, 9, 20, 27];
  const clock = () => times.shift()!;
  const fail = createQuery(process.cwd(), async () => { throw new Error('private failure'); },
    { remaining: 1 }, 0, 2, { reporter: value }, undefined, undefined, '', clock);
  await expect(fail('private prompt', new AbortController().signal)).rejects.toThrow('private failure');
  const abort = new AbortController();
  const cancel = createQuery(process.cwd(), async () => {
    abort.abort(new DOMException('private cancellation', 'AbortError'));
    throw new DOMException('private cancellation', 'AbortError');
  }, { remaining: 1 }, 0, 2, { reporter: value }, undefined, undefined, '', clock);
  await expect(cancel('private prompt', abort.signal)).rejects.toThrow();
  expect(value.snapshot().calls.map(call => [call.status, call.modelMs])).toEqual([['failed', 9], ['aborted', 7]]);
  expect(value.snapshot().totals.modelMs).toBe(16);
  expect(JSON.stringify(value.snapshot())).not.toMatch(/private/);
});

test('parallel phase durations are sums, not end-to-end wall time', () => {
  let snapshot = emptyActivitySnapshot(0);
  snapshot = reduceActivity(snapshot, { type: 'started', id: 'one', depth: 1, tier: 'smart', at: 0 });
  snapshot = reduceActivity(snapshot, { type: 'started', id: 'two', depth: 1, tier: 'routine', at: 0 });
  snapshot = reduceActivity(snapshot, { type: 'timing', id: 'one', phase: 'model', ms: 15, at: 15 });
  snapshot = reduceActivity(snapshot, { type: 'timing', id: 'two', phase: 'model', ms: 15, at: 15 });
  snapshot = reduceActivity(snapshot, { type: 'terminal', id: 'one', status: 'succeeded', at: 15 });
  snapshot = reduceActivity(snapshot, { type: 'terminal', id: 'two', status: 'succeeded', at: 15 });
  expect(snapshot.totals.modelMs).toBe(30);
  expect(snapshot.totals.durationMs).toBe(30);
  expect(snapshot.updatedAt).toBe(15);
});
