import { expect, jest, test } from 'bun:test';
import { runVerificationRound } from '../src/rlm.ts';
import type { BashResult } from '../src/bash.ts';

function fakeRunner(outcomes: Record<string, number>, active: { current: number; peak: number; started: string[]; settled: string[] }, delay: number | ((check: string) => number) = 100) {
  return async (check: string, _cwd: string, signal: AbortSignal): Promise<BashResult> => {
    active.current++;
    active.peak = Math.max(active.peak, active.current);
    active.started.push(check);
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, typeof delay === 'number' ? delay : delay(check));
        const stop = () => { clearTimeout(timer); reject(signal.reason ?? new Error('aborted')); };
        signal.addEventListener('abort', stop, { once: true });
        if (signal.aborted) stop();
      });
      return { exitCode: outcomes[check] ?? 0, stdoutPath: check + '.out', stderrPath: check + '.err' };
    } finally {
      active.current--;
      active.settled.push(check);
    }
  };
}

test('opt-in bounded checks overlap under fake timers; sequential checks preserve outcomes', async () => {
  jest.useFakeTimers();
  try {
    const outcomes = { first: 4, second: 0, third: 7 };
    const serial = { current: 0, peak: 0, started: [] as string[], settled: [] as string[] };
    const serialResult = runVerificationRound('.', Object.keys(outcomes), 1000, new AbortController().signal, 1, fakeRunner(outcomes, serial));
    for (let i = 0; i < 3; i++) { jest.advanceTimersByTime(100); await Promise.resolve(); await Promise.resolve(); }
    expect((await serialResult).map(x => [x.check, x.status])).toEqual([['first', 4], ['third', 7]]);
    expect(serial.peak).toBe(1);
    const parallel = { current: 0, peak: 0, started: [] as string[], settled: [] as string[] };
    const concurrentResult = runVerificationRound('.', Object.keys(outcomes), 1000, new AbortController().signal, 2, fakeRunner(outcomes, parallel, check => check === 'first' ? 200 : 100));
    expect(parallel.started).toEqual(['first', 'second']);
    jest.advanceTimersByTime(100);
    await Promise.resolve(); await Promise.resolve();
    expect(parallel.peak).toBe(2);
    jest.advanceTimersByTime(100);
    expect((await concurrentResult).map(x => [x.check, x.status])).toEqual([['first', 4], ['third', 7]]);
    expect(parallel.started).toEqual(['first', 'second', 'third']);
    expect(parallel.settled).toEqual(['second', 'first', 'third']);
  } finally { jest.useRealTimers(); }
});

test('cancellation aborts active checks, starts no more, and waits for their settlement', async () => {
  jest.useFakeTimers();
  try {
    const controller = new AbortController();
    const state = { current: 0, peak: 0, started: [] as string[], settled: [] as string[] };
    const result = runVerificationRound('.', ['one', 'two', 'three'], 1000, controller.signal, 2, fakeRunner({}, state));
    expect(state.started).toEqual(['one', 'two']);
    controller.abort(new DOMException('cancelled', 'AbortError'));
    await expect(result).rejects.toThrow('cancelled');
    expect(state.started).toEqual(['one', 'two']);
    expect(state.settled).toEqual(['one', 'two']);
    expect(state.current).toBe(0);
  } finally { jest.useRealTimers(); }
});

test('duplicate failed commands remain attributable by index', async () => {
  const state = { current: 0, peak: 0, started: [] as string[], settled: [] as string[] };
  const result = await runVerificationRound('.', ['repeat', 'repeat'], 1000, new AbortController().signal, 2,
    async (check, _cwd, signal) => {
      state.started.push(check);
      signal.throwIfAborted();
      return { exitCode: 9, stdoutPath: String(state.started.length), stderrPath: String(state.started.length) };
    });
  expect(result.map(x => x.index)).toEqual([0, 1]);
});
