/**
 * Starter packs for the desktop "What do you want to build?" picker: each pack
 * scaffolds a new local project with ready-made folders and starter files.
 * Single source of truth — the picker UI (app/local) reads the metadata and
 * the sidecar (local-server, via Node type-stripping) writes the files, so the
 * two can never drift. Contents follow the cloud starters' rule: every main
 * file leads with a numbered "Start here" so the first action is unmissable.
 *
 * `{{date}}` in a path or body is replaced with the local YYYY-MM-DD at
 * scaffold time (the sidecar's clock — the machine the files land on).
 */

export type StarterPackFile = { path: string; content: string };

export type StarterPack = {
  id: string;
  title: string;
  /** One-liner under the title on the picker card. */
  tagline: string;
  /** Placeholder for the create dialog's project-name input. */
  namePlaceholder: string;
  /** Folders to create beyond the parents of `files` (shown empty in the tree). */
  folders: readonly string[];
  files: readonly StarterPackFile[];
};

const RESEARCH_TEX = `% A LaTeX paper with an agent beside you: live preview, no compile queue.
%
% Start here:
%   1. The PDF compiles beside your source as you open this file.
%   2. One \\ref below is broken (it renders "??"). Press Cmd+J and ask
%      Sunny to fix it. The fix lands as a tracked change you review.
%   3. Paste in your own draft, or drop your project into this folder.
\\documentclass{article}
\\usepackage{amsmath}

\\title{Your paper}
\\author{You, with an agent}
\\date{}

\\begin{document}
\\maketitle

\\section{Introduction}
Write here, compile instantly, and hand the grunt work (formatting,
citations, error logs) to an agent whose every edit is tracked.
Prior work~\\cite{vaswani2017attention} lives in \\texttt{refs.bib}.

\\section{Method}
\\begin{equation}
  \\label{eq:objective}
  \\mathcal{L}(\\theta) = -\\sum_{i=1}^{N} \\log p_\\theta(y_i \\mid x_i)
\\end{equation}

As Equation~\\ref{eq:loss} shows, the objective is standard maximum
likelihood. % <- broken \\ref: ask Sunny to fix it (Cmd+J)

\\bibliographystyle{plain}
\\bibliography{refs}
\\end{document}
`;

const REFS_BIB = `@inproceedings{vaswani2017attention,
  title     = {Attention Is All You Need},
  author    = {Vaswani, Ashish and Shazeer, Noam and Parmar, Niki and others},
  booktitle = {Advances in Neural Information Processing Systems},
  year      = {2017}
}
`;

const LITERATURE_MD = `# Literature notes

One running file for what you read. Each paper gets a summary; the takeaways
feed your related-work section.

## Start here

1. Drop a PDF into \`papers/\` (or paste an abstract below).
2. Press \`Cmd+J\` and ask: "Summarize this paper into my notes."
3. The notes land as tracked changes. Fix what it got wrong.

## Papers

> Paste an abstract or a link here to try it.
`;

const READING_LIST_MD = `# Reading list

The queue for this review. Move papers to Done as you take notes on them.

## Start here

1. Paste the papers you already know below (titles or links are enough).
2. Press \`Cmd+J\` and ask: "Find the seminal papers on <your topic> and add them to the queue."
3. Additions land as tracked changes — keep what belongs, cut the rest.

## Queue

- …

## Done

- …
`;

const SYNTHESIS_MD = `# Synthesis

Where the notes become an argument: themes across papers, disagreements, and
the gap your work fills. Draft it as \`notes/\` fills up — ask Sunny to
"synthesize my notes into themes" and shape what comes back.
`;

const IDEAS_MD = `# Ideas

Every piece starts here as one line. When one is ready, give it a file in
\`drafts/\`; when it ships, move it to \`published/\`.

## Start here

1. Brain-dump the pieces you want to write, one line each.
2. Press \`Cmd+J\` and ask: "Which of these is most worth writing first? Outline it."
3. The outline lands as a tracked change — accept it, then start the draft.

## The list

- …
`;

const DRAFT_MD = `# Untitled draft

An essay, a post, an article, written here with an agent beside you.

## Start here

> the quick brwn fox jumps over lazy dog

1. Highlight the line above, press \`Cmd+J\`, and ask "fix the typos".
2. The fix shows up as a tracked change. That's how every agent edit lands in Sundial: you see it before it's final.
3. Now paste in what you have, or ask for a first outline.

## When you're rolling

- "Rewrite the intro in a sharper voice."
- "Cut this by a third without losing the argument."
`;

