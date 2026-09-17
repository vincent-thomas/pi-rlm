import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';
import type { CommandSpec } from './types.ts';

export interface ProcessResult {
  exitCode: number | null;
  timedOut: boolean;
  stdoutPath: string;
  stderrPath: string;
}

export async function runProcess(spec: CommandSpec, cwd: string, logPrefix: string, deadlineAt: number, input?: string): Promise<ProcessResult> {
  await mkdir(dirname(logPrefix), { recursive: true });
  const stdoutPath = logPrefix + '.stdout.log';
  const stderrPath = logPrefix + '.stderr.log';
  const stdout = await open(stdoutPath, 'w', 0o600);
  const stderr = await open(stderrPath, 'w', 0o600);
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) {
    await stdout.close(); await stderr.close();
    return { exitCode: null, timedOut: true, stdoutPath, stderrPath };
  }
  const timeoutMs = Math.min(spec.timeoutMs ?? remaining, remaining);
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(spec.command, spec.args ?? [], {
        cwd, detached: process.platform !== 'win32',
        stdio: [input === undefined ? 'ignore' : 'pipe', stdout.fd, stderr.fd],
      });
      let timedOut = false;
      const kill = () => {
        timedOut = true;
        if (!child.pid) return;
        try {
          if (process.platform === 'win32') child.kill('SIGKILL');
          else process.kill(-child.pid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill('SIGKILL');
        }
      };
      const timer = setTimeout(kill, timeoutMs);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { clearTimeout(timer); resolve({ exitCode: code, timedOut, stdoutPath, stderrPath }); });
      child.stdin?.on('error', () => { /* Early child exit may close stdin before the prompt is consumed. */ });
      if (input !== undefined) child.stdin?.end(input);
    });
  } finally { await stdout.close(); await stderr.close(); }
}
