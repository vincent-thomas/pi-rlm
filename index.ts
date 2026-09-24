import { buildSessionContext, convertToLlm, highlightCode, type ExtensionAPI, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { js as beautify } from 'js-beautify';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Runtime } from './src/runtime.ts';
import { Scratchpad } from './src/scratchpad.ts';
import { restoreSessionScratchpad } from './src/session-scratchpad.ts';
import { ActivityPublisher, ActivityUpdateSink, type ActivitySnapshot } from './src/activity.ts';
import { formatActivity } from './src/render-activity.ts';
import { autonomyInstructions, createQuery, instructions, MODEL_TIERS, orchestrationInstructions, parameters, type ModelTier } from './src/rlm.ts';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';

export interface RlmToolDetails { activity?: ActivitySnapshot }
export { formatActivity };
export type { QueryOptions, VerificationOptions } from './src/rlm.ts';

function resolveModelTier(ctx: ExtensionContext, tier: ModelTier) {
  const available = ctx.scopedModels.length
    ? ctx.scopedModels.map(item => item.model)
    : ctx.modelRegistry.getAvailable();
  const findConfigured = (reference: string) => {
    const exact = (value: string) => {
      const trimmed = value.trim();
      const folded = trimmed.toLowerCase();
      const canonical = available.filter(candidate =>
        (candidate.provider + '/' + candidate.id).toLowerCase() === folded);
      if (canonical.length) return canonical;
      const slash = trimmed.indexOf('/');
      if (slash >= 0) {
        const provider = trimmed.slice(0, slash).trim().toLowerCase();
        const id = trimmed.slice(slash + 1).trim().toLowerCase();
        const qualified = provider && id ? available.filter(candidate =>
          candidate.provider.toLowerCase() === provider && candidate.id.toLowerCase() === id) : [];
        if (qualified.length) return qualified;
      }
      return available.filter(candidate => candidate.id.toLowerCase() === folded);
    };
    // Match the whole reference first because catalog IDs may themselves contain colons.
    let matches = exact(reference);
    let thinkingLevel: ThinkingLevel | undefined;
    if (matches.length === 0) {
      const colon = reference.lastIndexOf(':');
      const suffix = colon < 0 ? '' : reference.slice(colon + 1).toLocaleLowerCase('en-US');
      if (['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(suffix)) {
        matches = exact(reference.slice(0, colon));
        if (matches.length === 1) thinkingLevel = suffix as ThinkingLevel;
      }
    }
    if (matches.length !== 1) {
      const detail = matches.length ? 'is ambiguous' : 'is unavailable';
      throw new Error('Configured RLM model ' + reference + ' ' + detail + '. Use an exact provider/model id and ensure it is in scope.');
    }
    return { model: matches[0]!, thinkingLevel };
  };
  const tiers: ModelTier[] = tier === 'routine' ? ['routine', 'smart', 'agi']
    : tier === 'smart' ? ['smart', 'agi'] : ['agi'];
  const candidates = tiers.map(candidate => {
    const defaults = MODEL_TIERS[candidate];
    const override = candidate === 'routine' ? process.env.PI_RLM_ROUTINE_MODEL
      : candidate === 'smart' ? process.env.PI_RLM_SMART_MODEL : undefined;
    return { reference: (override ?? defaults.model).trim(), reasoning: override === undefined ? defaults.reasoning : undefined };
  });
  const selected = candidates.find(candidate => candidate.reference)!;
  const configured = findConfigured(selected.reference);
  const reasoning = configured.thinkingLevel ?? selected.reasoning;
  return { model: configured.model, reasoning };
}

export default function rlm(pi: ExtensionAPI) {
  let runtime: Runtime | undefined;
  let scratchpad = new Scratchpad();
  let contextLength = 0;
  let loadedContext = '';
  const activityByToolCall = new Map<string, ActivitySnapshot>();
  const reset = () => { runtime?.dispose(); runtime = undefined; contextLength = 0; loadedContext = ''; activityByToolCall.clear(); };
  pi.registerTool({
    name: 'exec', label: 'JavaScript',
    description: 'Execute JavaScript with persistent state, shared scratchpad, bash(command), readFile(path, len, offset), and recursive llm_query(prompt, options) calls with full or isolated context inheritance and optional verification. Use print() to show results.',
    parameters,
    renderCall({ code }, _theme, context) {
      if (!context.expanded) {
        const lines = code ? code.split(/\r?\n/).length : 0;
        return new Text('JavaScript · ' + lines + ' line' + (lines === 1 ? '' : 's') + ' (Ctrl+O to view code)', 0, 0);
      }
      const formatted = beautify(code ?? '', {
        indent_size: 2,
        wrap_line_length: 100,
        max_preserve_newlines: 2,
      });
      return new Text(highlightCode(formatted, 'javascript').join('\n'), 0, 0);
    },
    renderResult(result, { expanded }, theme, context) {
      const output = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
      const activity = (result.details as RlmToolDetails | undefined)?.activity;
      if (!activity) {
        if (!expanded) return new Text(context.isError ? theme.fg('error', 'JavaScript failed') : '', 0, 0);
        return new Text(theme.fg(context.isError ? 'error' : 'toolOutput', output), 0, 0);
      }
      let text = theme.fg(context.isError ? 'error' : 'muted', formatActivity(activity, expanded));
      if (expanded && output) text += '\n\n' + theme.fg(context.isError ? 'error' : 'toolOutput', output);
      return new Text(text, 0, 0);
    },
    async execute(toolCallId, { code }, signal, onUpdate, ctx) {
      runtime ??= new Runtime(ctx.cwd, '', scratchpad);
      const updates = new ActivityUpdateSink(snapshot => onUpdate?.({ content: [], details: { activity: snapshot } }));
      const activity = new ActivityPublisher(snapshot => { activityByToolCall.set(toolCallId, snapshot); updates.push(snapshot); });
      activity.initial();
      const query = createQuery(ctx.cwd, async (conversation, childSignal, tier: ModelTier) => {
        const { model, reasoning } = resolveModelTier(ctx, tier);
        return ctx.modelRegistry.complete(model, conversation, {
          signal: childSignal, maxTokens: 4096,
          ...(reasoning === undefined ? {} : { reasoning }),
        });
      }, undefined, undefined, undefined, { reporter: activity }, scratchpad,
      { systemPrompt: '', messages: ctx.sessionManager
        ? convertToLlm(buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages)
        : [] }, loadedContext);
      try {
        const result = await runtime.exec(code, query, signal);
        if (result.isError) throw new Error(result.text);
        return { content: [{ type: 'text', text: result.text }], details: { activity: activity.snapshot() } };
      } finally {
        const finalActivity = activity.snapshot();
        activityByToolCall.set(toolCallId, finalActivity);
        updates.finish(finalActivity);
      }
    },
  });
  pi.on('tool_result', event => {
    if (event.toolName !== 'exec') return;
    const activity = activityByToolCall.get(event.toolCallId);
    if (!activity) return;
    activityByToolCall.delete(event.toolCallId);
    const details = event.details && typeof event.details === 'object' ? event.details as Record<string, unknown> : {};
    return { content: event.content, isError: event.isError, details: { ...details, activity } };
  });
  pi.on('session_start', async (_event, ctx) => {
    reset();
    scratchpad = new Scratchpad(); // Invalidate callbacks from the previous session, even if restore fails.
    const restored = restoreSessionScratchpad(pi, ctx.sessionManager, () => scratchpad === restored);
    scratchpad = restored;
    pi.setActiveTools(['exec']);
    const { model, reasoning } = resolveModelTier(ctx, 'smart');
    if (!await pi.setModel(model)) throw new Error('Unable to select the smart-tier top-level model: ' + model.provider + '/' + model.id);
    if (reasoning !== undefined) pi.setThinkingLevel(reasoning);
  });
  pi.on('session_tree', reset);
  pi.on('session_shutdown', () => { reset(); scratchpad = new Scratchpad(); });
  pi.on('before_agent_start', event => ({
    systemPrompt: event.systemPrompt + '\n\nYou are the top-level orchestrator, defaulting to the smart tier.\n' + orchestrationInstructions + '\n' + autonomyInstructions + '\n' + instructions + `\nLoaded context: ${contextLength} characters.`,
  }));
  pi.registerCommand('rlm-load', {
    description: 'Load a UTF-8 file into the JavaScript context without adding it to the model prompt',
    async handler(args, ctx) {
      if (!args.trim()) { ctx.ui.notify('Usage: /rlm-load path/to/file', 'info'); return; }
      try {
        const path = resolve(ctx.cwd, args.trim());
        const text = await readFile(path, 'utf8');
        reset(); loadedContext = text; runtime = new Runtime(ctx.cwd, text, scratchpad); contextLength = text.length;
        ctx.ui.notify(`Loaded ${text.length} characters into context from ${path}.`, 'info');
      } catch (error) { ctx.ui.notify(String(error), 'error'); }
    },
  });
  pi.registerCommand('rlm-reset', {
    description: 'Clear the RLM workspace and loaded context',
    handler: async (_args, ctx) => { reset(); ctx.ui.notify('RLM workspace cleared.', 'info'); },
  });
}
