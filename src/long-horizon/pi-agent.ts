process.env.PI_RLM_ITERATION_WORKER = '1';

import { createAgentSession, SessionManager } from '@earendil-works/pi-coding-agent';

let prompt = '';
for await (const chunk of process.stdin) prompt += chunk.toString();
if (!prompt.trim()) throw new Error('The autonomous agent requires a prompt on stdin.');
const { session } = await createAgentSession({ cwd: process.cwd(), sessionManager: SessionManager.inMemory(process.cwd()) });
try {
  await session.prompt(prompt, { source: 'extension' });
} finally { session.dispose(); }
