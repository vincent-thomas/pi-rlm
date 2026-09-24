import { afterEach, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { promptFor, runBenchmarkJob } from '../src/long-horizon/supervisor.ts';
import { longHorizonInstructions, notifyCompleted } from '../src/long-horizon/extension.ts';
import { restoreProtected, snapshotProtected } from '../src/long-horizon/protected.ts';

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true }))); });


test('long-horizon top-level prompts retain scarce-model delegation', () => {
  expect(longHorizonInstructions).toContain('delegate discovery of the existing canonical verifier');
  expect(longHorizonInstructions).toContain('Do not inspect those repository artifacts directly');
  const prompt = promptFor({ objective: 'Improve', baselineScore: 1, bestScore: 1, targetScore: 2 } as any, 1);
  expect(prompt).toContain('Orchestrate one bounded improvement attempt');
  expect(prompt).toContain('Delegate all repository inspection, implementation, debugging, testing, and ordinary verification');
  expect(prompt).toContain('independent delegated review of substantive changes');
  expect(prompt).toContain('Keep raw files, diffs, logs, and child reports out of top-level context');
});

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

async function guardrailFixture(agentBody: string) {
  const root = await mkdtemp(join(tmpdir(), 'pi-rlm-guardrails-'));
  temporary.push(root);
  const workspace = join(root, 'workspace');
  const jobDir = join(root, 'job');
  await mkdir(join(workspace, 'bench'), { recursive: true });
  await writeFile(join(workspace, 'bench', 'correct.txt'), 'yes\n');
  await writeFile(join(workspace, 'score.txt'), '100\n');
  await command(workspace, 'git', ['init', '-q']);
  await command(workspace, 'git', ['add', '.']);
  await command(workspace, 'git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'baseline']);
  const agent = join(root, 'agent.sh');
  await writeFile(agent, '#!/bin/sh\nset -e\n' + agentBody + '\n');
  await chmod(agent, 0o700);
  const verifier = join(root, 'verify.sh');
  await writeFile(verifier, '#!/bin/sh\nprintf \'{"valid":true,"score":%s}\\n\' "$(cat score.txt)"\n');
  await chmod(verifier, 0o700);
  const config: Parameters<typeof runBenchmarkJob>[0] = {
    version: 1, objective: 'Improve', workspace,
    deadlineAt: new Date(Date.now() + 15_000).toISOString(),
    maxIterations: 1, targetImprovement: 0.10, protectedPaths: ['bench'],
    agent: { command: agent }, verifier: { command: verifier },
  };
  return { root, workspace, jobDir, config };
}

test.each([
  ['untracked addition', 'echo 120 > score.txt\necho fake > bench/extra.txt', 'bench/extra.txt'],
  ['staged addition', 'echo 120 > score.txt\necho fake > bench/extra.txt\ngit add bench/extra.txt', 'bench/extra.txt'],
  ['unstaged modification', 'echo 120 > score.txt\necho fake > bench/correct.txt', 'bench/correct.txt'],
  ['staged modification', 'echo 120 > score.txt\necho fake > bench/correct.txt\ngit add bench/correct.txt', 'bench/correct.txt'],
  ['rename', 'echo 120 > score.txt\ngit mv bench/correct.txt moved.txt', 'bench/correct.txt'],
])('rejects protected %s', async (_label, agentBody, path) => {
  const { workspace, jobDir, config } = await guardrailFixture(agentBody);
  const state = await runBenchmarkJob(config, jobDir);
  expect(state.iterations[0]?.outcome).toBe('rejected');
  expect(state.iterations[0]?.reason).toContain(path);
  expect(state.bestScore).toBe(100);
  expect((await readFile(join(workspace, 'score.txt'), 'utf8')).trim()).toBe('100');
});

test('rejects ignored benchmark injection and removes only the injected file', async () => {
  const { workspace, jobDir, config } = await guardrailFixture('echo 120 > score.txt\nmkdir -p bench/cache\necho fake > bench/cache/injected.dat');
  await writeFile(join(workspace, '.gitignore'), 'bench/cache/\nexternal-cache/\n');
  await command(workspace, 'git', ['add', '.gitignore']);
  await command(workspace, 'git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'ignore']);
  await mkdir(join(workspace, 'external-cache'));
  await writeFile(join(workspace, 'external-cache', 'user.dat'), 'outside\n');
  const state = await runBenchmarkJob(config, jobDir);
  expect(state.iterations[0]?.outcome).toBe('rejected');
  expect(state.iterations[0]?.reason).toContain('bench/cache');
  expect((await readFile(join(workspace, 'score.txt'), 'utf8')).trim()).toBe('100');
  await expect(readFile(join(workspace, 'bench/cache/injected.dat'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(workspace, 'external-cache/user.dat'), 'utf8')).toBe('outside\n');
});

test('restores a preexisting ignored benchmark file after rejected tampering', async () => {
  const { workspace, jobDir, config } = await guardrailFixture('echo 120 > score.txt\necho forged > bench/cache/user.dat\necho injected > bench/cache/new.dat');
  await writeFile(join(workspace, '.gitignore'), 'bench/cache/\n');
  await command(workspace, 'git', ['add', '.gitignore']);
  await command(workspace, 'git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'ignore']);
  await mkdir(join(workspace, 'bench/cache'));
  await writeFile(join(workspace, 'bench/cache/user.dat'), 'personal baseline\n');
  const state = await runBenchmarkJob(config, jobDir);
  expect(state.iterations[0]?.outcome).toBe('rejected');
  expect(state.iterations[0]?.reason).toContain('bench/cache/');
  expect(await readFile(join(workspace, 'bench/cache/user.dat'), 'utf8')).toBe('personal baseline\n');
  await expect(readFile(join(workspace, 'bench/cache/new.dat'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  expect((await readFile(join(workspace, 'score.txt'), 'utf8')).trim()).toBe('100');
});

test('rejects an unprotected workspace verifier entrypoint', async () => {
  const { workspace, jobDir, config } = await guardrailFixture('echo 120 > score.txt');
  const verifier = join(workspace, 'verify.sh');
  await writeFile(verifier, '#!/bin/sh\necho \'{"valid":true,"score":999}\'\n');
  await chmod(verifier, 0o700);
  await command(workspace, 'git', ['add', 'verify.sh']);
  await command(workspace, 'git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'verifier']);
  config.verifier.command = './verify.sh';
  await expect(runBenchmarkJob(config, jobDir)).rejects.toThrow('canonical absolute external executable');
});

test('rejects even protected workspace verifier entrypoints', async () => {
  const { workspace, jobDir, config } = await guardrailFixture('echo 120 > score.txt');
  const verifier = join(workspace, 'verify.sh');
  await writeFile(verifier, '#!/bin/sh\nexit 0\n');
  await chmod(verifier, 0o700);
  await command(workspace, 'git', ['add', 'verify.sh']);
  await command(workspace, 'git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'verifier']);
  config.protectedPaths.push('verify.sh');
  config.verifier.command = verifier;
  await expect(runBenchmarkJob(config, jobDir)).rejects.toThrow('outside the editable workspace');
});

test('rejects workspace symlink to external verifier even when target is trusted', async () => {
  const { root, workspace, jobDir, config } = await guardrailFixture('echo 120 > score.txt');
  const link = join(workspace, 'verify-link');
  await symlink(join(root, 'verify.sh'), link);
  await command(workspace, 'git', ['add', 'verify-link']);
  await command(workspace, 'git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'symlink']);
  config.verifier.command = link;
  await expect(runBenchmarkJob(config, jobDir)).rejects.toThrow('outside the editable workspace');
});

test('CLI persists terminal failure and notifier handles stale running state', async () => {
  const { root, workspace, jobDir, config } = await guardrailFixture('echo 120 > score.txt');
  config.agent.command = join(root, 'missing-agent');
  const configPath = join(root, 'config.json');
  await writeFile(configPath, JSON.stringify(config));
  const cli = join(import.meta.dir, '..', 'src', 'long-horizon', 'cli.ts');
  await expect(command(root, 'bun', [cli, configPath, jobDir])).rejects.toThrow();
  const state = JSON.parse(await readFile(join(jobDir, 'state.json'), 'utf8'));
  expect(state.status).toBe('failed');
  expect(JSON.parse(await readFile(join(jobDir, 'failure.json'), 'utf8')).status).toBe('failed');
  state.status = 'running'; // Simulate a crash between writing failure.json and updating state.json.
  await writeFile(join(jobDir, 'state.json'), JSON.stringify(state));
  await writeFile(join(jobDir, 'metadata.json'), JSON.stringify({ sourceWorkspace: workspace, branch: 'test-branch' }));
  const messages: string[] = [];
  const pi = { sendUserMessage: (text: string) => { messages.push(text); } } as any;
  await notifyCompleted(pi, workspace, root);
  await notifyCompleted(pi, workspace, root);
  expect(messages).toHaveLength(1);
  expect(messages[0]).toContain('status failed');
});

test.each([
  ['python module', '/usr/bin/python3', ['-m', 'verifier']],
  ['node preload', '/usr/bin/node', ['--import=./helper.mjs']],
  ['inline shell', '/bin/sh', ['-lc', './unprotected.sh']],
])('rejects unsafe verifier argument forms: %s', async (_label, executable, args) => {
  const { jobDir, config } = await guardrailFixture('echo 120 > score.txt');
  config.verifier = { command: executable, args };
  await expect(runBenchmarkJob(config, jobDir)).rejects.toThrow('canonical absolute external executable with no arguments');
});

test.each(['dead supervisor', 'expired job'])('notifies once for a %s with stale running state', async scenario => {
  const { root, workspace, jobDir, config } = await guardrailFixture('echo 120 > score.txt');
  await mkdir(jobDir, { recursive: true });
  await writeFile(join(jobDir, 'metadata.json'), JSON.stringify({ sourceWorkspace: workspace, branch: 'test-branch' }));
  const deadlineAt = new Date(Date.now() + (scenario === 'dead supervisor' ? 300_000 : -120_000)).toISOString();
  await writeFile(join(jobDir, 'state.json'), JSON.stringify({ status: 'running', deadlineAt, bestScore: 100, targetScore: 110 }));
  await writeFile(join(jobDir, 'supervisor.json'), JSON.stringify({ pid: scenario === 'dead supervisor' ? 2147483647 : process.pid }));
  const messages: string[] = [];
  const pi = { sendUserMessage: (text: string) => { messages.push(text); } } as any;
  await notifyCompleted(pi, workspace, root);
  await notifyCompleted(pi, workspace, root);
  expect(messages).toHaveLength(1);
  expect(messages[0]).toContain('status failed');
  expect(messages[0]).toContain(scenario === 'dead supervisor' ? 'no longer running' : 'expired');
  expect(JSON.parse(await readFile(join(jobDir, 'failure.json'), 'utf8')).status).toBe('failed');
});


test('rejects an ignored protected symlink to mutable data outside protected paths', async () => {
  const { root, workspace, jobDir, config } = await guardrailFixture('echo 120 > score.txt');
  await writeFile(join(workspace, '.gitignore'), 'bench/cache/\n');
  await command(workspace, 'git', ['add', '.gitignore']);
  await command(workspace, 'git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'ignore']);
  await mkdir(join(workspace, 'bench/cache'));
  const outside = join(root, 'external-input.txt');
  await writeFile(outside, 'original\n');
  await symlink(outside, join(workspace, 'bench/cache/alias'));
  await expect(runBenchmarkJob(config, jobDir)).rejects.toThrow('Protected baseline contains symlink: bench/cache/alias');
  expect(await readFile(outside, 'utf8')).toBe('original\n');
});

test('rejects a tracked protected symlink without following its target', async () => {
  const { root, workspace, jobDir, config } = await guardrailFixture('echo 120 > score.txt');
  const outside = join(root, 'external-input.txt');
  await writeFile(outside, 'original\n');
  await symlink(outside, join(workspace, 'bench/alias'));
  await command(workspace, 'git', ['add', 'bench/alias']);
  await command(workspace, 'git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'alias']);
  await expect(runBenchmarkJob(config, jobDir)).rejects.toThrow('Protected baseline contains symlink: bench/alias');
  expect(await readFile(outside, 'utf8')).toBe('original\n');
});

test('rejects an injected ignored protected symlink and leaves its target intact', async () => {
  const { root, workspace, jobDir, config } = await guardrailFixture('echo 120 > score.txt');
  // The agent script uses the real target, not a preexisting baseline link.
  const outside = join(root, 'outside.txt');
  await writeFile(outside, 'user data\n');
  await writeFile(config.agent.command, '#!/bin/sh\nset -e\necho 120 > score.txt\nmkdir -p bench/cache\nln -s "' + outside + '" bench/cache/injected\n');
  await writeFile(join(workspace, '.gitignore'), 'bench/cache/\n');
  await command(workspace, 'git', ['add', '.gitignore']);
  await command(workspace, 'git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'ignore']);
  const state = await runBenchmarkJob(config, jobDir);
  expect(state.iterations[0]?.outcome).toBe('rejected');
  expect(state.iterations[0]?.reason).toContain('bench/cache');
  expect(await readFile(outside, 'utf8')).toBe('user data\n');
  await expect(readFile(join(workspace, 'bench/cache/injected'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
});

test('restoration refuses forged symlink parents without touching outside user data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-rlm-restore-symlink-'));
  temporary.push(root);
  const workspace = join(root, 'workspace');
  const jobDir = join(root, 'job');
  const outside = join(root, 'outside');
  await mkdir(join(workspace, 'bench'), { recursive: true });
  await mkdir(outside);
  await mkdir(jobDir);
  await writeFile(join(workspace, 'bench/correct.txt'), 'yes\n');
  await writeFile(join(outside, 'correct.txt'), 'private\n');
  await snapshotProtected(workspace, jobDir, ['bench/correct.txt']);
  await rm(join(workspace, 'bench'), { recursive: true });
  await symlink(outside, join(workspace, 'bench'));
  await expect(restoreProtected(workspace, jobDir, ['bench/correct.txt'])).rejects.toThrow('Protected path has symlink parent: bench');
  expect(await readFile(join(outside, 'correct.txt'), 'utf8')).toBe('private\n');
});

test.each([
  ['dead supervisor', 2147483647, true],
  ['live supervisor still initializing', process.pid, false],
])('handles missing-state startup for %s', async (_scenario, pid, dead) => {
  const { root, workspace, jobDir } = await guardrailFixture('echo 120 > score.txt');
  await mkdir(jobDir, { recursive: true });
  await writeFile(join(jobDir, 'metadata.json'), JSON.stringify({ sourceWorkspace: workspace, branch: 'test-branch' }));
  await writeFile(join(jobDir, 'supervisor.json'), JSON.stringify({ pid, startedAt: new Date(Date.now() - 120_000).toISOString() }));
  const messages: string[] = [];
  const pi = { sendUserMessage: (text: string) => { messages.push(text); } } as any;
  await notifyCompleted(pi, workspace, root);
  await notifyCompleted(pi, workspace, root);
  expect(messages).toHaveLength(dead ? 1 : 0);
  const failurePath = join(jobDir, 'failure.json');
  if (dead) {
    expect(messages[0]).toContain('status failed');
    expect(messages[0]).toContain('before creating job state');
    expect(JSON.parse(await readFile(failurePath, 'utf8')).status).toBe('failed');
    expect(await readFile(join(jobDir, 'notification-sent'), 'utf8')).toBeTruthy();
  } else {
    await expect(readFile(failurePath, 'utf8')).rejects.toThrow();
    await expect(readFile(join(jobDir, 'notification-sent'), 'utf8')).rejects.toThrow();
  }
});
