import { expect, test } from 'bun:test';
import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import { autonomyInstructions, instructions } from '../src/rlm.ts';
import { loadExtensions } from '../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js';

test('pi loader registers tools and commands; loaded extension executes and resets', async () => {
  const result = await loadExtensions([`${process.cwd()}/index.ts`], process.cwd());
  expect(result.errors).toEqual([]);
  const extension = result.extensions[0]!;
  expect([...extension.commands.keys()]).toEqual(['rlm-load', 'rlm-reset']);
  expect([...extension.tools.keys()].sort()).toEqual(['exec', 'start_long_horizon']);
  const tool = extension.tools.get('exec')!.definition;
  const ctx = { cwd: process.cwd() } as ExtensionContext;
  try {
    for (const handler of extension.handlers.get('before_agent_start')!) {
      const prompt = await handler({ type: 'before_agent_start', prompt: 'task', systemPrompt: 'BASE' }, ctx);
      if (!prompt || typeof prompt !== 'object' || !('systemPrompt' in prompt)) {
        throw new Error('Expected routing instructions in the system prompt');
      }
      expect(prompt.systemPrompt).toContain('BASE');
      expect(prompt.systemPrompt).toContain('Delegate bounded work only when it materially helps');
      expect(prompt.systemPrompt).toContain(autonomyInstructions);
      expect(prompt.systemPrompt).toContain('Do not stop at a plan, diagnosis, partial edit, or an offer to continue');
      expect(prompt.systemPrompt).toContain(instructions);
      expect(prompt.systemPrompt).toContain('start_long_horizon');
    }
    const first = await tool.execute('1', { code: 'state.answer = 42; print(state.answer)' }, undefined, undefined, ctx);
    expect(first.content).toEqual([{ type: 'text', text: '42\n' }]);
    for (const handler of extension.handlers.get('session_tree')!) await handler({ type: 'session_tree' }, ctx);
    const second = await tool.execute('2', { code: 'print(typeof state.answer)' }, undefined, undefined, ctx);
    expect(second.content).toEqual([{ type: 'text', text: 'undefined\n' }]);
  } finally {
    for (const handler of extension.handlers.get('session_shutdown')!) await handler({ type: 'session_shutdown' }, ctx);
  }
});
