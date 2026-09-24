import { afterEach, expect, test } from 'bun:test';
import type { AssistantMessage, Context } from '@earendil-works/pi-ai';
import { createQuery } from '../src/rlm.ts';
import { Runtime } from '../src/runtime.ts';
import { SCRATCHPAD_INITIAL_TEXT, SCRATCHPAD_MAX_BYTES, Scratchpad } from '../src/scratchpad.ts';

const runtimes: Runtime[] = [];
const makeRuntime = (scratchpad: Scratchpad) => {
  const runtime = new Runtime(process.cwd(), '', scratchpad);
  runtimes.push(runtime);
  return runtime;
};
afterEach(() => { for (const runtime of runtimes.splice(0)) runtime.dispose(); });
const unused = async () => { throw new Error('unexpected query'); };
function response(content: AssistantMessage['content']): AssistantMessage {
  return { role: 'assistant', content, api: 'anthropic-messages', provider: 'anthropic', model: 'mock',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: content.some(block => block.type === 'toolCall') ? 'toolUse' : 'stop', timestamp: Date.now() };
}

test('scratchpad edit is exact, atomic, byte-limited, and FIFO', async () => {
  const pad = new Scratchpad();
  expect(await pad.read()).toBe(SCRATCHPAD_INITIAL_TEXT);
  await pad.edit(SCRATCHPAD_INITIAL_TEXT, 'A');
  await Promise.all([pad.edit('A', 'B'), pad.edit('B', 'C')]);
  expect(await pad.read()).toBe('C');

  await expect(pad.edit('missing', 'x')).rejects.toThrow(/absent|stale/);
  expect(await pad.read()).toBe('C');
  await pad.edit('C', 'aa aa');
  await expect(pad.edit('aa', 'x')).rejects.toThrow(/more than once|ambiguous/);
  expect(await pad.read()).toBe('aa aa');
  await expect(pad.edit('', 'x')).rejects.toThrow(/nonempty/);
  await expect((pad as any).edit(1, 'x')).rejects.toThrow(/nonempty/);
  await expect(pad.edit('aa aa', '😀'.repeat(SCRATCHPAD_MAX_BYTES / 4 + 1))).rejects.toThrow(/65536/);
  expect(await pad.read()).toBe('aa aa');

  const boundary = new Scratchpad();
  const full = '😀' + 'a'.repeat(SCRATCHPAD_MAX_BYTES - 4);
  await boundary.edit(SCRATCHPAD_INITIAL_TEXT, full);
  await expect(boundary.edit('\ude00', '¢')).rejects.toThrow(/result exceeds/);
  expect(await boundary.read(0, SCRATCHPAD_MAX_BYTES)).toBe(full);
});

test('scratchpad reads use UTF-8 byte offsets and bounded split decoding', async () => {
  const pad = new Scratchpad();
  await pad.edit(SCRATCHPAD_INITIAL_TEXT, 'A😀B');
  expect(await pad.read(0, 1)).toBe('A');
  expect(await pad.read(1, 4)).toBe('😀');
  expect(await pad.read(2, 2)).toContain('�');
  expect(await pad.read(6, 10)).toBe('');
  await expect(pad.read(-1, 1)).rejects.toThrow(/nonnegative/);
  await expect(pad.read(0, SCRATCHPAD_MAX_BYTES + 1)).rejects.toThrow(/65536/);
});

test('worker exposes only async read/edit and shared parallel runtimes serialize operations', async () => {
  const pad = new Scratchpad();
  const first = makeRuntime(pad);
  const second = makeRuntime(pad);
  const shape = await first.exec("print(Object.keys(scratchpad).sort().join(',')); print(typeof scratchpad.content)", unused);
  expect(shape.text).toBe('edit,read\nundefined\n');
  await first.exec("await scratchpad.edit('# Shared scratchpad\\n', 'A')", unused);
  const [a, b] = await Promise.all([
    first.exec("await scratchpad.edit('A', 'B')", unused),
    second.exec("await scratchpad.edit('B', 'C')", unused),
  ]);
  expect(a.isError).toBe(false);
  expect(b.isError).toBe(false);
  expect((await second.exec('print(await scratchpad.read())', unused)).text).toBe('C\n');
});

