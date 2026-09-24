import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { runProcess } from './process.ts';
import { loadState, saveState, statePath, withJobLock } from './store.ts';
import type { BenchmarkJobConfig, BenchmarkJobState, IterationRecord, Verification } from './types.ts';

async function git(cwd: string, args: string[]): Promise<string> {
  return await new Promise((resolveResult, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolveResult(stdout.replace(/\n$/, '')) : reject(new Error('git ' + args.join(' ') + ': ' + stderr.trim())));
  });
}

function validateConfig(config: BenchmarkJobConfig): void {
  if (config.version !== 1) throw new Error('Unsupported benchmark job version.');
  if (!config.objective.trim()) throw new Error('A benchmark objective is required.');
  if (!Number.isFinite(Date.parse(config.deadlineAt))) throw new Error('deadlineAt must be an ISO timestamp.');
  if (!Number.isInteger(config.maxIterations) || config.maxIterations < 1) throw new Error('maxIterations must be positive.');
  if (!Number.isFinite(config.targetImprovement) || config.targetImprovement <= 0) throw new Error('targetImprovement must be positive.');
  if (!config.agent.command || !config.verifier.command) throw new Error('Agent and verifier commands are required.');
  if (!config.protectedPaths.length || config.protectedPaths.some(path => !path || path.startsWith('/') || path.includes('..'))) throw new Error('At least one safe relative protected path is required.');
}

// The verifier is trusted code, not an arbitrary command assembled from model input.
// Generic argument parsing cannot safely classify modules, preloads or interpreters.
async function validateVerifier(config: BenchmarkJobConfig, suppliedWorkspace: string): Promise<void> {
  if (!isAbsolute(config.verifier.command) || config.verifier.args?.length) {
    throw new Error('Verifier must be a canonical absolute external executable with no arguments.');
  }
  const supplied = relative(config.workspace, resolve(config.verifier.command));
  const executable = await realpath(config.verifier.command);
  const local = relative(config.workspace, executable);
  const inside = (path: string) => !path || (!path.startsWith('..') && !isAbsolute(path));
  const suppliedViaAlias = relative(suppliedWorkspace, resolve(config.verifier.command));
  if (inside(supplied) || inside(suppliedViaAlias) || inside(local)) {
    throw new Error('Verifier executable must be outside the editable workspace.');
  }
}

// NUL-delimited porcelain covers staged, unstaged, renamed and untracked paths.
async function changedPaths(workspace: string): Promise<string[]> {
  const output = await git(workspace, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const entries = output.split('\0');
  const paths: string[] = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    paths.push(entry.slice(3));
    if (entry[0] === 'R' || entry[1] === 'R' || entry[0] === 'C' || entry[1] === 'C') paths.push(entries[++i] ?? '');
  }
  return paths;
}

async function protectedChange(config: BenchmarkJobConfig): Promise<string | undefined> {
  return (await changedPaths(config.workspace)).find(changed =>
    config.protectedPaths.some(path => changed === path || changed.startsWith(path + '/'))
  );
}

async function verify(config: BenchmarkJobConfig, jobDir: string, label: string, deadline: number) {
  const process = await runProcess(config.verifier, config.workspace, join(jobDir, 'logs', label + '-verify'), deadline);
  if (process.timedOut) return { process, error: 'Verifier timed out.' };
  if (process.exitCode !== 0) return { process, error: 'Verifier exited with code ' + process.exitCode + '.' };
  try {
    const text = (await readFile(process.stdoutPath, 'utf8')).trim();
    const value = JSON.parse(text) as Verification;
    if (typeof value.valid !== 'boolean' || !Number.isFinite(value.score)) throw new Error('Expected {valid:boolean, score:number}.');
    return { process, value };
  } catch (error) { return { process, error: 'Invalid verifier output: ' + String(error) }; }
}

