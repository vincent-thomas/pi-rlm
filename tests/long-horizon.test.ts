import { afterEach, expect, test } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { runBenchmarkJob } from '../src/long-horizon/supervisor.ts';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function command(cwd: string, executable: string, args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { cwd, stdio: 'pipe' });
    let stderr = '';
    child.stderr.on('data', value => { stderr += value; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(stderr)));
  });
}

test('autonomously reaches a verified benchmark target across fresh invocations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-rlm-long-horizon-'));
  temporary.push(root);
  const workspace = join(root, 'workspace');
  const jobDir = join(root, 'job');
  await command(root, 'mkdir', [workspace]);
  await writeFile(join(workspace, 'score.txt'), '100\n');
  await writeFile(join(workspace, 'correct.txt'), 'yes\n');
  await command(workspace, 'git', ['init', '-q']);
  await command(workspace, 'git', ['add', '.']);
  await command(workspace, 'git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'baseline']);

  const pidLog = join(root, 'agent-pids.txt');
  const agent = join(root, 'agent.sh');
  await writeFile(agent, [
    '#!/bin/sh',
    'echo $$ >> "' + pidLog + '"',
    'score=$(cat score.txt)',
    'if [ "$score" -eq 100 ]; then echo 105 > score.txt; else echo 115 > score.txt; fi',
  ].join('\n') + '\n');
  await chmod(agent, 0o700);
  const verifier = join(root, 'verify.sh');
  await writeFile(verifier, [
    '#!/bin/sh',
    'score=$(cat score.txt)',
    'if [ "$(cat correct.txt)" = yes ]; then valid=true; else valid=false; fi',
    'echo "{\\"valid\\":$valid,\\"score\\":$score,\\"summary\\":\\"synthetic\\"}"',
  ].join('\n') + '\n');
  await chmod(verifier, 0o700);

  const state = await runBenchmarkJob({
    version: 1,
    objective: 'Improve the synthetic benchmark by at least 10%.',
    workspace,
    deadlineAt: new Date(Date.now() + 10_000).toISOString(),
    maxIterations: 4,
    targetImprovement: 0.10,
    protectedPaths: ['correct.txt'],
    agent: { command: agent, timeoutMs: 2_000 },
    verifier: { command: verifier, timeoutMs: 2_000 },
  }, jobDir);

  expect(state.status).toBe('succeeded');
  expect(state.baselineScore).toBe(100);
  expect(state.bestScore).toBe(115);
  expect(state.iterations.map(item => item.outcome)).toEqual(['accepted', 'accepted']);
  const pids = (await readFile(pidLog, 'utf8')).trim().split('\n');
  expect(pids).toHaveLength(2);
  expect(new Set(pids).size).toBe(2);
  expect((await readFile(join(workspace, 'score.txt'), 'utf8')).trim()).toBe('115');
  const persisted = JSON.parse(await readFile(join(jobDir, 'state.json'), 'utf8'));
  expect(persisted.status).toBe('succeeded');
  expect(await command(workspace, 'git', ['diff', '--exit-code'])).toBeUndefined();
});
