/**
 * Maps a local-agent identifier (`ai:<name>`) to brand-recognizable styling
 * for the presence chip + provenance gutter. Always picks the product name
 * (Claude / Gemini / Codex / ChatGPT / Cursor), NEVER the parent company
 * (Anthropic / Google / OpenAI) — chips read at a glance and we don't surface
 * org names. The no-company-name rule is enforced by agent-brand.test.ts.
 */

export type AgentBrand = {
  /** Display label inside the bubble (1–2 chars). Used as fallback when logoPath is null. */
  label: string;
  /** Brand color — chip background when no logoPath, pulsing status dot otherwise. */
  color: string;
  /** Pretty display name for tooltips. */
  displayName: string;
  /** Public path to the brand SVG. Logos come from Simple Icons
   *  (https://simpleicons.org), which only hosts brand marks the rights
   *  holder permits. When null, we fall back to a colored chip with `label`. */
  logoPath: string | null;
};

const BRANDS: Array<{ pattern: RegExp; brand: AgentBrand }> = [
  // Claude family (Anthropic).
  { pattern: /^ai:(claude|claude-code|claude-opus|claude-sonnet|claude-haiku|sonnet|opus|haiku)\b/i,
    brand: { label: 'C', color: '#D97757', displayName: 'Claude', logoPath: '/agent-logos/claude.svg' } },
  // Gemini family (Google).
  { pattern: /^ai:(gemini|bard|gemma)\b/i,
    brand: { label: 'G', color: '#8E75B2', displayName: 'Gemini', logoPath: '/agent-logos/gemini.svg' } },
  // Codex (OpenAI's coding agent) — the product line, like Claude/Gemini/Cursor,
  // not the parent org. This is the agent that connects via the join prompt.
  { pattern: /^ai:(codex|codex-cli)\b/i,
    brand: { label: 'Cx', color: '#10A37F', displayName: 'Codex', logoPath: null } },
  // ChatGPT / GPT / o-series — show the product, never the company. No logo —
  // Simple Icons doesn't host it.
  { pattern: /^ai:(chatgpt|gpt|openai|o1|o3|o4)\b/i,
    brand: { label: 'GP', color: '#10A37F', displayName: 'ChatGPT', logoPath: null } },
  // Cursor (the IDE agent).
  { pattern: /^ai:(cursor)\b/i,
    brand: { label: '▸', color: '#111111', displayName: 'Cursor', logoPath: '/agent-logos/cursor.svg' } },
  // Windsurf / Codeium.
  { pattern: /^ai:(windsurf|codeium)\b/i,
    brand: { label: 'W', color: '#00C2A8', displayName: 'Windsurf', logoPath: null } },
  // Aider.
  { pattern: /^ai:(aider)\b/i,
    brand: { label: 'A', color: '#FF6F61', displayName: 'Aider', logoPath: null } },
  // Generic MCP client we couldn't identify — better than title-casing to "Mcp".
  { pattern: /^ai:mcp\b/i,
    brand: { label: 'M', color: '#4f46e5', displayName: 'MCP', logoPath: null } },
];

const FALLBACK_BRAND: AgentBrand = { label: '⚡', color: '#4f46e5', displayName: 'Local agent', logoPath: null };

export function brandForAgentId(agentId: string | null | undefined): AgentBrand {
  if (!agentId) return FALLBACK_BRAND;
  for (const { pattern, brand } of BRANDS) {
    if (pattern.test(agentId)) return brand;
  }
  return FALLBACK_BRAND;
}