async function restore(workspace: string, commit: string) {
  await git(workspace, ['reset', '--hard', commit]);
  await git(workspace, ['clean', '-fd']);
}

export function promptFor(state: BenchmarkJobState, iteration: number): string {
  return [
    'You are invocation ' + iteration + ' of an autonomous benchmark-improvement job.',
    'Objective: ' + state.objective,
    'Baseline score: ' + state.baselineScore,
    'Current best score: ' + state.bestScore,
    'Target score: ' + state.targetScore,
    'Orchestrate one bounded improvement attempt in the current workspace. Delegate all repository inspection, implementation, debugging, testing, and ordinary verification, including trivial steps.',
    'Require an independent delegated review of substantive changes. Keep raw files, diffs, logs, and child reports out of top-level context; use compact decision packets.',
    'Preserve correctness. Do not modify the benchmark, commit changes, or ask the user for input.',
    'Exit after making the attempt; the supervisor will verify and either accept or revert it.',
  ].join('\n');
}

async function initialize(config: BenchmarkJobConfig, jobDir: string, deadline: number, suppliedWorkspace: string): Promise<BenchmarkJobState> {
  const clean = await git(config.workspace, ['status', '--porcelain']);
  if (clean) throw new Error('Benchmark workspace must start clean.');
  const baselineCommit = await git(config.workspace, ['rev-parse', 'HEAD']);
  for (const path of config.protectedPaths) {
    if (!await git(config.workspace, ['ls-files', '--', path])) throw new Error('Protected path is not tracked: ' + path);
  }
  await validateVerifier(config, suppliedWorkspace);
  const baseline = await verify(config, jobDir, 'baseline', deadline);
  if (!baseline.value || baseline.error) throw new Error(baseline.error ?? 'Baseline verification failed.');
  if (!baseline.value.valid) throw new Error('Baseline is invalid: ' + (baseline.value.summary ?? 'no summary'));
  const targetScore = baseline.value.score + Math.abs(baseline.value.score) * config.targetImprovement;
  if (!Number.isFinite(targetScore)) throw new Error('Benchmark target is not finite.');
  const now = new Date().toISOString();
  const state: BenchmarkJobState = {
    version: 1, objective: config.objective, status: 'running', createdAt: now, updatedAt: now,
    deadlineAt: config.deadlineAt, baselineCommit, baselineScore: baseline.value.score,
    bestCommit: baselineCommit, bestScore: baseline.value.score,
    targetScore, nextIteration: 1, iterations: [],
  };
  await saveState(jobDir, state);
  return state;
}

