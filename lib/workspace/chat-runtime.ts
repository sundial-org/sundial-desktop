// Single chat runtime, single allowlist. Everything goes through the
// Vercel AI Gateway. Models are stored as canonical gateway ids
// (provider/model with dotted version suffix).

import {
  ALLOWED_GATEWAY_MODELS,
  ALLOWED_GATEWAY_MODEL_SET,
  AUTO_ACCEPT_PROVIDERS,
  DEFAULT_MODEL_REF,
} from '@/lib/workspace/model-allowlist';
import type { ModelPickerOption } from '@/lib/workspace/api-shared-types';

export { ALLOWED_GATEWAY_MODELS, ALLOWED_GATEWAY_MODEL_SET, DEFAULT_MODEL_REF };
export type { ModelPickerOption };

// Which agent runtime runs a chat, picked via the tabs in the model picker.
// The Claude/OpenAI harnesses only run their own provider's models, so the
// picker filters the model list to match.
export type ChatHarness = 'vercel' | 'claude' | 'openai';
export const CHAT_HARNESSES: ChatHarness[] = ['vercel', 'claude', 'openai'];
export const CHAT_HARNESS_LABELS: Record<ChatHarness, string> = {
  vercel: 'Vercel',
  claude: 'Claude Code',
  openai: 'Codex',
};
export const CHAT_HARNESS_HINTS: Record<ChatHarness, string> = {
  vercel: 'Vercel AI SDK · any model',
  claude: 'Runs on the Claude Agent SDK',
  openai: 'Runs on the OpenAI Agents SDK',
};

export function parseChatHarness(value: unknown): ChatHarness {
  return value === 'claude' || value === 'openai' || value === 'vercel' ? value : 'vercel';
}

// The gateway provider a harness is locked to (vercel runs everything).
export function harnessProvider(harness: ChatHarness): string | null {
  return harness === 'claude' ? 'anthropic' : harness === 'openai' ? 'openai' : null;
}

export function modelsForHarness(models: ModelPickerOption[], harness: ChatHarness): ModelPickerOption[] {
  const provider = harnessProvider(harness);
  return provider ? models.filter((m) => m.provider === provider) : models;
}

// A sensible default model when switching into a harness whose provider differs
// from the current model. Prefers the curated featured model for that provider.
export function defaultModelForHarness(harness: ChatHarness): string {
  if (harness === 'claude') return 'anthropic/claude-sonnet-4.6';
  if (harness === 'openai') return 'openai/gpt-5.5';
  return DEFAULT_MODEL_REF;
}

// The model a chat should run after switching to a harness: keep the current
// model when the harness can run it, else coerce to that provider's default.
export function coerceModelForHarness(harness: ChatHarness, currentModel: string): string {
  const provider = harnessProvider(harness);
  return provider && (currentModel.split('/')[0] ?? '') !== provider
    ? defaultModelForHarness(harness)
    : currentModel;
}

export type ChatRuntimePickerOption = {
  id: string;
  label: string;
  provider: string;
  providerLabel: string;
  description: string | null;
};

export type ChatRuntimePickerSection = {
  key: string;
  label: string;
  options: ChatRuntimePickerOption[];
};

// Friendly display name derived deterministically from a gateway model id, so
// every model reads the same way (`Claude Haiku 4.5`, `GLM 5.2`) instead of the
// gateway's inconsistent names (some come back as the raw dashed id). Known
// acronyms are upper-cased; preview/exp suffixes are dropped.
const LABEL_WORD_OVERRIDES: Record<string, string> = {
  gpt: 'GPT',
  glm: 'GLM',
  ai: 'AI',
  deepseek: 'DeepSeek',
};
const DROPPED_LABEL_WORDS = new Set(['preview', 'exp']);

