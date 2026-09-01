import { normalizeWorkspacePath } from '@/lib/sync/policy';

/**
 * Recognize a tool call that reads a workspace skill.
 *
 * The chat shows skill use as its own action rather than a generic `Read`: a
 * skill read and a plain file read mean different things to someone reviewing a
 * turn ("which of my skills did it apply?" vs "which of my files did it open?"),
 * and folding both into `Read skills/…/SKILL.md` buries the answer.
 *
 * This is derived from the tool call the agent actually made — never from the
 * model claiming it used a skill. That's what makes it trustworthy. Note it
 * evidences READING the skill, not following it; the UI must say so.
 */

export type SkillToolUse = {
  /** Folder id under `skills/`. */
  id: string;
  /** `entry` = the SKILL.md itself; `reference` = a supporting file it links to. */
  kind: 'entry' | 'reference';
  path: string;
};

/** `skills/<id>/SKILL.md`, or `skills/<id>/<anything else>`. */
const SKILL_FILE_RE = /^skills\/([^/]+)\/(.+)$/;

export function skillToolUse(toolName: string, input: unknown): SkillToolUse | null {
  if (toolName !== 'Read') return null;
  const raw = (input as { file_path?: unknown } | null)?.file_path;
  if (typeof raw !== 'string') return null;

  const match = SKILL_FILE_RE.exec(normalizeWorkspacePath(raw));
  if (!match) return null;
  const [, id, rest] = match;
  return { id: id!, kind: rest === 'SKILL.md' ? 'entry' : 'reference', path: normalizeWorkspacePath(raw) };
}

/**
 * The distinct skills touched across a run of tool calls, in first-use order —
 * what the collapsed tool strip advertises, so skill use is visible without
 * expanding it.
 */
export function skillsUsedIn(
  calls: { toolName: string; input: unknown }[],
): { id: string; readEntry: boolean; referenceCount: number }[] {
  const byId = new Map<string, { id: string; readEntry: boolean; references: Set<string> }>();
  for (const call of calls) {
    const use = skillToolUse(call.toolName, call.input);
    if (!use) continue;
    const entry = byId.get(use.id) ?? { id: use.id, readEntry: false, references: new Set<string>() };
    // A turn that only opened `references/a.md` never read the skill itself and
    // the UI must not claim it did — that's what this flag carries.
    if (use.kind === 'entry') entry.readEntry = true;
    // DISTINCT files: the tooltip says "N of its files", and offset-windowed
    // re-reads of one reference are still one file.
    else entry.references.add(use.path);
    byId.set(use.id, entry);
  }
  return [...byId.values()].map(({ id, readEntry, references }) => ({
    id,
    readEntry,
    referenceCount: references.size,
  }));
}