const INBOX_MD = `# Inbox

The one place to drop a thought before it has a home. Keep dailies in
\`daily/\` — one file per day — and promote anything that grows into its own
note here in \`notes/\`.

## Start here

1. Jot three things on your mind, one line each.
2. Press \`Cmd+J\` and ask: "Turn these into tidy notes, one per topic."
3. The cleanup lands as tracked changes you review.
`;

const DAILY_MD = `# {{date}}

What happened, what you decided, what's next. Tomorrow's entry is one
\`Cmd+J\` away: "start today's daily from yesterday's open threads".

- …
`;

const KB_LOG_MD = `# Log

The running record of this knowledge base: what came in, what it changed.
Sources you're processing live in \`sources/\`; the distilled, trustworthy
write-ups live in \`articles/\`.

## Start here

1. Drop anything into \`sources/\` — a link list, a pasted email, a PDF.
2. Press \`Cmd+J\` and ask: "Distill sources/ into an article and log what you did here."
3. Everything lands as tracked changes — the article is only as trusted as your review.

## Entries

- {{date}} — created this knowledge base.
`;

const OUTLINE_MD = `# Outline

The spine of the book: parts, chapters, and the one idea each must land.
Chapters live in \`chapters/\`, one file each.

## Start here

1. Sketch the shape below — rough is fine.
2. Press \`Cmd+J\` and ask: "Tighten this into a chapter list with a one-line promise per chapter."
3. The structure lands as tracked changes. Reorder, cut, then open chapter one.

## The book

- Who it's for, and what changes for them by the last page.
- The three beats the whole thing builds toward.
`;

const CHAPTER_MD = `# Chapter 1

A book gets written one chapter at a time. Each chapter is a file, drafted
together.

## Start here

1. Sketch the chapter below: what happens, and where it ends.
2. Press \`Cmd+J\` and ask: "Expand my sketch into a first draft, in my voice."
3. The draft lands as tracked changes. Accept, reject, push back: "slower opening, land the ending harder."

## Chapter sketch

- Where this chapter starts and ends.
- The one idea it must land.
`;

export const STARTER_PACKS: readonly StarterPack[] = [
  {
    id: 'research-paper',
    title: 'Research paper',
    tagline: 'LaTeX with live preview and citations.',
    namePlaceholder: 'My Paper',
    folders: ['figures'],
    files: [
      { path: 'main.tex', content: RESEARCH_TEX },
      { path: 'refs.bib', content: REFS_BIB },
      { path: 'notes/literature.md', content: LITERATURE_MD },
    ],
  },
  {
    id: 'lit-review',
    title: 'Literature review',
    tagline: 'Papers in, synthesis out.',
    namePlaceholder: 'Lit Review',
    folders: ['papers', 'notes'],
    files: [
      { path: 'reading-list.md', content: READING_LIST_MD },
      { path: 'synthesis.md', content: SYNTHESIS_MD },
    ],
  },
  {
    id: 'writing',
    title: 'Writing pipeline',
    tagline: 'From first draft to finished piece.',
    namePlaceholder: 'My Writing',
    folders: ['published'],
    files: [
      { path: 'ideas.md', content: IDEAS_MD },
      { path: 'drafts/draft.md', content: DRAFT_MD },
    ],
  },
  {
    id: 'notes',
    title: 'Notes & dailies',
    tagline: 'Quick notes and one file per day.',
    namePlaceholder: 'Notes',
    folders: [],
    files: [
      { path: 'notes/inbox.md', content: INBOX_MD },
      { path: 'daily/{{date}}.md', content: DAILY_MD },
    ],
  },
  {
    id: 'knowledge-base',
    title: 'Knowledge base',
    tagline: 'Trusted articles from your sources.',
    namePlaceholder: 'Team Wiki',
    folders: ['articles', 'sources'],
    files: [{ path: 'log.md', content: KB_LOG_MD }],
  },
  {
    id: 'book',
    title: 'Book',
    tagline: 'One chapter at a time.',
    namePlaceholder: 'My Book',
    folders: [],
    files: [
      { path: 'outline.md', content: OUTLINE_MD },
      { path: 'chapters/chapter-01.md', content: CHAPTER_MD },
    ],
  },
];

export function starterPackById(id: string): StarterPack | null {
  return STARTER_PACKS.find((pack) => pack.id === id) ?? null;
}
