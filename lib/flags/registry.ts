/**
 * The flag registry: the single source of truth for boolean feature flags.
 *
 * Adding a flag is ONE entry here — no migration (values live in the
 * `user_preferences.flags` jsonb), no new API field (`/api/user/preferences`
 * reads and writes the `flags` object against this registry), no bespoke
 * client module (`lib/flags/client.ts` is the one store), and no hand-built
 * settings row (Settings → Advanced renders every `surface: 'advanced'`
 * entry). Never define a flag anywhere else.
 *
 * Flags are expected to DIE. `reviewBy` is enforced by
 * `tests/lib/flag-registry.test.ts`: once the date passes, the suite fails
 * until the owner either deletes the flag (graduated or abandoned) or
 * re-justifies it by bumping the date. That failure is deliberate — a
 * one-line date bump is the cost of consciously keeping a flag alive.
 */

export type FlagDefinition = {
  /** snake_case; the jsonb key, the API field, and the client-store key. */
  key: string;
  /** 'preference' = the user chose it, account-backed, lives as long as the
   *  feature. 'release' = rollout/kill switch, short-lived by design; when
   *  one needs percentage or cohort targeting, use PostHog feature flags
   *  instead of growing this registry. */
  category: 'preference' | 'release';
  /** Value when the user (or account) has never set it. A true default is a
   *  deliberate product launch decision and must be explicitly allowlisted
   *  in tests/lib/flag-registry.test.ts. */
  default: boolean;
  /** Settings row title (when surfaced). */
  label: string;
  /** Settings row subtitle. */
  description: string;
  /** GitHub handle accountable for this flag's lifecycle. */
  owner: string;
  /** ISO date (YYYY-MM-DD) by which the flag must be deleted or re-justified. */
  reviewBy: string;
  /** 'advanced' renders a toggle in Settings → Advanced; 'hidden' is
   *  programmatic-only (URL params, internal). */
  surface: 'advanced' | 'hidden';
  /** localStorage key override, for flags that predate the registry and
   *  already persisted under another name. New flags omit this. */
  legacyStorageKey?: string;
};

export const FLAGS: readonly FlagDefinition[] = [
  {
    key: 'sundial_support_enabled',
    category: 'preference',
    default: true,
    label: 'Sundial Support',
    description: 'Chat with support from the workspace sidebar and receive a follow-up by email.',
    owner: 'matthewdi',
    reviewBy: '2027-02-26',
    surface: 'advanced',
  },
  {
    key: 'assistants_enabled',
    category: 'preference',
    // Launched default-on 2026-08-28; the switch remains the opt-out.
    default: true,
    label: 'Assistants',
    description:
      'Browse assistants from the workspace sidebar: start a new workspace from one, or connect one into the current workspace.',
    owner: 'm13v',
    reviewBy: '2026-11-27',
    surface: 'advanced',
  },
  {
    key: 'autocomplete_enabled',
    category: 'preference',
    default: false,
    label: 'Autocomplete',
    description: 'Ghost-text completions while editing markdown and LaTeX. Uses credits.',
    owner: 'narphorium',
    reviewBy: '2027-02-26',
    surface: 'advanced',
    legacyStorageKey: 'sundial:autocomplete',
  },
  {
    key: 'pdf_comments_enabled',
    category: 'preference',
    // Launched default-on 2026-08-28 after founder verification on dev; the
    // switch remains the opt-out.
    default: true,
    label: 'PDF comments',
    description:
      'Select text in the compiled PDF preview to comment on it. Comments anchor to the LaTeX source and show in both views.',
    owner: 'm13v',
    reviewBy: '2027-02-26',
    surface: 'advanced',
  },
] as const;

export function getFlagDefinition(key: string): FlagDefinition | undefined {
  return FLAGS.find((flag) => flag.key === key);
}

export function flagDefaults(): Record<string, boolean> {
  return Object.fromEntries(FLAGS.map((flag) => [flag.key, flag.default]));
}

/** The entries Settings → Advanced renders, in registry order. */
export function advancedFlags(): FlagDefinition[] {
  return FLAGS.filter((flag) => flag.surface === 'advanced');
}

/** Resolve a stored (possibly partial / legacy-shaped) flags object into a
 *  complete one: every registry key present, unknown keys dropped, non-boolean
 *  junk replaced by the default. The one shape the API serves. */
export function resolveFlags(stored: unknown): Record<string, boolean> {
  const source = (stored ?? {}) as Record<string, unknown>;
  return Object.fromEntries(
    FLAGS.map((flag) => [
      flag.key,
      typeof source[flag.key] === 'boolean' ? (source[flag.key] as boolean) : flag.default,
    ]),
  );
}
