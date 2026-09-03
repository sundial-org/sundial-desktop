/**
 * Featured skills the Add-skill modal installs with one click. General-purpose
 * writing workflows, self-contained (no API keys, no external tools beyond
 * web search). The content lives here: unlike the pack-seeded Paperclip skill
 * (starter-packs.ts, which the Node sidecar also loads), nothing else needs
 * these strings.
 */
export type FeaturedSkill = {
  id: string;
  name: string;
  /** One-liner on the featured card. */
  tagline: string;
  content: string;
  /** API key the skill needs, offered as an inline input on install. */
  secret?: { name: string; placeholder: string; createUrl: string };
};

const LINE_EDIT_SKILL_MD = `---
name: Line edit
description: A careful line-by-line editing pass over a document, landing as reviewable suggestions. Use when asked to edit, tighten, or proofread prose without changing its meaning or voice.
---

Read the whole document first, then edit sentence by sentence.

1. Fix grammar, spelling, and punctuation.
2. Tighten: cut filler words, collapse redundant phrases, split run-ons. Prefer deleting words over adding them.
3. Preserve the author's voice and meaning exactly. If a sentence is unclear, keep its intent and flag it in a comment instead of guessing.
4. Make every change as a suggestion, never a silent rewrite. Batch related fixes so review is easy.
5. Finish with a short note: the two or three recurring habits you fixed most (e.g. passive voice, double adverbs), so the author can watch for them.

Never restructure sections, change facts, or alter quotes in a line edit. If the document needs structural work, say so and stop.
`;

const MEETING_NOTES_SKILL_MD = `---
name: Meeting notes
description: Turns raw meeting notes or a transcript into a clean record with decisions and action items. Use when given rough notes, a transcript, or a voice-memo dump from a meeting.
---

Turn the raw input into a record the whole team can rely on.

1. Write the output to \`notes/YYYY-MM-DD-<topic>.md\` (ask for the topic only if it is not inferable).
2. Structure:
   - **TL;DR** — 2-3 sentences.
   - **Decisions** — each on one line, with who made it if known.
   - **Action items** — checkbox list, each with an owner and a due date when stated. Never invent owners or dates.
   - **Open questions** — anything raised but not resolved.
3. Keep original wording for anything contentious; summarize the rest.
4. Leave the raw notes untouched. Link them from the record.

If the notes mention a previous meeting's action items, carry unfinished ones forward under "Still open".
`;

const WEEKLY_REVIEW_SKILL_MD = `---
name: Weekly review
description: Reads the week's documents and edits in this workspace and writes a weekly review. Use on request or on a schedule, typically at the end of the week.
---

Write the review the team keeps postponing.

1. Read what changed this week: recently edited documents, new files, and the week's conversations.
2. Write \`reviews/YYYY-Www.md\` with:
   - **Shipped** — what got finished, with links to the docs.
   - **Moved** — what progressed but is not done, one line each on where it stands.
   - **Stalled** — anything untouched for two or more weeks that still looks important. No guilt-tripping, just the list.
   - **Next week's top 3** — proposed, clearly marked as proposals.
3. Ground every line in a real document or edit; link it. If nothing happened in a category, omit the category.
4. Keep it under a page. The review is for skimming on Monday, not archiving.
`;

const RESEARCH_BRIEF_SKILL_MD = `---
name: Research brief
description: Turns a question into a short, sourced brief. Use when asked to research a topic, compare options, or find out the state of something.
---

Answer the question with sources, not vibes.

1. Restate the question in one line at the top; if it is ambiguous, pick the most useful reading and say so.
2. Search the web. Read at least three independent sources before writing; prefer primary sources (docs, papers, announcements) over commentary.
3. Write \`briefs/<kebab-topic>.md\`:
   - **Answer** — the direct answer in 2-4 sentences.
   - **What the sources say** — the key claims, each with its source linked inline and a confidence marker: solid (multiple independent sources), single-source, or contested.
   - **Where sources disagree** — name the disagreement instead of averaging it away.
   - **What I did not find** — the gaps, honestly.
4. Date the brief. Facts rot; the reader needs to know when this was true.

Never present a single source's claim as settled, and never cite a page you did not actually read.
`;

export const FEATURED_SKILLS: readonly FeaturedSkill[] = [
  {
    id: 'line-edit',
    name: 'Line edit',
    tagline: 'A careful editing pass that lands as suggestions, never a rewrite.',
    content: LINE_EDIT_SKILL_MD,
  },
  {
    id: 'meeting-notes',
    name: 'Meeting notes',
    tagline: 'Raw notes or a transcript into decisions and action items.',
    content: MEETING_NOTES_SKILL_MD,
  },
  {
    id: 'weekly-review',
    name: 'Weekly review',
    tagline: 'Reads your week and writes the review you keep postponing.',
    content: WEEKLY_REVIEW_SKILL_MD,
  },
  {
    id: 'research-brief',
    name: 'Research brief',
    tagline: 'A question into a sourced brief with links and confidence levels.',
    content: RESEARCH_BRIEF_SKILL_MD,
  },
];
