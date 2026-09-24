import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const PATH_LIMIT = 20, WORKTREE_LIMIT = 10;
async function git(cwd: string, signal: AbortSignal, ...args: string[]) {
  const { stdout } = await exec('git', args, { cwd, signal, timeout: 5000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' });
  return stdout;
}
export interface GitPreflight {
  root: string; branch: string | null; head: string;
  dirtyCount: number; dirtyPaths: Array<{ status: string; path: string }>; omittedDirtyPaths: number;
  worktreeCount: number; worktrees: Array<{ path: string; branch: string | null }>; omittedWorktrees: number;
}
/** Read-only, compact Git snapshot. Paths may reveal sensitive names: call only when needed. */
export async function gitPreflight(cwd: string, signal: AbortSignal): Promise<GitPreflight> {
  const [root, head, branchName, status, worktreeList] = await Promise.all([
    git(cwd, signal, 'rev-parse', '--show-toplevel'), git(cwd, signal, 'rev-parse', 'HEAD'),
    git(cwd, signal, 'symbolic-ref', '--quiet', '--short', 'HEAD').catch(error => {
      if (error?.code === 1) return ''; // detached HEAD
      throw error;
    }),
    git(cwd, signal, 'status', '--porcelain=v1', '-z', '--untracked-files=all'),
    git(cwd, signal, 'worktree', 'list', '--porcelain', '-z'),
  ]);
  const fields = status.split('\0');
  const dirtyPaths: GitPreflight['dirtyPaths'] = [];
  let dirtyCount = 0;
  for (let i = 0; i < fields.length && fields[i]; i++) {
    const entry = fields[i]!;
    const code = entry.slice(0, 2);
    if (code.includes('R') || code.includes('C')) i++; // porcelain -z appends original path
    dirtyCount++;
    if (dirtyPaths.length < PATH_LIMIT) dirtyPaths.push({ status: code, path: entry.slice(3) });
  }
  const worktrees: GitPreflight['worktrees'] = [];
  let worktreeCount = 0;
  for (const record of worktreeList.split('\0\0').filter(Boolean)) {
    const lines = record.split('\0');
    const path = lines.find(line => line.startsWith('worktree '))?.slice(9);
    if (!path) continue;
    worktreeCount++;
    const branch = lines.find(line => line.startsWith('branch refs/heads/'))?.slice(18) ?? null;
    if (worktrees.length < WORKTREE_LIMIT) worktrees.push({ path, branch });
  }
  return { root: root.trim(), branch: branchName.trim() || null, head: head.trim(), dirtyCount, dirtyPaths,
    omittedDirtyPaths: dirtyCount - dirtyPaths.length, worktreeCount, worktrees,
    omittedWorktrees: worktreeCount - worktrees.length };
}
export interface Claims {
  branch?: string; head?: string; pr?: { number?: number; url?: string; headBranch?: string };
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/** Consistency checks only; a locally matching PR claim is NOT verified with GitHub. */
export async function validateClaims(cwd: string, signal: AbortSignal, value: unknown) {
  if (!object(value) || Object.keys(value).some(key => !['branch', 'head', 'pr'].includes(key)) ||
      (value.branch !== undefined && (typeof value.branch !== 'string' || !value.branch)) ||
      (value.head !== undefined && (typeof value.head !== 'string' || !/^[0-9a-f]{40,64}$/i.test(value.head))) ||
      (value.pr !== undefined && (!object(value.pr) || Object.keys(value.pr).some(key => !['number', 'url', 'headBranch'].includes(key)) ||
        (value.pr.number !== undefined && (!Number.isSafeInteger(value.pr.number) || (value.pr.number as number) < 1)) ||
        (value.pr.url !== undefined && typeof value.pr.url !== 'string') ||
        (value.pr.headBranch !== undefined && (typeof value.pr.headBranch !== 'string' || !value.pr.headBranch))))) {
    throw new Error('validateClaims requires { branch?: string, head?: full SHA, pr?: { number?: positive integer, url?: string, headBranch?: string } }.');
  }
  const claims = value as Claims;
  const local = await gitPreflight(cwd, signal);
  const errors: string[] = [];
  if (claims.branch !== undefined && claims.branch !== local.branch) errors.push('Claimed branch differs from local branch.');
  if (claims.head !== undefined && claims.head.toLowerCase() !== local.head.toLowerCase()) errors.push('Claimed commit differs from local HEAD.');
  if (claims.pr?.headBranch !== undefined && claims.pr.headBranch !== local.branch) errors.push('Claimed PR head branch differs from local branch.');
  if (claims.pr?.headBranch !== undefined && claims.branch !== undefined && claims.pr.headBranch !== claims.branch) errors.push('Claimed PR head branch differs from claimed branch.');
  if (claims.pr?.url !== undefined) {
    const match = /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/([1-9]\d*)\/?$/.exec(claims.pr.url);
    if (!match) errors.push('PR URL must be a canonical GitHub pull-request URL.');
    else if (claims.pr.number !== undefined && Number(match[1]) !== claims.pr.number) errors.push('Claimed PR number differs from PR URL.');
  }
  return { ok: errors.length === 0, errors, local: { root: local.root, branch: local.branch, head: local.head },
    unverified: ['PR existence, remote head, checks, merge status, and claims about code or tests are not verified.'] };
}
