import { appendFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLimits } from './limits.ts';
import { Worker } from 'node:worker_threads';
import { bash } from './bash.ts';
import type { QueryOptions } from './rlm.ts';

export type Query = (prompt: string, context: string, signal: AbortSignal, options?: QueryOptions) => Promise<string>;
export interface ExecResult { text: string; isError: boolean }

/** A terminable worker keeps runaway JavaScript from blocking pi's event loop. */
export class Runtime {
  private worker?: Worker;
  resultsPath?: string;
  private journalWrites: Promise<void> = Promise.resolve();
  private resultId = 0;

  private saveResult(prompt: string, requestedModel: string, result: string) {
    const record = { id: ++this.resultId, prompt, requestedModel, result, completedAt: new Date().toISOString() };
    const write = this.journalWrites.then(async () => {
      this.resultsPath ??= join(await mkdtemp(join(tmpdir(), 'pi-rlm-results-')), 'results.jsonl');
      await appendFile(this.resultsPath, JSON.stringify(record) + '\n', { mode: 0o600 });
    });
    this.journalWrites = write.catch(() => {});
    return write;
  }
  private cancel?: (reason: string) => void;
  private termination: Promise<void> = Promise.resolve();
  constructor(private cwd: string, private context = '') {}

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
        if (message.type === 'query' || message.type === 'bash') {
          const type = message.type === 'bash' ? 'bashResult' : 'queryResult';
          try {
            const result = message.type === 'bash'
              ? await bash(message.command, this.cwd, controller.signal)
              : await query(message.prompt, message.context, controller.signal, message.options);
            if (!done && message.type === 'query') await this.saveResult(message.prompt, message.options?.model ?? 'routine', result as string);
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
