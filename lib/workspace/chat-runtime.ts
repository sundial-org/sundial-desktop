// Single chat runtime, single allowlist. Everything goes through the
// Vercel AI Gateway. Models are stored as canonical gateway ids
// (provider/model with dotted version suffix).

import {
  ALLOWED_GATEWAY_MODELS,
  ALLOWED_GATEWAY_MODEL_SET,
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
  vercel: 'Sundial Agent',
  claude: 'Claude Code',
  openai: 'Codex',
};
export const CHAT_HARNESS_HINTS: Record<ChatHarness, string> = {
  vercel: 'Sundial’s cloud agent · any model',
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

// Family anchors for the featured row, in display order. Each id names a model
// *line*, not a fixed release: `isModelAllowed` auto-accepts a new flagship the
// day it lands in the gateway catalog, but this list is hand-written, so before
// the promotion below a fresh release surfaced only under "More models" while
// the row kept the superseded id (Opus 5 vs Opus 4.8, July 2026).
const FEATURED_MODEL_IDS: ReadonlyArray<string> = [
  'openai/gpt-5.5',
  'openai/gpt-5.4',
  'anthropic/claude-fable-5',
  'anthropic/claude-sonnet-4.6',
  'anthropic/claude-opus-5',
  'google/gemini-3.5-flash',
  'moonshotai/kimi-k2.6',
];

// Provider groups the picker leads with; everyone else follows alphabetically.
const CORE_PROVIDER_ORDER = ['anthropic', 'openai', 'google'];

// The family a model belongs to: its id minus the first version token. The
// optional letter covers generation prefixes (`kimi-k2.6` → `moonshotai/kimi`,
// so `kimi-k3` lands in the same family). `anthropic/claude-opus-4.8` →
// `anthropic/claude-opus`, `openai/gpt-5.5` → `openai/gpt`,
// `google/gemini-3.5-flash` → `google/gemini-flash`.
function modelFamily(id: string): string {
  return id.replace(/-[a-z]?\d[\d.]*/, '');
}

// Client-side shape guard only: every gateway language model is selectable,
// so any provider/model ref passes. The picker only ever offers
// catalog-filtered models; the authoritative check is server-side in
// `normalizeSupportedModelRef`.
export function isAllowedChatModelId(value: string | null | undefined): boolean {
  return typeof value === 'string' && (ALLOWED_GATEWAY_MODEL_SET.has(value) || value.includes('/'));
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

// `featuredIds` overrides the curated row for pickers whose short list is not
// the chat flagships — the autocomplete picker features the latency roster
// (`AUTOCOMPLETE_FEATURED_MODEL_IDS`) instead. Everything else, including the
// family promotion below, behaves identically.
export function buildChatRuntimePicker(
  models: ModelPickerOption[],
  featuredIds: ReadonlyArray<string> = FEATURED_MODEL_IDS,
): {
  allOptions: ChatRuntimePickerOption[];
  featuredSections: ChatRuntimePickerSection[];
  moreSections: ChatRuntimePickerSection[];
} {
  const options = models.map(buildPickerOption);
  const optionById = new Map(options.map((o) => [o.id, o]));

  // Dated catalog releases per family, newest first, so each featured slot can
  // follow its line instead of pinning one release forever. Only dated entries
  // rank: a missing `released` must never read as epoch 0 and let an *older*
  // sibling outrank the anchor (`isModelAllowed` never checks the date, so the
  // catalog is free to omit it).
  const releasedById = new Map(models.map((m) => [m.id, m.released]));
  const datedByFamily = new Map<string, { id: string; released: number }[]>();
  for (const { id, released } of models) {
    if (typeof released !== 'number') continue;
    const family = modelFamily(id);
    const bucket = datedByFamily.get(family) ?? [];
    bucket.push({ id, released });
    datedByFamily.set(family, bucket);
  }
  for (const bucket of datedByFamily.values()) bucket.sort((a, b) => b.released - a.released);

  // Featured row honours the curated order in FEATURED_MODEL_IDS. The n-th
  // anchor of a family claims the n-th newest release of that family, so
  // sibling anchors (GPT 5.5 + 5.4) keep showing distinct models when a newer
  // sibling lands. An anchor only yields its slot to a *strictly newer* release
  // — or outright, once the anchor itself has left the catalog. Undated
  // catalogs (the desktop's static local list) keep every anchor.
  const rankPerFamily = new Map<string, number>();
  const chosenIds = new Set<string>();
  const featured: ChatRuntimePickerOption[] = [];
  for (const anchor of featuredIds) {
    const family = modelFamily(anchor);
    const rank = rankPerFamily.get(family) ?? 0;
    rankPerFamily.set(family, rank + 1);
    const candidate = datedByFamily.get(family)?.[rank];
    const candidateOption = candidate && optionById.get(candidate.id);
    const anchorOption = optionById.get(anchor);
    const anchorReleased = releasedById.get(anchor);
    const promote =
      candidate &&
      candidateOption &&
      (!anchorOption ||
        (typeof anchorReleased === 'number' && candidate.released > anchorReleased));
    // Whichever of the two a slot lands on, if it is already featured the slot
    // falls through to the other rather than collapsing — so a curated anchor
    // present in the catalog never silently drops out of the row.
    const chosen = [promote ? candidateOption : anchorOption, candidateOption, anchorOption].find(
      (option) => option && !chosenIds.has(option.id),
    );
    if (!chosen) continue;
    chosenIds.add(chosen.id);
    featured.push(chosen);
  }

  // Everything else, grouped by provider: core providers first, then the rest
  // alphabetically; within a provider, newest release first (undated entries
  // sink to the bottom, version-aware label order as the tiebreak) so a
  // provider's current flagship always tops its group.
  const more = options.filter((o) => !chosenIds.has(o.id));
  const byProvider = new Map<string, ChatRuntimePickerOption[]>();
  for (const o of more) {
    const bucket = byProvider.get(o.provider) ?? [];
    bucket.push(o);
    byProvider.set(o.provider, bucket);
  }
  const providerRank = (provider: string) => {
    const rank = CORE_PROVIDER_ORDER.indexOf(provider);
    return rank === -1 ? CORE_PROVIDER_ORDER.length : rank;
  };
  const moreSections: ChatRuntimePickerSection[] = Array.from(byProvider.entries())
    .sort(
      ([providerA, a], [providerB, b]) =>
        providerRank(providerA) - providerRank(providerB) ||
        (a[0]?.providerLabel ?? '').localeCompare(b[0]?.providerLabel ?? ''),
    )
    .map(([provider, opts]) => ({
      key: provider,
      label: opts[0]?.providerLabel ?? provider,
      options: [...opts].sort(
        (a, b) =>
          (releasedById.get(b.id) ?? -Infinity) - (releasedById.get(a.id) ?? -Infinity) ||
          a.label.localeCompare(b.label, undefined, { numeric: true }),
      ),
    }));

  return {
    // Featured first, then the grouped order — so flat renderings of the full
    // list read coherently too.
    allOptions: [...featured, ...moreSections.flatMap((s) => s.options)],
    featuredSections:
      featured.length > 0 ? [{ key: 'featured', label: 'Featured', options: featured }] : [],
    moreSections,
  };
}
