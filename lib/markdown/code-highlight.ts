import { createCodePlugin, type CodeHighlighterPlugin, type ThemeInput } from '@streamdown/code';

// `vitesse-light` is Anthony Fu's signature theme — desaturated, low-contrast
// pastels that read as "design-y" rather than the saturated red/blue/purple of
// github-light. Single source for every code surface: the chat Streamdown
// renderer and the doc editor's CodeBlockShiki decorations share this one
// plugin, so a fence looks identical in a Sunny reply and in the doc — and the
// app loads exactly one shiki highlighter.
export const SHIKI_THEMES: [ThemeInput, ThemeInput] = ['vitesse-light', 'vitesse-dark'];

export const CODE_PLUGIN: CodeHighlighterPlugin = createCodePlugin({
  themes: SHIKI_THEMES,
});
