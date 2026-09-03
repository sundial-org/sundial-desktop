import type { DraftDocCommentSelection } from '@/lib/workspace/doc-comments';

/** Manifest definition installed by an assistant. */
export type AssistantSelectionAction = {
  id: string;
  /** Compact selected-text toolbar label. */
  label: string;
  /** Human-readable name in Customize. */
  title: string;
  /** Root `skills/<id>/SKILL.md` installed by this assistant. */
  skill_id: string;
  /** Instruction sent with the selected text through the normal chat run. */
  prompt: string;
};

/** Immutable assistant-action definition copied into a new workspace. */
export type WorkspaceSelectionActionSnapshot = {
  assistant_slug: string;
  assistant_name: string;
  action_id: string;
  label: string;
  title: string;
  skill_id: string;
  skill_path: string;
  prompt: string;
};

export const CLAIM_VERIFIER_ASSISTANT_SLUG = 'claim-verification';
export const CLAIM_VERIFIER_ACTION_ID = 'verify-claim';
export const CLAIM_VERIFIER_NAME = 'Claim Verifier';

export function isClaimVerifierSelectionAction(action: {
  assistant_slug?: unknown;
  action_id?: unknown;
  id?: unknown;
}): boolean {
  const actionId = action.action_id ?? action.id;
  return (
    action.assistant_slug === CLAIM_VERIFIER_ASSISTANT_SLUG &&
    actionId === CLAIM_VERIFIER_ACTION_ID
  );
}

/** Normalize only the renamed action's user-facing identity. Its installed
 * prompt, label, skill bundle, and enablement remain immutable snapshots. */
export function canonicalizeSelectionActionDisplay<
  T extends {
    assistant_slug: string;
    assistant_name: string;
    action_id?: string;
    id?: string;
    title: string;
  },
>(action: T): T {
  return isClaimVerifierSelectionAction(action)
    ? { ...action, assistant_name: CLAIM_VERIFIER_NAME, title: CLAIM_VERIFIER_NAME }
    : action;
}

type SelectionActionAssistant = {
  slug: string;
  name: string;
  selection_actions: readonly AssistantSelectionAction[];
};

/**
 * Resolve an assistant's catalog actions against the exact root-level files
 * being seeded. The caller stores the returned rows during workspace
 * bootstrap, so later catalog edits cannot change that workspace's prompt or
 * skill path. Nested combined-template assistants are intentionally omitted by
 * their caller until nested skill paths are supported by the database schema.
 */
export function snapshotSelectionActions(
  assistant: SelectionActionAssistant,
  starterFiles: readonly { path: string; binary?: boolean }[],
): WorkspaceSelectionActionSnapshot[] {
  const files = new Map(starterFiles.map((file) => [file.path, file]));
  return assistant.selection_actions.map((action) => {
    const skillPath = `skills/${action.skill_id}/SKILL.md`;
    const skill = files.get(skillPath);
    if (!skill || skill.binary) {
      throw new Error(
        `Invalid assistant "${assistant.slug}": selection action "${action.id}" requires text skill "${skillPath}"`,
      );
    }
    const skillPrefix = `skills/${action.skill_id}/`;
    const binary = starterFiles.find(
      (file) => file.path.startsWith(skillPrefix) && file.binary,
    );
    if (binary) {
      throw new Error(
        `Invalid assistant "${assistant.slug}": selection action "${action.id}" skill bundle contains binary file "${binary.path}"`,
      );
    }
    return {
      assistant_slug: assistant.slug,
      assistant_name: assistant.name,
      action_id: action.id,
      label: action.label,
      title: action.title,
      skill_id: action.skill_id,
      skill_path: skillPath,
      prompt: action.prompt,
    };
  });
}

/** Authorized workspace view returned to selected-text toolbars. */
export type WorkspaceSelectionAction = Omit<AssistantSelectionAction, 'prompt'> & {
  assistant_slug: string;
  assistant_name: string;
  connected: boolean;
  enabled: boolean;
  /** Null before installation; connected rows expose the snapshotted prompt. */
  prompt: string | null;
  skill_path: string | null;
};

export const INVOKE_SELECTION_ACTION_EVENT = 'sundial:invoke-selection-action';
export const MAX_SELECTION_ACTION_TEXT_CHARS = 12_000;

/** Background action threads stay out of ordinary chat navigation until the
 * user explicitly opens one from its document annotation. */
export function shouldShowSelectionActionChat(
  chat: { id: string; kind?: string | null },
  selectedChatId: string | null,
): boolean {
  return chat.kind !== 'selection_action' || chat.id === selectedChatId;
}

/** Workspace-global assistant controls never inherit write capability from a
 * link grant, an open anonymous workspace, or admin support access. */
export function canManageWorkspaceAssistantActions(access: {
  canWrite: boolean;
  role?: string | null;
}): boolean {
  return access.canWrite && (access.role === 'owner' || access.role === 'editor');
}

/** Editors emit this intent with the same durable Yjs-relative selection used
 * by document comments. Oversized selections omit it and are rejected before
 * any annotation is created. */
export type SelectionActionInvocation = {
  action: Pick<
    WorkspaceSelectionAction,
    'id' | 'label' | 'title' | 'assistant_slug' | 'assistant_name'
  >;
  text: string;
  too_long?: boolean;
  path: string | null;
  selection?: DraftDocCommentSelection;
};

const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** DB admins can edit JSON directly; malformed entries should disappear from
 * the catalog instead of reaching client buttons or crashing the whole list. */
export function normalizeSelectionActions(value: unknown): AssistantSelectionAction[] {
  if (!Array.isArray(value)) return [];
  const actions: AssistantSelectionAction[] = [];
  const seen = new Set<string>();
  for (const candidate of value.slice(0, 8)) {
    if (!candidate || typeof candidate !== 'object') continue;
    const row = candidate as Record<string, unknown>;
    const id = typeof row.id === 'string' ? row.id.trim() : '';
    const label = typeof row.label === 'string' ? row.label.trim() : '';
    const title = typeof row.title === 'string' ? row.title.trim() : '';
    const skillId = typeof row.skill_id === 'string' ? row.skill_id.trim() : '';
    const prompt = typeof row.prompt === 'string' ? row.prompt.trim() : '';
    if (
      !ID_RE.test(id) ||
      !ID_RE.test(skillId) ||
      !label ||
      label.length > 24 ||
      !title ||
      title.length > 64 ||
      !prompt ||
      prompt.length > 8000 ||
      seen.has(id)
    ) {
      continue;
    }
    seen.add(id);
    actions.push({ id, label, title, skill_id: skillId, prompt });
  }
  return actions;
}

/** Selected-text assistants mutate workspace-global files and instructions.
 * Keep their UI limited to true workspace members even when a link/path grant
 * elevates `canWrite` for the whole visible workspace. */
export function resolveSelectionActionsProjectId(args: {
  filesLoaded: boolean;
  canManageAssistantActions: boolean;
  cloudProjectId: string | null;
}): string | undefined {
  return args.filesLoaded && args.canManageAssistantActions && args.cloudProjectId
    ? args.cloudProjectId
    : undefined;
}
