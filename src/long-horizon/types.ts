export type JobStatus = 'running' | 'succeeded' | 'exhausted' | 'failed';

export interface CommandSpec {
  command: string;
  args?: string[];
  timeoutMs?: number;
}

export interface BenchmarkJobConfig {
  version: 1;
  objective: string;
  workspace: string;
  deadlineAt: string;
  maxIterations: number;
  targetImprovement: number;
  protectedPaths: string[];
  agent: CommandSpec;
  verifier: CommandSpec;
}

export interface Verification {
  valid: boolean;
  score: number;
  summary?: string;
}

export interface IterationRecord {
  number: number;
  startedAt: string;
  finishedAt: string;
  outcome: 'accepted' | 'rejected' | 'error';
  score?: number;
  reason: string;
  agentStdoutPath?: string;
  agentStderrPath?: string;
  verifierStdoutPath?: string;
  verifierStderrPath?: string;
}

export interface BenchmarkJobState {
  version: 1;
  objective: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  deadlineAt: string;
  baselineCommit: string;
  baselineScore: number;
  bestCommit: string;
  bestScore: number;
  targetScore: number;
  nextIteration: number;
  activeIteration?: { number: number; phase: 'agent_running' | 'verifying'; startedAt: string };
  iterations: IterationRecord[];
  stopReason?: string;
}
