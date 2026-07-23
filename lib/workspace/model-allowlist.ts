// What shows up in the workspace model picker. Two layers, evaluated by
// `isModelAllowed` against the live Vercel AI Gateway catalog
// (`https://ai-gateway.vercel.sh/v1/models`):
//
//  1. AUTO-ACCEPT — for our core providers we surface *new* flagship language
//     models automatically (released on/after AUTO_ACCEPT_BASELINE), so a fresh
//     release appears with no code change. Old models and small/specialized
//     variants (-mini, -fast, -code, image, …) stay hidden: there are too many
//     and most are stale.
//  2. ALLOWED_GATEWAY_MODELS — explicit opt-ins: older models we still want,
//     variants we like, and anything from a provider outside the auto set.
//
// IGNORED_GATEWAY_MODELS blocks a specific id and wins over both.
// Capability metadata (context window, tags, …) is fetched from the gateway.

// Providers whose new flagship releases we trust enough to surface on sight.
export const AUTO_ACCEPT_PROVIDERS: ReadonlySet<string> = new Set([
  'anthropic',
  'openai',
  'google',
  'moonshotai',
  'zai',
]);

// Unix seconds. A model from an auto-accept provider released on/after this is
// shown automatically. Never needs bumping — future releases are all newer.
export const AUTO_ACCEPT_BASELINE = Date.parse('2026-05-01T00:00:00Z') / 1000;

// Suffix tokens that mark a small/fast/specialized spin of a flagship. We don't
// auto-surface these (opt one in via ALLOWED_GATEWAY_MODELS if you want it).
const VARIANT_TOKENS: ReadonlySet<string> = new Set([
  'mini', 'nano', 'fast', 'flashx', 'highspeed', 'turbo', 'air', 'instant',
  'code', 'codex', 'image', 'chat', 'safeguard',
]);

function isVariantSlug(slug: string): boolean {
  return slug.split('-').some((token) => VARIANT_TOKENS.has(token));
}

export const ALLOWED_GATEWAY_MODELS = [
  // Anthropic
  'anthropic/claude-haiku-4.5',
  'anthropic/claude-opus-4.7',
  'anthropic/claude-opus-4.8',
  'anthropic/claude-sonnet-4.6',
  'anthropic/claude-fable-5',
  // OpenAI
  'openai/gpt-4o',
  'openai/gpt-4o-mini',
  'openai/gpt-5.4',
  'openai/gpt-5.4-mini',
  'openai/gpt-5.4-nano',
  'openai/gpt-5.5',
  'openai/o3',
  'openai/o3-mini',
  'openai/o4-mini',
  // Google
  'google/gemini-2.5-flash',
  'google/gemini-2.5-flash-lite',
  'google/gemini-3.1-flash-lite-preview',
  'google/gemini-3.1-pro-preview',
  'google/gemini-3.5-flash',
  // xAI Grok
  'xai/grok-4.3',
  // Z.AI GLM (newer flagships auto-accept; keep these older opt-ins)
  'zai/glm-4.7-flash',
  'zai/glm-5.1',
  // Alibaba Qwen
  'alibaba/qwen-3-14b',
  'alibaba/qwen3-max-preview',
  'alibaba/qwen3.6-27b',
  'alibaba/qwen3.6-plus',
  // Mistral
  'mistral/devstral-2',
  'mistral/ministral-14b',
  'mistral/mistral-large-3',
  'mistral/mistral-medium-3.5',
  'mistral/mistral-small',
  // DeepSeek
  'deepseek/deepseek-r1',
  'deepseek/deepseek-v3.1',
  'deepseek/deepseek-v3.2',
  'deepseek/deepseek-v4-flash',
  'deepseek/deepseek-v4-pro',
  // Meta Llama
  'meta/llama-3.3-70b',
  'meta/llama-4-scout',
  // Moonshot Kimi
  'moonshotai/kimi-k2.6',
  // Inception Mercury
  'inception/mercury-2',
] as const;

// Ids we never surface, even if auto-accept would. Wins over everything.
export const IGNORED_GATEWAY_MODELS = [] as const;

export type AllowedGatewayModelId = (typeof ALLOWED_GATEWAY_MODELS)[number];

export const ALLOWED_GATEWAY_MODEL_SET: ReadonlySet<string> = new Set(ALLOWED_GATEWAY_MODELS);
const IGNORED_GATEWAY_MODEL_SET: ReadonlySet<string> = new Set(IGNORED_GATEWAY_MODELS);

export const DEFAULT_MODEL_REF: AllowedGatewayModelId = 'anthropic/claude-fable-5';

export type GatewayModelMeta = {
  id: string;
  type?: string | null;
  released?: number | null;
};

// The single policy deciding whether a gateway model shows in the picker.
export function isModelAllowed(model: GatewayModelMeta): boolean {
  if (IGNORED_GATEWAY_MODEL_SET.has(model.id)) return false;
  if (ALLOWED_GATEWAY_MODEL_SET.has(model.id)) return true;
  const [provider, slug = ''] = model.id.split('/');
  return (
    AUTO_ACCEPT_PROVIDERS.has(provider ?? '') &&
    model.type === 'language' &&
    (model.released ?? 0) >= AUTO_ACCEPT_BASELINE &&
    !isVariantSlug(slug)
  );
}
