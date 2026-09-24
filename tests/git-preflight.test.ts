import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitPreflight, validateClaims } from '../src/git-preflight.ts';
import { Runtime } from '../src/runtime.ts';

async function repo(run: (cwd: string) => Promise<void>) {
  const cwd = await mkdtemp(join(tmpdir(), 'rlm-git-preflight-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  try {
    git('init', '-q', '-b', 'task-branch');
    git('config', 'user.email', 'test@example.test');
    git('config', 'user.name', 'Test');
    await writeFile(join(cwd, 'tracked.txt'), 'original');
    git('add', 'tracked.txt'); git('commit', '-qm', 'initial');
    await run(cwd);
  } finally { await rm(cwd, { recursive: true, force: true }); }
}

test('preflight reports dirty tracked and untracked files without touching either', async () => repo(async cwd => {
  await writeFile(join(cwd, 'tracked.txt'), 'updated');
  await writeFile(join(cwd, 'new file.txt'), 'untracked');
  const data = await gitPreflight(cwd, new AbortController().signal);
  expect(data.branch).toBe('task-branch');
  expect(data.head).toMatch(/^[0-9a-f]{40}$/);
  expect(data.dirtyCount).toBe(2);
  expect(data.dirtyPaths).toEqual([{ status: ' M', path: 'tracked.txt' }, { status: '??', path: 'new file.txt' }]);
  expect(data.worktreeCount).toBe(1);
  expect(data.worktrees[0]).toEqual({ path: await realpath(cwd), branch: 'task-branch' });
  expect(await gitPreflight(cwd, new AbortController().signal)).toEqual(data);
}));

test('claim checks reject mismatched local branch, commit, and PR number versus URL', async () => repo(async cwd => {
  const signal = new AbortController().signal;
  const { head } = await gitPreflight(cwd, signal);
  const result = await validateClaims(cwd, signal, {
    branch: 'wrong', head: 'f'.repeat(40),
    pr: { number: 16, url: 'https://github.com/example/repo/pull/15', headBranch: 'elsewhere' },
  });
  expect(result.ok).toBe(false);
  expect(result.errors).toHaveLength(5);
  expect(result.errors).toContain('Claimed PR number differs from PR URL.');
  const valid = await validateClaims(cwd, signal, {
    branch: 'task-branch', head, pr: { number: 15, url: 'https://github.com/example/repo/pull/15', headBranch: 'task-branch' },
  });
  expect(valid.ok).toBe(true);
  expect(valid.unverified.join(' ')).toContain('PR existence');
  await expect(validateClaims(cwd, signal, { branch: 'task-branch', status: 'verified' })).rejects.toThrow('validateClaims requires');
}));

test('claim checks reject adversarial PR URLs rather than trusting ambiguous text', async () => repo(async cwd => {
  const signal = new AbortController().signal;
  for (const url of [
    'https://github.com/a?x/b/pull/15',
    'https://github.com/a/b/pull/15?other=16',
    'https://github.com/a/b/pull/15#fragment',
    'https://alice:secret@github.com/a/b/pull/15',
    'https://github.com@evil.example/a/b/pull/15',
    'https://github.com/a//pull/15',
    'https://github.com/-owner/b/pull/15',
    'https://github.com/a/b/pull/015',
    'https://github.com/a/b/pull/15/../16',
    'https://github.com/a/%62/pull/15',
    'https://github.com/a/b/pull/15/',
    'http://github.com/a/b/pull/15',
  ]) {
    const result = await validateClaims(cwd, signal, { pr: { number: 15, url } });
    expect(result.errors).toContain('PR URL must be a canonical GitHub pull-request URL.');
  }
  const mismatch = await validateClaims(cwd, signal, {
    pr: { number: 16, url: 'https://github.com/a/b/pull/15' },
  });
  expect(mismatch.errors).toContain('Claimed PR number differs from PR URL.');
}));

test('exec exposes opt-in helpers and handles invalid claims without resetting workspace', async () => repo(async cwd => {
  const runtime = new Runtime(cwd);
  try {
    const result = await runtime.exec('const p = await gitPreflight(); print(p.branch, p.dirtyCount); print((await validateClaims({branch: "task-branch"})).ok)', async () => 'unused');
    expect(result).toEqual({ text: 'task-branch 0\ntrue\n', isError: false });
    const error = await runtime.exec('await validateClaims({pr: {number: 0}})', async () => 'unused');
    expect(error.isError).toBe(true);
    expect(error.text).toContain('validateClaims requires');
    expect((await runtime.exec('print(1)', async () => 'unused')).isError).toBe(false);
  } finally { runtime.dispose(); }
}));

test('preflight bounds path output and handles NUL-delimited names and renames', async () => repo(async cwd => {
  const git = (...args: string[]) => execFileSync('git', args, { cwd });
  git('mv', 'tracked.txt', 'renamed.txt');
  await writeFile(join(cwd, '00\nbreak.txt'), 'data');
  for (let i = 0; i < 25; i++) await writeFile(join(cwd, String(i + 1).padStart(2, '0') + '.txt'), 'data');
  const data = await gitPreflight(cwd, new AbortController().signal);
  expect(data.dirtyCount).toBe(27);
  expect(data.dirtyPaths.length).toBe(20);
  expect(data.omittedDirtyPaths).toBe(7);
  expect(data.dirtyPaths.some(item => item.path === '00\nbreak.txt')).toBe(true);
}));
