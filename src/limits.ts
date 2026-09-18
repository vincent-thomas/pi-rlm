export interface Limits {
  execTimeoutMs: number;
  requestTimeoutMs: number;
  maxCalls: number;
  maxTurns: number;
}

/** Read fresh environment settings for each invocation. */
export function readLimits(): Limits {
  const read = (name: string, fallback: number, minimum: number, maximum: number) => {
    const raw = process.env[name];
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(value) || value < minimum || value > maximum) {
      throw new Error(name + ' must be an integer between ' + minimum + ' and ' + maximum + '.');
    }
    return value;
  };
  return {
    execTimeoutMs: read('PI_RLM_EXEC_TIMEOUT_MS', 1_800_000, 0, 2_147_483_647),
    requestTimeoutMs: read('PI_RLM_REQUEST_TIMEOUT_MS', 300_000, 0, 2_147_483_647),
    maxCalls: read('PI_RLM_MAX_CALLS', 1000, 1, Number.MAX_SAFE_INTEGER),
    maxTurns: read('PI_RLM_MAX_TURNS', 64, 1, 1000),
  };
}
