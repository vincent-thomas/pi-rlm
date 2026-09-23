import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Scratchpad, SCRATCHPAD_INITIAL_TEXT } from './scratchpad.ts';

export const SCRATCHPAD_ENTRY_TYPE = 'pi-rlm:scratchpad';

/** Restore the latest session-wide snapshot, including entries outside the active branch. */
export function restoreSessionScratchpad(
  pi: Pick<ExtensionAPI, 'appendEntry'>,
  manager: ExtensionContext['sessionManager'],
  isActive: () => boolean,
): Scratchpad {
  const sessionId = manager.getSessionId();
  const entries = manager.getEntries();
  let text = SCRATCHPAD_INITIAL_TEXT;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (entry.type !== 'custom' || entry.customType !== SCRATCHPAD_ENTRY_TYPE) continue;
    const data = entry.data as { version?: unknown; sessionId?: unknown; text?: unknown } | undefined;
    // Forks may copy parent entries, but each Pi session owns its own scratchpad.
    if (!data || data.sessionId !== sessionId) continue;
    if (data.version !== 1 || typeof data.text !== 'string') throw new Error('Invalid saved RLM scratchpad snapshot.');
    text = data.text;
    break;
  }
  return new Scratchpad(text, next => {
    if (!isActive() || manager.getSessionId() !== sessionId) {
      throw new Error('Scratchpad session is no longer active.');
    }
    // Custom entries are persisted by Pi and excluded from model context.
    pi.appendEntry(SCRATCHPAD_ENTRY_TYPE, { version: 1, sessionId, text: next });
  });
}
