import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { closeSync, openSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import type { BenchmarkJobConfig, BenchmarkJobState } from './types.ts';

const jobsRoot = join(homedir(), '.pi', 'agent', 'rlm-jobs');
const cliPath = fileURLToPath(new URL('./cli.ts', import.meta.url));
const agentPath = fileURLToPath(new URL('./pi-agent.ts', import.meta.url));

async function capture(command: string, args: string[], cwd: string): Promise<string> {
  return await new Promise((ok, fail) => {
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', fail);
    child.once('close', code => code === 0 ? ok(stdout.trim()) : fail(new Error(stderr.trim() || command + ' failed')));
  });
}

export const longHorizonInstructions = 
  'When the user gives an explicit measurable optimization target that may require repeated attempts (for example, improve a benchmark by 10%), delegate discovery of the existing canonical verifier and protected benchmark/correctness paths, then start the autonomous long-horizon supervisor with start_long_horizon instead of asking the user to manage iterations. Use compact worker recommendations to choose a finite deadline. Do not inspect those repository artifacts directly, use this tool for ordinary tasks, or invoke it from a prompt identifying the agent as an autonomous iteration worker.';

export async function notifyCompleted(pi: Pick<ExtensionAPI, 'sendUserMessage'>, cwd: string, root = jobsRoot): Promise<void> {
    let entries: string[];
    try { entries = await readdir(root); } catch { return; }
    for (const name of entries) {
      const dir = join(root, name);
      try {
        const metadata = JSON.parse(await readFile(join(dir, 'metadata.json'), 'utf8')) as { sourceWorkspace: string; branch: string };
        if (resolve(metadata.sourceWorkspace) !== resolve(cwd)) continue;
        let message: string;
        // failure.json wins over a stale 'running' state if the CLI crashed while
        // updating state.json, or initialization failed before state was created.
        let failure: { error: string } | undefined;
        try { failure = JSON.parse(await readFile(join(dir, 'failure.json'), 'utf8')) as { error: string }; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (failure) {
          message = 'status failed. Error: ' + failure.error;
        } else {
          const state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')) as BenchmarkJobState;
          if (state.status === 'running') continue;
          message = 'status ' + state.status + '. Best score: ' + state.bestScore + '; target: ' + state.targetScore + '.';
        }
        const marker = join(dir, 'notification-sent');
        try { await readFile(marker); continue; } catch {}
        pi.sendUserMessage('Autonomous benchmark job ' + name + ' finished with ' + message + ' Delegate inspection of ' + join(dir, 'state.json') + ' and branch ' + metadata.branch + ', plus independent review and deterministic verification; then report only a compact verified result to the user.');
        await writeFile(marker, new Date().toISOString() + '\n', { mode: 0o600 });
      } catch { /* A partially created or unrelated job is not ready. */ }
    }
}

export function registerLongHorizon(pi: ExtensionAPI) {
  let poller: ReturnType<typeof setInterval> | undefined;
  pi.on('session_start', async (_event, ctx) => {
    await notifyCompleted(pi, ctx.cwd);
    poller = setInterval(() => { void notifyCompleted(pi, ctx.cwd); }, 5000);
    poller.unref();
  });
  pi.on('session_shutdown', () => { if (poller) clearInterval(poller); poller = undefined; });

  pi.registerTool({
    name: 'start_long_horizon',
    label: 'Start autonomous benchmark job',
    description: 'Start a durable autonomous optimization job. Use only for an explicit measurable benchmark target; no follow-up input is required.',
    parameters: Type.Object({
      objective: Type.String(),
      verifierCommand: Type.String({ description: 'Trusted canonical verifier executable. Workspace-local verifier scripts and their dependencies must be tracked protected paths. It must print {valid:boolean,score:number,summary?:string}.' }),
      verifierArgs: Type.Optional(Type.Array(Type.String())),
      targetImprovement: Type.Optional(Type.Number({ minimum: 0.001, maximum: 10 })),
      deadlineMinutes: Type.Optional(Type.Number({ minimum: 1, maximum: 10080 })),
      protectedPaths: Type.Array(Type.String(), { minItems: 1, description: 'Tracked benchmark and correctness paths the optimizer must not modify.' }),
      maxIterations: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const sourceWorkspace = await capture('git', ['rev-parse', '--show-toplevel'], ctx.cwd);
      const id = new Date().toISOString().replace(/[-:.TZ]/g, '') + '-' + crypto.randomUUID().slice(0, 8);
      const dir = join(jobsRoot, id);
      const workspace = join(dir, 'worktree');
      const branch = 'rlm/' + id;
      await mkdir(dir, { recursive: true });
      await capture('git', ['worktree', 'add', '-b', branch, workspace, 'HEAD'], sourceWorkspace);
      const config: BenchmarkJobConfig = {
        version: 1,
        objective: params.objective,
        workspace,
        deadlineAt: new Date(Date.now() + (params.deadlineMinutes ?? 1440) * 60_000).toISOString(),
        maxIterations: params.maxIterations ?? 50,
        targetImprovement: params.targetImprovement ?? 0.10,
        protectedPaths: params.protectedPaths,
        agent: { command: 'bun', args: [agentPath], timeoutMs: 30 * 60_000 },
        verifier: { command: params.verifierCommand, args: params.verifierArgs ?? [], timeoutMs: 30 * 60_000 },
      };
      const configPath = join(dir, 'config.json');
      await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
      await writeFile(join(dir, 'metadata.json'), JSON.stringify({ sourceWorkspace, branch }, null, 2) + '\n', { mode: 0o600 });
      const out = openSync(join(dir, 'supervisor.stdout.log'), 'a', 0o600);
      const err = openSync(join(dir, 'supervisor.stderr.log'), 'a', 0o600);
      try {
        const child = spawn('bun', [cliPath, configPath, dir], { cwd: sourceWorkspace, detached: true, stdio: ['ignore', out, err] });
        await new Promise<void>((ok, fail) => { child.once('spawn', ok); child.once('error', fail); });
        child.unref();
      } finally { closeSync(out); closeSync(err); }
      return { content: [{ type: 'text', text: 'Started autonomous job ' + id + '. It will continue without user input. State: ' + join(dir, 'state.json') + '; result branch: ' + branch }], details: { id, dir, branch } };
    },
  });
}
