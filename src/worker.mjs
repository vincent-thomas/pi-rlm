import { parentPort, workerData } from 'node:worker_threads';
import { createContext, Script } from 'node:vm';
import { inspect } from 'node:util';
import { open } from 'node:fs/promises';
import { resolve } from 'node:path';

const pending = new Map();
let nextId = 0;
let output = '';
let truncated = false;
let activeReads = 0;
const limit = 16000;
function print(...args) {
  const text = args.map(x => typeof x === 'string' ? x : inspect(x, { depth: 4, maxArrayLength: 50, maxStringLength: limit })).join(' ') + '\n';
  if (output.length + text.length > limit) truncated = true;
  output += text.slice(0, Math.max(0, limit - output.length));
}
function request(type, args) {
  const id = ++nextId;
  const result = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  result.catch(() => {});
  parentPort.postMessage({ type, id, ...args });
  return result;
}
const sandbox = createContext({
  state: {}, context: workerData.context, print,
  // Node's vm provides a console by default; explicitly remove it.
  console: undefined,
  readFile: async (path, len = 16000, offset = 0) => {
    if (typeof path !== 'string' || !Number.isSafeInteger(len) || len < 0 || len > 1048576 || !Number.isSafeInteger(offset) || offset < 0) {
      throw new Error('readFile(path, len = 16000, offset = 0): len must be 0..1048576 bytes and offset a nonnegative safe integer.');
    }
    activeReads++;
    try {
      const file = await open(resolve(workerData.cwd, path), 'r');
      try {
        const buffer = Buffer.alloc(len);
        const { bytesRead } = await file.read(buffer, 0, len, offset);
        return buffer.subarray(0, bytesRead).toString('utf8');
      } finally { await file.close(); }
    } finally { activeReads--; }
  },
  bash: command => request('bash', { command }),
  llm_query: (prompt, context = '', options = {}) => {
    if (typeof prompt !== 'string' || typeof context !== 'string') {
      return Promise.reject(new Error('llm_query(prompt, context, options) requires prompt and context strings'));
    }
    if (options === null || typeof options !== 'object' || Array.isArray(options) ||
        (options.model !== undefined && !['routine', 'smart', 'agi'].includes(options.model))) {
      return Promise.reject(new Error("llm_query options.model must be 'routine', 'smart', or 'agi'"));
    }
    return request('query', { prompt, context, options: { model: options.model ?? 'routine' } });
  },
});
parentPort.on('message', async message => {
  if (message.type === 'queryResult' || message.type === 'bashResult') {
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) waiter?.reject(new Error(message.error));
    else waiter?.resolve(message.result);
    return;
  }
  if (message.type !== 'exec') return;
  output = ''; truncated = false;
  try {
    await new Script(`(async () => {\n${message.code}\n})()`, { filename: 'rlm-exec.js' }).runInContext(sandbox);
    if (pending.size || activeReads) throw new Error('Await every bash, readFile, and llm_query call before ending the cell.');
    parentPort.postMessage({ type: 'result', text: output + (truncated ? '\n[Output truncated; print smaller slices.]' : ''), isError: false });
  } catch (error) {
    parentPort.postMessage({ type: 'result', text: output + '\n' + String(error), isError: true, reset: pending.size > 0 || activeReads > 0 });
  }
});
