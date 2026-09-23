import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { Scratchpad, SCRATCHPAD_INITIAL_TEXT, SCRATCHPAD_MAX_BYTES } from '../src/scratchpad.ts';
import { restoreSessionScratchpad, SCRATCHPAD_ENTRY_TYPE } from '../src/session-scratchpad.ts';

const restore = (manager: SessionManager, isActive = () => true) => restoreSessionScratchpad({
  appendEntry: (type, data) => { manager.appendCustomEntry(type, data); },
}, manager, isActive);

test('scratchpad survives disk reopen and branch navigation without entering model context', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rlm-session-pad-'));
  try {
    const manager = SessionManager.create(dir, dir);
    // Pi starts persisting session entries after the first assistant message.
    const root = manager.appendMessage({
      role: 'assistant', content: [{ type: 'text', text: 'ready' }],
      api: 'anthropic-messages', provider: 'anthropic', model: 'mock',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: 'stop', timestamp: Date.now(),
    });
    const pad = restore(manager);
    await pad.edit(SCRATCHPAD_INITIAL_TEXT, 'private knowledge 😀');
    await Promise.all([pad.edit('knowledge', 'facts'), pad.edit('facts', 'evidence')]);
    manager.branch(root);
    manager.appendCompaction('summary', root, 100);
    expect(await restore(manager).read()).toBe('private evidence 😀');
    const reopened = SessionManager.open(manager.getSessionFile()!);
    expect(await restore(reopened).read()).toBe('private evidence 😀');
    expect(JSON.stringify(reopened.buildSessionContext().messages)).not.toContain('private evidence');

    const fork = SessionManager.forkFrom(manager.getSessionFile()!, dir, dir);
    expect(await restore(fork).read()).toBe(SCRATCHPAD_INITIAL_TEXT);
    await restore(fork).edit(SCRATCHPAD_INITIAL_TEXT, 'fork notes');
    expect(await restore(reopened).read()).toBe('private evidence 😀');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('separate sessions and stale workers cannot overwrite each other', async () => {
  const first = SessionManager.inMemory();
  const second = SessionManager.inMemory();
  let active = true;
  const pad = restore(first, () => active);
  await pad.edit(SCRATCHPAD_INITIAL_TEXT, 'first');
  expect(await restore(second).read()).toBe(SCRATCHPAD_INITIAL_TEXT);
  const pending = pad.edit('first', 'late write');
  active = false;
  await expect(pending).rejects.toThrow('no longer active');
  expect(await restore(first).read()).toBe('first');
  expect(await restore(second).read()).toBe(SCRATCHPAD_INITIAL_TEXT);

  const oldSession = restore(first);
  first.newSession();
  await expect(oldSession.edit('first', 'wrong session')).rejects.toThrow('no longer active');
  expect(await restore(first).read()).toBe(SCRATCHPAD_INITIAL_TEXT);
});

test('failed saves and invalid edits preserve live state; subsequent edits can succeed', async () => {
  let fail = true;
  const saved: string[] = [];
  const pad = new Scratchpad('initial', text => {
    if (fail) throw new Error('disk unavailable');
    saved.push(text);
  });
  await expect(pad.edit('initial', 'lost')).rejects.toThrow('disk unavailable');
  expect(await pad.read()).toBe('initial');
  fail = false;
  await expect(pad.edit('missing', 'lost')).rejects.toThrow('absent or stale');
  await pad.edit('initial', 'saved');
  expect(saved).toEqual(['saved']);
  expect(await pad.read()).toBe('saved');
});

test('empty snapshots restore correctly and malformed snapshots fail explicitly', async () => {
  const manager = SessionManager.inMemory();
  await restore(manager).edit(SCRATCHPAD_INITIAL_TEXT, '');
  expect(await restore(manager).read()).toBe('');
  const snapshot = (data: object) => manager.appendCustomEntry(SCRATCHPAD_ENTRY_TYPE,
    { version: 1, sessionId: manager.getSessionId(), ...data });
  snapshot({ text: '😀'.repeat(SCRATCHPAD_MAX_BYTES / 4 + 1) });
  expect(() => restore(manager)).toThrow('65536');
  snapshot({ text: 1 });
  expect(() => restore(manager)).toThrow('Invalid saved RLM scratchpad');
  snapshot({ version: 2, text: 'future' });
  expect(() => restore(manager)).toThrow('Invalid saved RLM scratchpad');
});
