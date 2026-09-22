import type { ModelTier } from './rlm.ts';
export type ActivityPhase = 'model' | 'exec' | 'verification';
export type ActivityStatus = 'active' | 'succeeded' | 'failed' | 'aborted';
export type TerminalActivityStatus = Exclude<ActivityStatus, 'active'>;
export interface ActivityCall { id: string; sequence: number; parentId?: string; parentSequence?: number; depth: number; tier: ModelTier; turn: number; phase: ActivityPhase; toolCallCount: number; verificationRound: number; status: ActivityStatus; startedAt: number; updatedAt: number; endedAt?: number; durationMs?: number; }
export interface ActivityTotals { calls: number; active: number; succeeded: number; failed: number; aborted: number; modelTurns: number; toolCalls: number; durationMs: number; }
export interface ActivitySnapshot { calls: ActivityCall[]; totals: ActivityTotals; updatedAt: number; }
export type ActivityEvent =
  | { type: 'started'; id: string; parentId?: string; depth: number; tier: ModelTier; at: number }
  | { type: 'model'; id: string; turn: number; at: number }
  | { type: 'exec'; id: string; toolCalls: number; at: number }
  | { type: 'verification'; id: string; round: number; at: number }
  | { type: 'terminal'; id: string; status: TerminalActivityStatus; at: number };
export interface ActivityReporter {
  start(input: { parentId?: string; depth: number; tier: ModelTier }): string;
  model(id: string, turn: number): void;
  exec(id: string, toolCalls: number): void;
  verification(id: string, round: number): void;
  terminal(id: string, status: TerminalActivityStatus): void;
}
export interface ActivityContext { reporter: ActivityReporter; parentId?: string; }
export function emptyActivitySnapshot(at = Date.now()): ActivitySnapshot {
  return { calls: [], totals: { calls: 0, active: 0, succeeded: 0, failed: 0, aborted: 0, modelTurns: 0, toolCalls: 0, durationMs: 0 }, updatedAt: at };
}
/** Pure reducer. Terminal retention never removes an active call. */
export function reduceActivity(previous: ActivitySnapshot, event: ActivityEvent, terminalRetention = 100): ActivitySnapshot {
  const calls = previous.calls.map(call => ({ ...call })); const totals = { ...previous.totals }; const index = calls.findIndex(call => call.id === event.id);
  if (event.type === 'started') {
    if (index >= 0) return previous;
    const parentSequence = event.parentId === undefined ? undefined : calls.find(call => call.id === event.parentId)?.sequence;
    calls.push({ id: event.id, sequence: totals.calls + 1, parentId: event.parentId, parentSequence, depth: event.depth, tier: event.tier, turn: 0, phase: 'model', toolCallCount: 0, verificationRound: 0, status: 'active', startedAt: event.at, updatedAt: event.at }); totals.calls++; totals.active++;
  } else {
    if (index < 0 || calls[index]!.status !== 'active') return previous;
    const call = calls[index]!; call.updatedAt = event.at;
    if (event.type === 'model') { if (event.turn > call.turn) totals.modelTurns += event.turn - call.turn; call.turn = Math.max(call.turn, event.turn); call.phase = 'model'; }
    else if (event.type === 'verification') { call.verificationRound = Math.max(call.verificationRound, event.round); call.phase = 'verification'; }
    else if (event.type === 'exec') { const count = Math.max(call.toolCallCount, event.toolCalls); totals.toolCalls += count - call.toolCallCount; call.toolCallCount = count; call.phase = 'exec'; }
    else { call.status = event.status; call.endedAt = event.at; call.durationMs = Math.max(0, event.at - call.startedAt); totals.active--; totals[event.status]++; totals.durationMs += call.durationMs; }
  }
  const limit = Math.max(0, terminalRetention); const terminals = calls.filter(call => call.status !== 'active').sort((a, b) => b.updatedAt - a.updatedAt); const retained = new Set(terminals.slice(0, limit).map(call => call.id));
  return { calls: calls.filter(call => call.status === 'active' || retained.has(call.id)), totals, updatedAt: event.at };
}
export interface ActivityPublisherOptions { terminalRetention?: number; now?: () => number; id?: () => string; }
/** Owns activity state and publishes immutable, metadata-only snapshots. */
export class ActivityPublisher implements ActivityReporter {
  private state: ActivitySnapshot; private sequence = 0; private readonly now: () => number; private readonly makeId: () => string; private readonly retention: number;
  constructor(private readonly publish: (snapshot: ActivitySnapshot) => void, options: ActivityPublisherOptions = {}) { this.now = options.now ?? Date.now; this.makeId = options.id ?? (() => 'rlm-' + this.now().toString(36) + '-' + (++this.sequence).toString(36)); this.retention = options.terminalRetention ?? 100; this.state = emptyActivitySnapshot(this.now()); }
  snapshot(): ActivitySnapshot { return structuredClone(this.state); }
  initial(): void { this.safePublish(); }
  start(input: { parentId?: string; depth: number; tier: ModelTier }): string { const id = this.makeId(); this.apply({ type: 'started', id, ...input, at: this.now() }); return id; }
  model(id: string, turn: number): void { this.apply({ type: 'model', id, turn, at: this.now() }); }
  exec(id: string, toolCalls: number): void { this.apply({ type: 'exec', id, toolCalls, at: this.now() }); }
  verification(id: string, round: number): void { this.apply({ type: 'verification', id, round, at: this.now() }); }
  terminal(id: string, status: TerminalActivityStatus): void { this.apply({ type: 'terminal', id, status, at: this.now() }); }
  private apply(event: ActivityEvent): void { this.state = reduceActivity(this.state, event, this.retention); this.safePublish(); }
  private safePublish(): void { try { this.publish(this.snapshot()); } catch { /* Observers cannot affect execution. */ } }
}

/** Leading-edge, trailing-coalesced delivery with an explicit final flush. */
export class ActivityUpdateSink {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pending: ActivitySnapshot | undefined;
  private lastSent = 0; private sent = false;
  private closed = false;
  constructor(private readonly send: (snapshot: ActivitySnapshot) => unknown, private readonly intervalMs = 100,
    private readonly clock: () => number = Date.now) {}
  push(snapshot: ActivitySnapshot): void {
    if (this.closed) return;
    const now = this.clock();
    if (!this.sent || now - this.lastSent >= this.intervalMs) { this.deliver(snapshot, now); return; }
    this.pending = snapshot;
    if (!this.timer) this.timer = setTimeout(() => {
      this.timer = undefined;
      const value = this.pending; this.pending = undefined;
      if (value && !this.closed) this.deliver(value, this.clock());
    }, Math.max(0, this.intervalMs - (now - this.lastSent)));
  }
  finish(snapshot: ActivitySnapshot): void {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined; this.pending = undefined;
    this.deliver(snapshot, this.clock());
    this.closed = true;
  }
  private deliver(snapshot: ActivitySnapshot, now: number): void {
    this.lastSent = now; this.sent = true;
    try {
      const result = this.send(structuredClone(snapshot));
      if (result && typeof (result as PromiseLike<unknown>).then === 'function')
        Promise.resolve(result).catch(() => {});
    } catch { /* Rendering/update errors must not affect execution. */ }
  }
}