test('scratchpad is shared through child and grandchild llm_query runtimes', async () => {
  const pad = new Scratchpad();
  const complete = async (ctx: Context) => {
    const prompt = (ctx.messages.at(-1) as any).content;
    const hasToolResult = ctx.messages.some(message => message.role === 'toolResult');
    if (prompt === 'root' && !hasToolResult) return response([{ type: 'toolCall', id: 'root-tool', name: 'exec', arguments: {
      code: "await scratchpad.edit('# Shared scratchpad\\n', 'child'); await llm_query('grand')",
    } }]);
    if (prompt === 'grand' && !hasToolResult) return response([{ type: 'toolCall', id: 'grand-tool', name: 'exec', arguments: {
      code: "await scratchpad.edit('child', 'grandchild')",
    } }]);
    return response([{ type: 'text', text: 'done' }]);
  };
  const query = createQuery(process.cwd(), complete, { remaining: 2 }, 0, 4, undefined, pad);
  expect(await query('root', new AbortController().signal)).toBe('done');
  expect(await pad.read()).toBe('grandchild');
});

test('worker timeout resets workspace but does not clear session scratchpad', async () => {
  const pad = new Scratchpad();
  const runtime = makeRuntime(pad);
  await runtime.exec("await scratchpad.edit('# Shared scratchpad\\n', 'kept'); while (true) {}", unused, undefined, 50);
  expect((await runtime.exec('print(await scratchpad.read())', unused)).text).toBe('kept\n');
});

test('worker rejects oversized scratchpad newText before structured-clone dispatch', async () => {
  class CountingScratchpad extends Scratchpad {
    edits = 0;
    override async edit(oldText: string, newText: string): Promise<void> {
      this.edits++;
      return super.edit(oldText, newText);
    }
  }
  const pad = new CountingScratchpad();
  const runtime = makeRuntime(pad);
  const result = await runtime.exec(
    "await scratchpad.edit('# Shared scratchpad\\n', '😀'.repeat(16385))",
    unused,
  );
  expect(result.isError).toBe(true);
  expect(result.text).toContain('oldText and newText must each be at most 65536 UTF-8 bytes for transfer');
  expect(pad.edits).toBe(0);
  expect((await runtime.exec('print(await scratchpad.read())', unused)).text).toBe('# Shared scratchpad\n\n');
});

test('worker bounds both edit operands and rejects non-strings before IPC', async () => {
  class CountingScratchpad extends Scratchpad {
    edits = 0;
    override async edit(oldText: string, newText: string): Promise<void> {
      this.edits++;
      return super.edit(oldText, newText);
    }
  }
  const pad = new CountingScratchpad();
  const runtime = makeRuntime(pad);
  const result = await runtime.exec(`
    for (const args of [[1, 'x'], ['x', null], ['', 'x'], ['a'.repeat(65537), 'x']]) {
      try { await scratchpad.edit(...args); } catch (error) { print(String(error)); }
    }
  `, unused);
  expect(result.isError).toBe(false);
  expect(result.text).toContain('requires string arguments');
  expect(result.text).toContain('oldText must be a nonempty string');
  expect(result.text).toContain('at most 65536 UTF-8 bytes for transfer');
  expect(pad.edits).toBe(0);
});

test('structured-clone request failure rejects cleanly without leaking pending state', async () => {
  const runtime = makeRuntime(new Scratchpad());
  const first = await runtime.exec(`
    state.kept = 42;
    try { await bash(() => 1); } catch (error) { print(error.name); }
  `, unused);
  expect(first.isError).toBe(false);
  expect(first.text).toContain('DataCloneError');
  const second = await runtime.exec('print(state.kept)', unused);
  expect(second).toEqual({ text: '42\n', isError: false });
});

test('unawaited invalid local API calls do not cause unhandled rejections', async () => {
  const runtime = makeRuntime(new Scratchpad());
  const first = await runtime.exec(`
    scratchpad.edit('', 'x');
    scratchpad.edit(1, 'x');
    llm_query(1);
    llm_query('x', { model: 'invalid' });
    llm_query('x', { verification: {} });
    print(await scratchpad.read());
  `, unused);
  expect(first).toEqual({ text: '# Shared scratchpad\n\n', isError: false });
  expect(await runtime.exec('print(42)', unused)).toEqual({ text: '42\n', isError: false });
});
