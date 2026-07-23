// BYOK provider catalog + key normalization, shared by the server lib
// (lib/user/provider-keys.ts), the API route, and the settings-panel client
// component. Keep the slugs in sync with BYOK_PROVIDER_SLUGS in
// agent-ts/src/models/byok.ts — they are the DB `provider` values and the
// Vercel AI Gateway byok credential keys.

export type ByokProvider = {
  id: 'anthropic' | 'openai' | 'google' | 'xai';
  label: string;
  placeholder: string;
  keysUrl: string;
};

export type ByokProviderId = ByokProvider['id'];

export const BYOK_PROVIDERS: ByokProvider[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    placeholder: 'sk-ant-…',
    keysUrl: 'https://console.anthropic.com/settings/keys',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    placeholder: 'sk-…',
    keysUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'google',
    label: 'Google AI Studio',
    placeholder: 'AIza…',
    keysUrl: 'https://aistudio.google.com/apikey',
  },
  {
    id: 'xai',
    label: 'xAI',
    placeholder: 'xai-…',
    keysUrl: 'https://console.x.ai',
  },
];

const MAX_KEY_LENGTH = 512;

export function isByokProviderId(value: unknown): value is ByokProviderId {
  return typeof value === 'string' && BYOK_PROVIDERS.some((p) => p.id === value);
}

// Legacy `openrouter/<sub>/<model>` catalog ids: the sub is the real creator
// namespace, renamed to the gateway's. Mirror of OPENROUTER_SUBPROVIDER_RENAMES
// in agent-ts/src/models/registry.ts (normalizeModelId) — keep in sync so the
// gate resolves the same provider the agent will actually route to.
const OPENROUTER_SUBPROVIDER_RENAMES: Record<string, string> = {
  'meta-llama': 'meta',
  mistralai: 'mistral',
  qwen: 'alibaba',
  'x-ai': 'xai',
  'z-ai': 'zai',
};

// The BYOK provider a gateway model id resolves to, or null when the model is
// served by a third party a user key can't cover (OSS creators) — used to gate
// a run by whether the requested model can actually use a stored key. Applies
// the same legacy normalization the agent does before routing (so an older
// `openrouter/x-ai/grok-…` id resolves to `xai`, not null). A null/blank id
// means the workspace default model, which is first-party Anthropic (keep in
// sync with DEFAULT_MODEL in agent-ts/src/models/registry.ts).
export function byokProviderForModelId(modelId: string | null | undefined): ByokProviderId | null {
  const id = (modelId ?? '').trim();
  if (!id) return 'anthropic';
  let prefix: string;
  if (id.includes('/')) {
    const parts = id.split('/');
    prefix =
      parts[0] === 'openrouter' && parts.length >= 3
        ? OPENROUTER_SUBPROVIDER_RENAMES[parts[1]!] ?? parts[1]!
        : parts[0]!;
  } else {
    prefix = 'anthropic';
  }
  return isByokProviderId(prefix) ? prefix : null;
}

export function normalizeProviderApiKey(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const key = input.trim();
  // Real provider keys are single-line ASCII tokens; anything else was a paste
  // accident and would silently break every turn if stored.
  if (!key || key.length > MAX_KEY_LENGTH || !/^[\x21-\x7e]+$/.test(key)) return null;
  return key;
}
