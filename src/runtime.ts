import { appendFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLimits } from './limits.ts';
import { Worker } from 'node:worker_threads';
import { bash } from './bash.ts';
import type { QueryOptions, QueryResult } from './rlm.ts';
import { Scratchpad } from './scratchpad.ts';
import { gitPreflight, validateClaims } from './git-preflight.ts';

export type Query = (prompt: string, signal: AbortSignal, options?: QueryOptions) => Promise<QueryCompletion>;
/** Internal completion; Runtime adds journal metadata after the append succeeds. */
export type QueryCompletion = Pick<QueryResult, 'answer' | 'verification'>;
export interface ExecResult { text: string; isError: boolean }

/** A terminable worker keeps runaway JavaScript from blocking pi's event loop. */
export class Runtime {
  private worker?: Worker;
  resultsPath?: string;
  private journalWrites: Promise<void> = Promise.resolve();
  private resultId = 0;

  private async saveResult(prompt: string, requestedModel: string, result: QueryCompletion): Promise<QueryResult> {
    const id = String(++this.resultId);
    const record = { id, prompt, requestedModel, result: result.answer, completedAt: new Date().toISOString(), ...(result.verification === undefined ? {} : { verification: result.verification }) };
    const write = this.journalWrites.then(async () => {
      this.resultsPath ??= join(await mkdtemp(join(tmpdir(), 'pi-rlm-results-')), 'results.jsonl');
      await appendFile(this.resultsPath, JSON.stringify(record) + '\n', { mode: 0o600 });
    });
    this.journalWrites = write.catch(() => {});
    await write;
    return { ...result, journal: { path: this.resultsPath!, id } };
  }
  private cancel?: (reason: string) => void;
  private termination: Promise<void> = Promise.resolve();
  constructor(private cwd: string, private context = '', private scratchpad = new Scratchpad()) {}

  private terminate(worker: Worker) {
    if (this.worker === worker) this.worker = undefined;
    const stopped = worker.terminate().then(() => undefined, () => undefined);
    this.termination = Promise.all([this.termination, stopped]).then(() => undefined);
  }

  private async waitForTermination() {
    while (true) {
      const pending = this.termination;
      await pending;
      if (pending === this.termination) return;
    }
  }

  dispose() {
    this.cancel?.('JavaScript workspace reset.');
    if (this.worker) this.terminate(this.worker);
  }

  async exec(code: string, query: Query, signal?: AbortSignal, timeoutMs = readLimits().execTimeoutMs): Promise<ExecResult> {
    if (this.cancel) throw new Error('An exec cell is already running.');
    if (signal?.aborted) throw new Error('Execution aborted.');
    await this.waitForTermination();
    await this.journalWrites;
    if (this.cancel) throw new Error('An exec cell is already running.');
    if (signal?.aborted) throw new Error('Execution aborted.');
    const worker = this.worker ??= new Worker(new URL('./worker.mjs', import.meta.url), {
      workerData: { cwd: this.cwd, context: this.context },
    });
    const controller = new AbortController();
    return new Promise(resolve => {
      let done = false;
      const finish = (result: ExecResult, reset = false) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        worker.off('message', onMessage);
        worker.off('error', onError);
        worker.off('exit', onExit);
        this.cancel = undefined;
        controller.abort();
        if (reset) this.terminate(worker);
        void this.journalWrites.then(() => {
          if (reset && this.resultsPath) result.text += '\nCompleted child results: ' + this.resultsPath;
          resolve(result);
        });
      };
      const abort = () => finish({ text: 'Execution aborted; workspace reset.', isError: true }, true);
      const onError = (error: Error) => finish({ text: error.message, isError: true }, true);
      const onExit = (code: number) => finish({ text: `Worker exited (${code}); workspace reset.`, isError: true }, true);
      const onMessage = async (message: any) => {
        if (message.type === 'result') finish({ text: message.text || '(no output)', isError: message.isError }, message.reset);
        if (message.type === 'query' || message.type === 'bash' || message.type === 'scratchpadRead' || message.type === 'scratchpadEdit' || message.type === 'gitPreflight' || message.type === 'validateClaims') {
          const type = message.type === 'bash' ? 'bashResult' : message.type === 'query' ? 'queryResult' : message.type === 'gitPreflight' || message.type === 'validateClaims' ? 'gitResult' : 'scratchpadResult';
          try {
            let result = message.type === 'bash'
              ? await bash(message.command, this.cwd, controller.signal)
              : message.type === 'query'
                ? await query(message.prompt, controller.signal, message.options)
                : message.type === 'scratchpadRead'
                  ? await this.scratchpad.read(message.offset, message.len)
                  : message.type === 'scratchpadEdit'
                    ? await this.scratchpad.edit(message.oldText, message.newText)
                    : message.type === 'gitPreflight'
                      ? await gitPreflight(this.cwd, controller.signal)
                      : await validateClaims(this.cwd, controller.signal, message.claims);
            if (!done && message.type === 'query') result = await this.saveResult(message.prompt, message.options?.model ?? 'smart', result as Awaited<ReturnType<Query>>);
            if (!done) worker.postMessage({ type, id: message.id, result, resultsPath: this.resultsPath });
          } catch (error) {
            if (!done) worker.postMessage({ type, id: message.id, error: String(error) });
          }
        }
      };
      const timer = timeoutMs === 0 ? undefined : setTimeout(() => finish({ text: 'Execution timed out; workspace reset.', isError: true }, true), timeoutMs);
      this.cancel = reason => finish({ text: reason, isError: true }, true);
      signal?.addEventListener('abort', abort, { once: true });
      worker.on('message', onMessage);
      worker.on('error', onError);
      worker.on('exit', onExit);
      worker.postMessage({ type: 'exec', code, resultsPath: this.resultsPath });
    });
  }
}
