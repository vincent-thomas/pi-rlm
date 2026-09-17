import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Runtime } from '../src/runtime.ts';
import { bash } from '../src/bash.ts';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const unused = async () => { throw new Error('Unexpected query'); };
function runtime(cwd = process.cwd()) {
  const repl = new Runtime(cwd);
  cleanups.push(() => repl.dispose());
  return repl;
}
function logs(path: string) { cleanups.push(() => rm(dirname(path), { recursive: true, force: true })); }

test('bash returns only metadata; stdout/stderr are complete, separate files', async () => {
  const result = await bash("printf 'hello'; printf 'error' >&2; exit 7", process.cwd(), new AbortController().signal);
  logs(result.stdoutPath);
  expect(Object.keys(result).sort()).toEqual(['exitCode', 'stderrPath', 'stdoutPath']);
  expect(result.exitCode).toBe(7);
  expect(await readFile(result.stdoutPath, 'utf8')).toBe('hello');
  expect(await readFile(result.stderrPath, 'utf8')).toBe('error');
});

test('bash output stays outside context until explicitly read and printed', async () => {
  const repl = runtime();
  expect((await repl.exec('state.r = await bash("printf abcdef"); return state.r;', unused)).text).toBe('(no output)');
  const metadata = await repl.exec('print(JSON.stringify(state.r))', unused);
  const result = JSON.parse(metadata.text);
  logs(result.stdoutPath);
  expect(Object.keys(result).sort()).toEqual(['exitCode', 'stderrPath', 'stdoutPath']);
  expect((await repl.exec('print(await readFile(state.r.stdoutPath, 3, 2))', unused)).text).toBe('cde\n');
  expect((await repl.exec('print(await readFile(state.r.stdoutPath, 3, 100))', unused)).text).toBe('\n');
});

test('only the requested REPL helpers are exposed', async () => {
  const result = await runtime().exec('print([typeof print, typeof bash, typeof readFile, typeof llm_query, typeof context, typeof state].join(",")); print([typeof console, typeof require, typeof fs, typeof cwd, typeof process].join(","))', unused);
  expect(result.text).toBe('function,function,function,function,string,object\nundefined,undefined,undefined,undefined,undefined\n');
});

test('readFile bounds, relative paths, defaults, and zero-length reads', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rlm-test-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'text'), 'x'.repeat(20000));
  const repl = runtime(directory);
  expect((await repl.exec('print((await readFile("text")).length); print((await readFile("text", 0, 0)).length)', unused)).text).toBe('16000\n0\n');
  for (const args of ['-1, 0', '1, -1', '1.5, 0', '1048577, 0']) {
    expect((await repl.exec(`await readFile("text", ${args})`, unused)).isError).toBe(true);
  }
});

test('parallel bash calls have distinct log paths and preserve all output', async () => {
  const results = await Promise.all([1, 2].map(() => bash("head -c 100000 /dev/zero", process.cwd(), new AbortController().signal)));
  for (const result of results) {
    logs(result.stdoutPath);
    expect((await readFile(result.stdoutPath)).length).toBe(100000);
  }
  expect(results[0]!.stdoutPath).not.toBe(results[1]!.stdoutPath);
});

test('cancellation terminates the foreground shell and its child processes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rlm-test-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const controller = new AbortController();
  const result = bash('echo $$ > shell.pid; sleep 30 & echo $! > child.pid; wait', directory, controller.signal);
  const rejection = result.catch(error => error);
  let shellPid = 0;
  let childPid = 0;
  for (let i = 0; i < 100; i++) {
    try {
      shellPid = Number(await readFile(join(directory, 'shell.pid'), 'utf8'));
      childPid = Number(await readFile(join(directory, 'child.pid'), 'utf8'));
      if (shellPid && childPid) break;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  controller.abort();
  expect(String(await rejection)).toContain('aborted');
  expect(shellPid).toBeGreaterThan(0);
  expect(childPid).toBeGreaterThan(0);
  // Reaping the terminated child may lag behind the shell's close event.
  for (let i = 0; i < 100; i++) {
    try { process.kill(childPid, 0); } catch { break; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  expect(() => process.kill(shellPid, 0)).toThrow();
  expect(() => process.kill(childPid, 0)).toThrow();
});
