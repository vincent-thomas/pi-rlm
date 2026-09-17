import { mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { BenchmarkJobState } from './types.ts';

export const statePath = (jobDir: string) => join(jobDir, 'state.json');

export async function loadState(jobDir: string): Promise<BenchmarkJobState> {
  return JSON.parse(await readFile(statePath(jobDir), 'utf8')) as BenchmarkJobState;
}

export async function saveState(jobDir: string, state: BenchmarkJobState): Promise<void> {
  await mkdir(jobDir, { recursive: true });
  state.updatedAt = new Date().toISOString();
  const path = statePath(jobDir);
  const temporary = join(jobDir, '.state.' + process.pid + '.' + crypto.randomUUID() + '.tmp');
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(JSON.stringify(state, null, 2) + '\n'); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, path);
}

export async function withJobLock<T>(jobDir: string, action: () => Promise<T>): Promise<T> {
  await mkdir(jobDir, { recursive: true });
  const lock = join(jobDir, 'lock');
  let handle;
  try { handle = await open(lock, 'wx', 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Long-horizon job is already running: ' + jobDir);
    throw error;
  }
  try { return await action(); }
  finally { await handle.close(); await rm(lock, { force: true }); }
}