export function formatModelLabel(
  modelId: string | null | undefined,
  fallback = 'Model',
): string {
  const slug = typeof modelId === 'string' ? modelId.split('/').slice(-1)[0]?.trim() : '';
  const words = (slug ?? '').split('-').filter((w) => w && !DROPPED_LABEL_WORDS.has(w));
  if (words.length === 0) return fallback;
  return words
    .map((w) => LABEL_WORD_OVERRIDES[w] ?? w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

const FEATURED_MODEL_IDS: ReadonlyArray<string> = [
  'openai/gpt-5.5',
  'openai/gpt-5.4',
  'anthropic/claude-fable-5',
  'anthropic/claude-sonnet-4.6',
  'anthropic/claude-opus-4.8',
  'google/gemini-3.5-flash',
  'moonshotai/kimi-k2.6',
];
const FEATURED_MODEL_ID_SET = new Set(FEATURED_MODEL_IDS);

// Client-side guard (no catalog/release-date here): accept an explicit allowlist
// id or any model from an auto-accept provider. The picker only ever offers
// catalog-filtered models; the authoritative date-aware check is server-side in
// `normalizeSupportedModelRef`.
export function isAllowedChatModelId(value: string | null | undefined): boolean {
  if (typeof value !== 'string') return false;
  if (ALLOWED_GATEWAY_MODEL_SET.has(value)) return true;
  return AUTO_ACCEPT_PROVIDERS.has(value.split('/')[0] ?? '');
}

export function getChatModelLabel(
  modelId: string | null | undefined,
  fallback = 'GPT 5.5',
): string {
  return formatModelLabel(modelId, fallback);
}

// Last-line normalizer for stored model refs. The DB migration already put
// every stored row in canonical form, and `chats.model` writes go through
// `normalizeSupportedModelRef` (which validates against the allowlist).
// This function just hands back the trimmed value or the default.
export function normalizeChatModelRef(modelId: string | null | undefined): string {
  const trimmed = typeof modelId === 'string' ? modelId.trim() : '';
  return trimmed || DEFAULT_MODEL_REF;
}

function buildPickerDescription(model: ModelPickerOption): string | null {
  const details = [
    model.providerLabel,
    model.reasoning ? 'Reasoning' : null,
    model.supportsImages ? 'Vision' : null,
    model.contextWindow ? `${Math.round(model.contextWindow / 1000)}k ctx` : null,
    model.maxTokens ? `${model.maxTokens} max` : null,
  ].filter((value): value is string => Boolean(value));
  return details.length > 0 ? details.join(' · ') : null;
}

function buildPickerOption(model: ModelPickerOption): ChatRuntimePickerOption {
  return {
    id: model.id,
    label: formatModelLabel(model.id, model.label),
    provider: model.provider,
    providerLabel: model.providerLabel,
    description: buildPickerDescription(model),
  };
}

export function buildChatRuntimePicker(models: ModelPickerOption[]): {
  allOptions: ChatRuntimePickerOption[];
  featuredSections: ChatRuntimePickerSection[];
  moreSections: ChatRuntimePickerSection[];
} {
  const options = models.map(buildPickerOption);
  const optionById = new Map(options.map((o) => [o.id, o]));

  // Featured row honours the curated order in FEATURED_MODEL_IDS.
  const featured = FEATURED_MODEL_IDS.map((id) => optionById.get(id)).filter(
    (o): o is ChatRuntimePickerOption => Boolean(o),
  );

  // Everything else, grouped by provider, sorted by label within each group.
  const more = options.filter((o) => !FEATURED_MODEL_ID_SET.has(o.id));
  const byProvider = new Map<string, ChatRuntimePickerOption[]>();
  for (const o of more) {
    const bucket = byProvider.get(o.provider) ?? [];
    bucket.push(o);
    byProvider.set(o.provider, bucket);
  }
  const moreSections: ChatRuntimePickerSection[] = Array.from(byProvider.entries())
    .sort(([, a], [, b]) => (a[0]?.providerLabel ?? '').localeCompare(b[0]?.providerLabel ?? ''))
    .map(([provider, opts]) => ({
      key: provider,
      label: opts[0]?.providerLabel ?? provider,
      options: [...opts].sort((a, b) => a.label.localeCompare(b.label)),
    }));

  return {
    allOptions: options,
    featuredSections:
      featured.length > 0 ? [{ key: 'featured', label: 'Featured', options: featured }] : [],
    moreSections,
  };
}
