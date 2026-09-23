export const SCRATCHPAD_MAX_BYTES = 65_536;
export const SCRATCHPAD_INITIAL_TEXT = '# Shared scratchpad\n';

/** UTF-8 scratchpad shared by one RLM recursion tree, with optional write-through storage. */
export class Scratchpad {
  private text: string;
  private tail: Promise<void> = Promise.resolve();

  constructor(text = SCRATCHPAD_INITIAL_TEXT, private readonly persist?: (text: string) => void) {
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > SCRATCHPAD_MAX_BYTES) {
      throw new Error('Invalid saved scratchpad: expected text of at most 65536 UTF-8 bytes.');
    }
    this.text = text;
  }

  /** Queue a complete operation. Promise chaining provides a capacity-one FIFO mutex. */
  private run<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async read(offset = 0, len = 16_000): Promise<string> {
    return this.run(() => {
      if (!Number.isSafeInteger(offset) || offset < 0 ||
          !Number.isSafeInteger(len) || len < 0 || len > SCRATCHPAD_MAX_BYTES) {
        throw new Error('scratchpad.read(offset = 0, len = 16000): offset must be a nonnegative safe integer and len must be 0..65536 bytes.');
      }
      const bytes = Buffer.from(this.text, 'utf8');
      return bytes.subarray(offset, Math.min(bytes.length, offset + len)).toString('utf8');
    });
  }

  async edit(oldText: string, newText: string): Promise<void> {
    return this.run(() => {
      if (typeof oldText !== 'string' || oldText.length === 0 || typeof newText !== 'string') {
        throw new Error('scratchpad.edit(oldText, newText): oldText must be a nonempty string and newText must be a string.');
      }
      if (Buffer.byteLength(oldText, 'utf8') > SCRATCHPAD_MAX_BYTES ||
          Buffer.byteLength(newText, 'utf8') > SCRATCHPAD_MAX_BYTES) {
        throw new Error('scratchpad.edit failed: oldText and newText must each be at most 65536 UTF-8 bytes.');
      }
      const first = this.text.indexOf(oldText);
      if (first < 0) throw new Error('scratchpad.edit failed: oldText is absent or stale.');
      if (this.text.indexOf(oldText, first + 1) >= 0) {
        throw new Error('scratchpad.edit failed: oldText occurs more than once and is ambiguous.');
      }
      // Slicing at a surrogate boundary can change UTF-8 encoding, so measure the exact candidate.
      const result = this.text.slice(0, first) + newText + this.text.slice(first + oldText.length);
      if (Buffer.byteLength(result, 'utf8') > SCRATCHPAD_MAX_BYTES) {
        throw new Error('scratchpad.edit failed: result exceeds the 65536-byte UTF-8 limit.');
      }
      // A failed save must reject the edit without changing the live scratchpad.
      this.persist?.(result);
      this.text = result;
    });
  }
}
