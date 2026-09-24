import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runBenchmarkJob, type BenchmarkJobConfig } from './supervisor.ts';
import { loadState, saveState } from './store.ts';

const [, , configPath, jobDirArgument] = process.argv;
if (!configPath || !jobDirArgument) throw new Error('Usage: bun cli.ts <config.json> <job-directory>');
const jobDir = resolve(jobDirArgument);
try {
  const config = JSON.parse(await readFile(resolve(configPath), 'utf8')) as BenchmarkJobConfig;
  const state = await runBenchmarkJob(config, jobDir);
  process.stdout.write(JSON.stringify({ status: state.status, bestScore: state.bestScore, targetScore: state.targetScore, statePath: resolve(jobDir, 'state.json') }) + '\n');
} catch (error) {
  await mkdir(jobDir, { recursive: true });
  await writeFile(resolve(jobDir, 'failure.json'), JSON.stringify({ status: 'failed', error: String(error), failedAt: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
  try {
    const state = await loadState(jobDir);
    if (state.status === 'running') {
      state.status = 'failed';
      state.stopReason = String(error);
      await saveState(jobDir, state);
    }
  } catch { /* A failure before initialization has no state; failure.json remains authoritative. */ }
  process.stderr.write(String(error) + '\n');
  process.exitCode = 1;
}
