import { highlightCode, type ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Text } from '@earendil-works/pi-tui';
import { js as beautify } from 'js-beautify';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Runtime } from './src/runtime.ts';
import { autonomyInstructions, createQuery, instructions, orchestrationInstructions, parameters, type ModelTier } from './src/rlm.ts';
import { longHorizonInstructions, registerLongHorizon } from './src/long-horizon/extension.ts';

export default function rlm(pi: ExtensionAPI) {
  registerLongHorizon(pi);
  let runtime: Runtime | undefined;
  let contextLength = 0;
  const reset = () => { runtime?.dispose(); runtime = undefined; contextLength = 0; };
  pi.registerTool({
    name: 'exec', label: 'JavaScript',
    description: 'Execute JavaScript with persistent state, bash(command), readFile(path, len, offset), and recursive llm_query(prompt, context) calls. Use print() to show results.',
    parameters,
    renderCall({ code }) {
      const formatted = beautify(code ?? '', {
        indent_size: 2,
        wrap_line_length: 100,
        max_preserve_newlines: 2,
      });
      return new Text(highlightCode(formatted, 'javascript').join('\n'), 0, 0);
    },
    renderResult(result, { expanded }, theme, context) {
      if (!expanded) return new Text('', 0, 0);
      const output = result.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('\n');
      return new Text(theme.fg(context.isError ? 'error' : 'toolOutput', output), 0, 0);
    },
    async execute(_id, { code }, signal, _update, ctx) {
      runtime ??= new Runtime(ctx.cwd);
      const model = ctx.model;
      const query = createQuery(ctx.cwd, async (conversation, childSignal, tier: ModelTier) => {
        if (!model) throw new Error('Select an AGI/top-level model before calling llm_query.');
        const available = ctx.scopedModels.length
          ? ctx.scopedModels.map(item => item.model)
          : ctx.modelRegistry.getAvailable();
        const findConfigured = (reference: string) => {
          const exact = available.filter(candidate =>
            `${candidate.provider}/${candidate.id}` === reference || candidate.id === reference);
          if (exact.length !== 1) {
            const detail = exact.length ? 'is ambiguous' : 'is unavailable';
            throw new Error(`Configured RLM model ${reference} ${detail}. Use an exact provider/model id and ensure it is in scope.`);
          }
          return exact[0]!;
        };
        let childModel = model; // The selected top-level model is always the AGI tier.
        const references = tier === 'routine'
          ? [process.env.PI_RLM_ROUTINE_MODEL, process.env.PI_RLM_SMART_MODEL]
          : tier === 'smart' ? [process.env.PI_RLM_SMART_MODEL] : [];
        const reference = references.find(value => value?.trim())?.trim();
        if (reference) childModel = findConfigured(reference);
        return ctx.modelRegistry.complete(childModel, conversation, { signal: childSignal, maxTokens: 4096 });
      });
      const result = await runtime.exec(code, query, signal);
      if (result.isError) throw new Error(result.text);
      return { content: [{ type: 'text', text: result.text }], details: {} };
    },
  });
  pi.on('session_start', () => { reset(); pi.setActiveTools(process.env.PI_RLM_ITERATION_WORKER === '1' ? ['exec'] : ['exec', 'start_long_horizon']); });
  pi.on('session_tree', reset);
  pi.on('session_shutdown', reset);
  pi.on('before_agent_start', event => ({
    systemPrompt: event.systemPrompt + '\n\nYou are the top-level AGI tier.\n' + orchestrationInstructions + '\n' + autonomyInstructions + '\n' + instructions + '\n' + longHorizonInstructions + `\nLoaded context: ${contextLength} characters.`,
  }));
  pi.registerCommand('rlm-load', {
    description: 'Load a UTF-8 file into the JavaScript context without adding it to the model prompt',
    async handler(args, ctx) {
      if (!args.trim()) { ctx.ui.notify('Usage: /rlm-load path/to/file', 'info'); return; }
      try {
        const path = resolve(ctx.cwd, args.trim());
        const text = await readFile(path, 'utf8');
        reset(); runtime = new Runtime(ctx.cwd, text); contextLength = text.length;
        ctx.ui.notify(`Loaded ${text.length} characters into context from ${path}.`, 'info');
      } catch (error) { ctx.ui.notify(String(error), 'error'); }
    },
  });
  pi.registerCommand('rlm-reset', {
    description: 'Clear the RLM workspace and loaded context',
    handler: async (_args, ctx) => { reset(); ctx.ui.notify('RLM workspace cleared.', 'info'); },
  });
}
