import type { ActivityCall, ActivitySnapshot } from './activity.ts';
function callLine(call: ActivityCall, indent = '', note = ''): string {
  const state = call.status === 'active' ? call.phase : call.status;
  const duration = call.durationMs === undefined ? '' : ' ' + call.durationMs + 'ms';
  return indent + 'call ' + call.sequence + note + ' [' + call.tier + '] ' + state + ' turn ' + call.turn + ' tools ' + call.toolCallCount + duration;
}
/** Plain, bounded text consumed by Pi's wrapping Text component. */
export function formatActivity(activity: ActivitySnapshot, expanded: boolean): string {
  const t = activity.totals;
  const omitted = Math.max(0, t.calls - activity.calls.length);
  const summary = 'RLM: ' + t.active + ' active, ' + t.succeeded + ' succeeded, ' + t.failed + ' failed, ' + t.aborted + ' aborted; ' + t.modelTurns + ' turns, ' + t.toolCalls + ' tools'
    + (omitted ? '; ' + omitted + ' earlier call' + (omitted === 1 ? '' : 's') + ' omitted' : '');
  const ordered = [...activity.calls].sort((a, b) => a.sequence - b.sequence);
  if (!expanded) {
    const recent = [...ordered].sort((a, b) => Number(b.status === 'active') - Number(a.status === 'active') || b.updatedAt - a.updatedAt).slice(0, 5);
    return [summary, ...recent.map(call => callLine(call))].join(String.fromCharCode(10));
  }
  const retained = new Set(ordered.map(call => call.id));
  const children = new Map<string | undefined, ActivityCall[]>();
  for (const call of ordered) {
    const key = call.parentId !== undefined && retained.has(call.parentId) ? call.parentId : undefined;
    const list = children.get(key) ?? []; list.push(call); children.set(key, list);
  }
  const rows: string[] = [];
  const visit = (call: ActivityCall, level: number) => {
    const orphan = call.parentId !== undefined && !retained.has(call.parentId);
    const note = orphan ? ' (parent call ' + (call.parentSequence ?? '?') + ' omitted)' : '';
    rows.push(callLine(call, '  '.repeat(Math.min(level, 20)) + (level ? '- ' : ''), note));
    for (const child of children.get(call.id) ?? []) visit(child, level + 1);
  };
  for (const root of children.get(undefined) ?? []) visit(root, 0);
  return [summary, ...rows].join(String.fromCharCode(10));
}
