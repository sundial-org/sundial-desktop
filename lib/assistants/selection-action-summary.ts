import { stripMarkdownSyntax } from '@/lib/workspace/derive-chat-title';

const DEFAULT_MAX_CHARS = 140;
const MAX_REASON_WORDS = 12;

const SUMMARY_HEADINGS = [
  'claim verifier result',
  // Legacy headings keep already-running and older installed snapshots usable.
  'quick answer',
  'verdict',
  'overall verdict',
  'summary',
  'bottom line',
  'conclusion',
  'overall assessment',
] as const;

const SUMMARY_LABEL = /^(?:quick answer|overall verdict|verdict|summary|bottom line|conclusion|overall assessment)\s*:\s*/i;
const MARKER = /<!--\s*sundial:selection-action-summary\s*(?::|\n)\s*([\s\S]*?)-->/i;
const XML_MARKER = /<selection_action_summary>([\s\S]*?)<\/selection_action_summary>/i;
const VERDICT_LINE = /^(not\s+contradicted|contradicted|partially\s+supported|supported|insufficient\s+evidence|source\s+inaccessible|needs\s+human\s+review)\b\s*(?:[.:—–-]+\s*)?(.*)$/i;

type BinaryVerdict = 'Contradicted' | 'Not contradicted';

function withoutFencedCode(markdown: string): string {
  return markdown.replace(/^\s*(```|~~~)[^\n]*\n[\s\S]*?^\s*\1\s*$/gm, '');
}

function headingText(line: string): string | null {
  const match = /^\s*#{1,6}\s+(.+?)(?:\s+#+)?\s*$/.exec(line);
  return match ? stripMarkdownSyntax(match[1]).trim().toLowerCase() : null;
}

function sectionUnderHeading(markdown: string, wanted: string): string | null {
  const lines = markdown.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    if (headingText(lines[index]) !== wanted) continue;
    const body: string[] = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (headingText(lines[cursor]) !== null) break;
      body.push(lines[cursor]);
    }
    const value = body.join('\n').trim();
    if (value) return value;
  }
  return null;
}

function visibleLine(line: string): string {
  return stripMarkdownSyntax(line)
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+)/u, '')
    .replace(SUMMARY_LABEL, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function fallbackReason(rawVerdict: string): string {
  if (/^contradicted$/i.test(rawVerdict)) {
    return 'Checked evidence directly conflicts with the selected claim.';
  }
  if (/^insufficient\s+evidence$/i.test(rawVerdict)) {
    return 'The checked evidence was insufficient to establish a conflict.';
  }
  if (/^source\s+inaccessible$/i.test(rawVerdict)) {
    return 'The evidence needed to establish a conflict was inaccessible.';
  }
  if (/^needs\s+human\s+review$/i.test(rawVerdict)) {
    return 'The checked evidence did not resolve the claim automatically.';
  }
  return 'No contradiction was found in the checked evidence.';
}

function binaryVerdict(rawVerdict: string): BinaryVerdict {
  return /^contradicted$/i.test(rawVerdict) ? 'Contradicted' : 'Not contradicted';
}

function conciseReason(rawVerdict: string, suppliedReason: string | undefined): string {
  // Legacy non-binary outcomes need an explicit limitation, not wording that
  // could make `Not contradicted` sound like a supported/verified badge.
  if (/^insufficient\s+evidence$/i.test(rawVerdict)) {
    return 'The checked evidence was insufficient to establish a conflict.';
  }
  if (/^source\s+inaccessible$/i.test(rawVerdict)) {
    return 'The evidence needed to establish a conflict was inaccessible.';
  }
  if (/^needs\s+human\s+review$/i.test(rawVerdict)) {
    return 'The checked evidence did not resolve the claim automatically.';
  }
  return suppliedReason?.trim() || fallbackReason(rawVerdict);
}

function truncateReason(reason: string, maxChars: number): string {
  const words = reason.trim().split(/\s+/u);
  const wordLimited =
    words.length > MAX_REASON_WORDS
      ? `${words.slice(0, MAX_REASON_WORDS).join(' ')}…`
      : words.join(' ');
  if (wordLimited.length <= maxChars) return wordLimited;
  const clipped = wordLimited.slice(0, Math.max(1, maxChars - 1));
  const boundary = clipped.lastIndexOf(' ');
  return `${(boundary >= Math.floor(maxChars * 0.55) ? clipped.slice(0, boundary) : clipped).trimEnd()}…`;
}

function formatVerdict(verdict: BinaryVerdict, reason: string, maxChars: number): string {
  const prefix = `${verdict} — `;
  const available = Math.max(1, maxChars - prefix.length);
  return `${prefix}${truncateReason(reason, available)}`;
}

function parseVerdict(candidate: string, maxChars: number): string {
  const lines = candidate.split('\n').map(visibleLine).filter(Boolean);
  for (let index = 0; index < lines.length; index += 1) {
    const match = VERDICT_LINE.exec(lines[index]);
    if (!match) continue;
    const rawVerdict = match[1];
    const reason = conciseReason(rawVerdict, match[2]?.trim() || lines[index + 1]);
    return formatVerdict(binaryVerdict(rawVerdict), reason, maxChars);
  }
  return '';
}

/**
 * Pull the Claim Verifier's one-line result from its full durable report.
 *
 * The display contract is intentionally binary and narrow: the returned line
 * always begins with `Contradicted` or `Not contradicted`. The latter only says
 * that the checked evidence did not establish a direct conflict; it does not
 * imply that the claim was supported or verified true. Full findings remain in
 * the selection action's thread.
 */
export function extractSelectionActionSummary(
  report: string | null | undefined,
  maxChars = DEFAULT_MAX_CHARS,
): string {
  if (!report?.trim() || maxChars <= 0) return '';

  const normalized = withoutFencedCode(report.replace(/\r\n?/g, '\n').replace(/\0/g, ''));
  const explicit = MARKER.exec(normalized)?.[1]?.trim() ?? XML_MARKER.exec(normalized)?.[1]?.trim();
  if (explicit) {
    const result = parseVerdict(explicit, maxChars);
    if (result) return result;
  }

  for (const heading of SUMMARY_HEADINGS) {
    const section = sectionUnderHeading(normalized, heading);
    if (!section) continue;
    const result = parseVerdict(section, maxChars);
    if (result) return result;
  }

  // Compatibility for old snapshots that emitted a direct labelled verdict
  // without a heading. Do not mine an arbitrary Details section for an atomic
  // finding and accidentally present it as the overall result.
  if (normalized.split('\n').some((line) => headingText(line) !== null)) return '';
  return parseVerdict(normalized.replace(/<!--[\s\S]*?-->/g, ''), maxChars);
}
