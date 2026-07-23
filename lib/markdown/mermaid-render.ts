import type { DiagramPlugin, MermaidConfig } from '@streamdown/mermaid';

/**
 * The app-wide mermaid lock. mermaid is a global singleton whose initialize()
 * mutates shared config, so chat (Streamdown) and the doc editor rendering
 * concurrently would cross-contaminate theme/security settings mid-render.
 * Every render goes through this one chain, and the config is applied INSIDE
 * the queued task — each initialize+parse+render is atomic.
 *
 * `strict` sanitizes labels/links everywhere: both surfaces render
 * collaborative / model-generated input.
 */

const BASE_CONFIG: MermaidConfig = {
  startOnLoad: false,
  securityLevel: 'strict',
  fontFamily: 'inherit',
};

let chain: Promise<unknown> = Promise.resolve();

export function renderMermaidExclusive(
  config: MermaidConfig,
  id: string,
  source: string,
  opts?: { parse?: boolean },
): Promise<string> {
  const run = async () => {
    const mermaid = (await import('mermaid')).default;
    mermaid.initialize({ ...BASE_CONFIG, ...config });
    if (opts?.parse) await mermaid.parse(source); // throws without touching the DOM
    const { svg } = await mermaid.render(id, source);
    return svg;
  };
  const result = chain.then(run, run);
  chain = result.catch(() => {});
  return result;
}

// Drop-in for @streamdown/mermaid's createMermaidPlugin, routed through the
// shared lock (its own instance renders unlocked and skips re-initialize after
// the first call, so an editor render could leave it mis-configured).
// suppressErrorRendering mirrors the original plugin: a broken fence rejects
// instead of injecting mermaid's error SVG into the page.
const CHAT_CONFIG: MermaidConfig = { theme: 'default', suppressErrorRendering: true };

export const MERMAID_CHAT_PLUGIN: DiagramPlugin = {
  name: 'mermaid',
  type: 'diagram',
  language: 'mermaid',
  getMermaid(initialConfig?: MermaidConfig) {
    let config: MermaidConfig = { ...CHAT_CONFIG, ...initialConfig };
    return {
      // Deferred: applied atomically with the next render inside the lock.
      initialize(next: MermaidConfig) {
        config = { ...CHAT_CONFIG, ...next };
      },
      render: async (id: string, source: string) => ({
        svg: await renderMermaidExclusive(config, id, source),
      }),
    };
  },
};
