import { expect, test } from 'bun:test';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { loadExtensions } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js';

test('pi loader registers tools and commands; loaded extension executes and resets', async () => {
  const result = await loadExtensions([`${process.cwd()}/index.ts`], process.cwd());
  expect(result.errors).toEqual([]);
  const extension = result.extensions[0]!;
  expect([...extension.commands.keys()]).toEqual(['rlm-load', 'rlm-reset']);
  const tool = extension.tools.get('exec')!.definition;
  const ctx = { cwd: process.cwd() } as ExtensionContext;
  try {
    const first = await tool.execute('1', { code: 'state.answer = 42; print(state.answer)' }, undefined, undefined, ctx);
    expect(first.content).toEqual([{ type: 'text', text: '42\n' }]);
    for (const handler of extension.handlers.get('session_tree')!) await handler({ type: 'session_tree' }, ctx);
    const second = await tool.execute('2', { code: 'print(typeof state.answer)' }, undefined, undefined, ctx);
    expect(second.content).toEqual([{ type: 'text', text: 'undefined\n' }]);
  } finally {
    for (const handler of extension.handlers.get('session_shutdown')!) await handler({ type: 'session_shutdown' }, ctx);
  }
});