async function runLocked(config: BenchmarkJobConfig, jobDir: string): Promise<BenchmarkJobState> {
  validateConfig(config);
  const suppliedWorkspace = resolve(config.workspace);
  config = { ...config, workspace: await realpath(suppliedWorkspace) };
  const deadline = Date.parse(config.deadlineAt);
  let state: BenchmarkJobState;
  try { state = await loadState(jobDir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    state = await initialize(config, jobDir, deadline, suppliedWorkspace);
  }
  if (state.status !== 'running') return state;
  await restore(config.workspace, state.bestCommit);
  await validateVerifier(config, suppliedWorkspace);
  if (state.activeIteration) {
    const active = state.activeIteration;
    state.iterations.push({ number: active.number, startedAt: active.startedAt, finishedAt: new Date().toISOString(), outcome: 'error', reason: 'Interrupted invocation recovered.' });
    state.activeIteration = undefined;
    await saveState(jobDir, state);
  }

  while (state.nextIteration <= config.maxIterations && Date.now() < deadline) {
    const number = state.nextIteration++;
    const startedAt = new Date().toISOString();
    state.activeIteration = { number, phase: 'agent_running', startedAt };
    await saveState(jobDir, state);
    const prefix = join(jobDir, 'logs', 'iteration-' + number + '-agent');
    const agent = await runProcess(config.agent, config.workspace, prefix, deadline, promptFor(state, number));
    const record: IterationRecord = { number, startedAt, finishedAt: new Date().toISOString(), outcome: 'error', reason: '', agentStdoutPath: agent.stdoutPath, agentStderrPath: agent.stderrPath };
    const head = await git(config.workspace, ['rev-parse', 'HEAD']);
    if (agent.timedOut || agent.exitCode !== 0 || head !== state.bestCommit) {
      record.reason = head !== state.bestCommit ? 'Agent changed Git history.' : agent.timedOut ? 'Agent timed out.' : 'Agent exited with code ' + agent.exitCode + '.';
      await restore(config.workspace, state.bestCommit);
    } else {
      const violation = await protectedChange(config);
      if (violation) {
        record.reason = 'Agent modified protected benchmark path: ' + violation;
        record.outcome = 'rejected';
        await restore(config.workspace, state.bestCommit);
        record.finishedAt = new Date().toISOString();
        state.iterations.push(record);
        state.activeIteration = undefined;
        await saveState(jobDir, state);
        continue;
      }
      state.activeIteration.phase = 'verifying';
      await saveState(jobDir, state);
      const checked = await verify(config, jobDir, 'iteration-' + number, deadline);
      const verifierViolation = await protectedChange(config);
      record.verifierStdoutPath = checked.process.stdoutPath;
      record.verifierStderrPath = checked.process.stderrPath;
      if (verifierViolation) {
        record.reason = 'Verifier modified protected benchmark path: ' + verifierViolation;
        record.outcome = 'rejected';
        await restore(config.workspace, state.bestCommit);
      } else if (checked.error || !checked.value?.valid) {
        record.reason = checked.error ?? ('Correctness verification failed: ' + (checked.value?.summary ?? 'no summary'));
        record.outcome = 'rejected';
        await restore(config.workspace, state.bestCommit);
      } else if (checked.value.score <= state.bestScore) {
        record.score = checked.value.score; record.reason = 'No strict improvement.'; record.outcome = 'rejected';
        await restore(config.workspace, state.bestCommit);
      } else {
        record.score = checked.value.score; record.reason = 'Verified strict improvement.'; record.outcome = 'accepted';
        await git(config.workspace, ['add', '-A']);
        const stagedViolation = await protectedChange(config);
        if (stagedViolation) throw new Error('Protected benchmark path staged during acceptance: ' + stagedViolation);
        const changed = await git(config.workspace, ['status', '--porcelain']);
        if (!changed) {
          record.outcome = 'rejected'; record.reason = 'Score changed without a workspace change.';
        } else {
          await git(config.workspace, ['-c', 'user.name=pi-rlm', '-c', 'user.email=pi-rlm@localhost', 'commit', '-m', 'rlm: accept benchmark iteration ' + number]);
          state.bestCommit = await git(config.workspace, ['rev-parse', 'HEAD']);
          state.bestScore = checked.value.score;
        }
      }
    }
    record.finishedAt = new Date().toISOString();
    state.iterations.push(record);
    state.activeIteration = undefined;
    if (state.bestScore + Number.EPSILON * Math.max(1, Math.abs(state.targetScore)) * 8 >= state.targetScore) { state.status = 'succeeded'; state.stopReason = 'Target independently verified.'; }
    await saveState(jobDir, state);
    if (state.status === 'succeeded') return state;
  }
  state.status = 'exhausted';
  state.stopReason = Date.now() >= deadline ? 'Deadline reached.' : 'Iteration budget reached.';
  await restore(config.workspace, state.bestCommit);
  await saveState(jobDir, state);
  return state;
}

export async function runBenchmarkJob(config: BenchmarkJobConfig, jobDir: string): Promise<BenchmarkJobState> {
  return withJobLock(resolve(jobDir), () => runLocked(config, resolve(jobDir)));
}

export { loadState, statePath };
export type { BenchmarkJobConfig, BenchmarkJobState } from './types.ts';
