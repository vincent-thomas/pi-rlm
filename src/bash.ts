import { spawn } from 'node:child_process';
import { mkdtemp, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface BashResult {
  exitCode: number;
  stdoutPath: string;
  stderrPath: string;
}

/** Stream directly to private log files, without buffering command output. */
export async function bash(command: string, cwd: string, signal: AbortSignal): Promise<BashResult> {
  if (typeof command !== 'string') throw new Error('bash(command) requires a string.');
  signal.throwIfAborted();
  const directory = await mkdtemp(join(tmpdir(), 'pi-rlm-'));
  const stdoutPath = join(directory, 'stdout.log');
  const stderrPath = join(directory, 'stderr.log');
  const stdout = await open(stdoutPath, 'wx', 0o600);
  try {
    const stderr = await open(stderrPath, 'wx', 0o600);
    try {
      signal.throwIfAborted();
      return await new Promise<BashResult>((resolve, reject) => {
        const child = spawn('bash', ['-o', 'pipefail', '-c', command], {
          cwd, detached: process.platform !== 'win32', stdio: ['ignore', stdout.fd, stderr.fd],
        });
        const abort = () => {
          if (!child.pid) return;
          try {
            if (process.platform === 'win32') child.kill('SIGKILL');
            else process.kill(-child.pid, 'SIGKILL');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill('SIGKILL');
          }
        };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        child.once('error', error => {
          signal.removeEventListener('abort', abort);
          reject(Object.assign(error, { stdoutPath, stderrPath }));
        });
        child.once('close', (code, terminationSignal) => {
          signal.removeEventListener('abort', abort);
          if (signal.aborted) reject(Object.assign(new Error('Bash execution aborted.'), { stdoutPath, stderrPath }));
          else resolve({ exitCode: code ?? (terminationSignal === 'SIGKILL' ? 137 : 128), stdoutPath, stderrPath });
        });
      });
    } finally { await stderr.close(); }
  } finally { await stdout.close(); }
}
