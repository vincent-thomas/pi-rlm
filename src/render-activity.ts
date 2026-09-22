import type { ActivityCall, ActivitySnapshot } from './activity.ts';

function statusIcon(call: ActivityCall): string {
  if (call.status === 'active') return '●';
  if (call.status === 'succeeded') return '✓';
  if (call.status === 'failed') return '✗';
  return '■';
}
function duration(ms?: number): string {
  if (ms === undefined) return '';
  return ms < 1000 ? ' · ' + ms + 'ms' : ' · ' + (ms / 1000).toFixed(1) + 's';
}
function callText(call: ActivityCall, orphan: boolean): string {
  const state = call.status === 'active'
    ? (call.phase === 'verification' ? 'verification ' + call.verificationRound : call.phase + ' ' + call.turn)
    : call.status + ' · ' + call.turn + ' turn' + (call.turn === 1 ? '' : 's');
  const execs = call.toolCallCount ? ' · ' + call.toolCallCount + ' exec' + (call.toolCallCount === 1 ? '' : 's') : '';
  const parent = orphan ? ' · parent #' + (call.parentSequence ?? '?') + ' omitted' : '';
  return statusIcon(call) + ' #' + call.sequence + ' ' + call.tier + ' · ' + state + execs + duration(call.durationMs) + parent;
}

interface TreeRow { call: ActivityCall; text: string }
function treeRows(calls: ActivityCall[]): TreeRow[] {
  const ordered = [...calls].sort((a, b) => a.sequence - b.sequence);
  const retained = new Set(ordered.map(call => call.id));
  const children = new Map<string | undefined, ActivityCall[]>();
  for (const call of ordered) {
    const key = call.parentId !== undefined && retained.has(call.parentId) ? call.parentId : undefined;
    const list = children.get(key) ?? [];
    list.push(call);
    children.set(key, list);
  }
  const rows: TreeRow[] = [];
  const visit = (call: ActivityCall, prefix: string, last: boolean) => {
    const orphan = call.parentId !== undefined && !retained.has(call.parentId);
    rows.push({ call, text: prefix + (last ? '└─ ' : '├─ ') + callText(call, orphan) });
    const descendants = children.get(call.id) ?? [];
    const childPrefix = prefix + (last ? '   ' : '│  ');
    descendants.forEach((child, index) => visit(child, childPrefix, index === descendants.length - 1));
  };
  const roots = children.get(undefined) ?? [];
  roots.forEach((root, index) => visit(root, '', index === roots.length - 1));
  return rows;
}

/** A compact tree for the collapsed tool row and the complete retained tree when expanded. */
export function formatActivity(activity: ActivitySnapshot, expanded: boolean): string {
  const t = activity.totals;
  const terminal = t.succeeded + t.failed + t.aborted;
  let summary = 'RLM  ' + (t.active ? '● ' + t.active + ' active' : '✓ ' + terminal + ' finished')
    + ' · ' + t.modelTurns + ' turns · ' + t.toolCalls + ' execs';
  if (t.failed) summary += ' · ' + t.failed + ' failed';
  if (t.aborted) summary += ' · ' + t.aborted + ' aborted';
  const retainedOmitted = Math.max(0, t.calls - activity.calls.length);
  if (retainedOmitted) summary += ' · ' + retainedOmitted + ' earlier omitted';

  const rows = treeRows(activity.calls);
  const visible = expanded ? rows : rows.slice(0, 8);
  const hidden = rows.length - visible.length;
  const output = [summary, ...visible.map(row => row.text)];
  if (hidden) output.push('└─ … ' + hidden + ' more call' + (hidden === 1 ? '' : 's') + ' (Ctrl+O to expand)');
  return output.join(String.fromCharCode(10));
}
