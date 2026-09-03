/**
 * Starter packs for the desktop "What do you want to get done?" picker: each pack
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
  /**
   * Audience gate. A pack tagged `'scientific'` is only listed on the
   * scientific flavor (lib/flags/product-flavor); the general desktop/OSS build
   * must not lead with LaTeX and papers. Untagged packs list everywhere, and
   * `starterPackById` stays unfiltered so an id already chosen still scaffolds.
   */
  flavor?: 'scientific';
  /**
   * The document a freshly scaffolded project opens on — the one carrying the
   * pack's "Start here" copy. Without it the arrival heuristic picks the most
   * recently edited file, which is whichever file the pack happened to write
   * last. Must name one of `files`.
   */
  openPath: string;
};

const RESEARCH_TEX = `% A LaTeX paper with an agent beside you: live preview, no compile queue.
%
% Start here:
%   1. The PDF compiles beside your source as you open this file.
%   2. One \\ref below is broken (it renders "??"). Press Cmd+J and ask
%      the Agent to fix it. The fix lands as a tracked change you review.
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
likelihood. % <- broken \\ref: ask the Agent to fix it (Cmd+J)

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
3. Additions land as tracked changes. Keep what belongs, cut the rest.

## Queue

- …

## Done

- …
`;

const SYNTHESIS_MD = `# Synthesis

Where the notes become an argument: themes across papers, disagreements, and
the gap your work fills. Draft it as \`notes/\` fills up: ask the Agent to
"synthesize my notes into themes" and shape what comes back.
`;

const IDEAS_MD = `# Ideas

Every piece starts here as one line. When one is ready, give it a file in
\`drafts/\`; when it ships, move it to \`published/\`.

## Start here

1. Brain-dump the pieces you want to write, one line each.
2. Press \`Cmd+J\` and ask: "Which of these is most worth writing first? Outline it."
3. The outline lands as a tracked change. Accept it, then start the draft.

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
\`daily/\` (one file per day) and promote anything that grows into its own
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

1. Drop anything into \`sources/\`: a link list, a pasted email, a PDF.
2. Press \`Cmd+J\` and ask: "Distill sources/ into an article and log what you did here."
3. Everything lands as tracked changes. The article is only as trusted as your review.

## Entries

- {{date}}: created this knowledge base.
`;

const OUTLINE_MD = `# Outline

The spine of the book: parts, chapters, and the one idea each must land.
Chapters live in \`chapters/\`, one file each.

## Start here

1. Sketch the shape below. Rough is fine.
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

// Also seeded by research packs and installable from the Add-skill modal's
// featured list (lib/skills/featured.ts) — defined here because this module is
// the one file both the web app and the Node sidecar already load.
export const PAPERCLIP_SKILL_MD = `---
name: Paperclip
description: >
  Searches millions of full-text scientific documents with the Paperclip CLI
  (paperclip.gxl.ai). Use when the user asks for a literature search, related
  work, citations, a systematic review, clinical trials, FDA or regulatory
  documents, patents, protein or drug data, or peer reviews.
---

# Paperclip

A virtual filesystem of full-text biomedical papers, regulatory documents, clinical trials, and protein databases.
## Setup

Needs \`PAPERCLIP_API_KEY\` in the shell. Keys are free at https://paperclip.gxl.ai/keys.

1. If it is not set, stop and ask the user for a key. In a cloud workspace save it
   with \`save_workspace_secret\` (or Settings -> Secrets, name \`PAPERCLIP_API_KEY\`);
   workspace secrets are injected into your shell automatically. In a local project,
   ask the user to \`export PAPERCLIP_API_KEY\` instead.
2. Install the CLI if missing:
   \`command -v paperclip >/dev/null || curl -fsSL https://paperclip.gxl.ai/install.sh | bash\`
   If \`paperclip\` still isn't found, add \`$HOME/.local/bin\` and \`$HOME/.paperclip/bin\`
   to PATH for the commands you run.
3. Verify it actually runs, and repair it if not:
   \`paperclip config >/dev/null 2>&1 || pip3 install --quiet --target "$HOME/.paperclip/lib" pyyaml requests click\`
   The installer reports success even when its dependency step failed, so on a
   fresh machine or sandbox the first real command dies with
   \`ModuleNotFoundError: yaml\`. The wrapper always adds \`~/.paperclip/lib\` to
   \`sys.path\`, so installing there fixes it without touching system Python.
   Run this once before anything else; it is a no-op when healthy.

## Before you start

Run \`paperclip skill\` once per task. It prints the current authoritative version of
this document from the server plus the routines enabled for this account, so it
supersedes anything below that has drifted. Run \`paperclip skill <domain>\`
(\`proteins\`, \`patents\`, \`sec\`) before any SQL or deep work in that domain, the
schemas are not guessable and wrong column names are the most common failure.

## Known gotchas (verified 2026-08-14)

These bite on the first command, so read them before writing any:

- **\`-s\` is required on every search.** \`paperclip search "query"\` hard-errors with
  \`search requires a source flag (-s)\`. Use \`-s pmc\`, \`-s biorxiv\`, \`-s papers\`, etc.
- **Repos are OFF by default and are opt-in.** \`repo\`/\`git\`/\`import\` fail with
  "Paper repositories are disabled" until \`paperclip repos-feature enable\`. Do not
  enable or create repos on your own initiative; cite directly from the text instead,
  and only use repos when the user explicitly asks to build or verify a collection.
- **\`reduce\` may return an empty artifact.** It can report "Reduce complete ... in
  57ms" and store only that status line. Check the output; when it is empty, fetch the
  per-paper answers with \`paperclip results <m_id>\` and synthesize them yourself into
  the workspace document. Do not report a reduce result you have not read.
- **\`bash '...'\` pipes do not work**, despite being documented below. Every form
  returns \`vsh: ... command not found\`. Run separate commands and combine the output
  yourself.
- **\`ask_image\` needs a full path.** \`ask_image <filename>\` fails even after \`cd\`;
  pass \`/papers/<id>/figures/<file>\`. (\`ask_image --list\` does work after \`cd\`.)
- **\`documents\` SQL uses \`pub_year\`, not \`year\`.** A wrong column name errors across
  every backend at once and looks like the table is missing. Columns are listed in the
  SQL section below.
- **A crashed \`map\` may still have saved its results.** If \`map\` errors after the
  progress bar completes, note the \`m_<id>\` from the progress line and run
  \`paperclip results <m_id>\` before retrying, the work is usually there.

## Working style in a workspace

- Start broad (\`search\`/\`searches\`), then open and read the specific sections you cite.
  Never cite a paper whose relevant section you did not open.
- Write the synthesis into the workspace files with normal edits, so it lands as
  reviewable, attributed changes in the document rather than staying in tool output.
- Cite with real identifiers (DOI, PMC id, arXiv id) pulled from \`meta.json\`.


---

_Reference below adapted from \`paperclip skill\` (GXL). Run \`paperclip skill\` for the current version._


## Filesystem

\`\`\`
/papers/          3.4M+ papers (PMC, bioRxiv, medRxiv, arXiv)
/fda/             Regulatory documents
  us/             US FDA (200k+ docs)
  jp/             Japan PMDA (38k+ docs)
  eu/             EU EPAR (8k+ docs)
/trials/          Clinical trial registries (alias: /clinicaltrials/)
  us/             ClinicalTrials.gov (580k+ trials)
  cn/             ChiCTR (116k+ trials)
  jp/             UMIN + JRCT (100k+ trials)
  eu/             EudraCT + CTIS + ISRCTN (85k+ trials)
  intl/           All registries combined + WHO ICTRP (1.08M+ trials)
/proteins/        UniProt + PDB + ChEMBL (574K+ proteins; search: -s proteins)
  {ACCESSION}/    Per-protein VFS (meta.json, content.lines)
/patents/         Patent publications (SQL VFS; search: -s patents)
  {PUB}/          e.g. US-9585906-B2, meta.json, abstract.txt, content.lines,
                  sections/, surechembl/compounds.tsv, sequences.tsv
/sec/             SEC EDGAR life-sciences filings (ls/cat/sql: -s sec)
  {ACCESSION}/    Filing VFS (meta.json, content.lines, items/, exhibits/)
/clipboard/       User's personal clipboard (uploaded PDFs + corpus links)
/peer_reviews/    Nature transparent reviews + OpenReview reports
  {REVIEW_ID}/    Direct review access (meta.json, content.lines)
\`\`\`

All document types share the same layout: \`meta.json\`, \`content.lines\` (full text, line-numbered), \`sections/\`, \`figures/\`, \`supplements/\`.
Papers with linked reviews also expose \`peer_review/\`, grouped by source and review ID:

\`\`\`
/papers/<paper-id>/peer_review/open_review/<openreview-id>/
/papers/<paper-id>/peer_review/nature/<nature-review-id>/
\`\`\`

Search peer reviews across both sources with \`paperclip search -s peer_reviews "query"\`.
This source is opt-in and is not included in the default paper search.

**Mandatory peer-review intent routing:** When the user asks for peer reviews,
reviewer comments, referee reports, author rebuttals, review concerns, or what
reviewers criticized, search \`-s peer_reviews\` first. Do not rely on a default
paper search or claim that reviews are unavailable until this source has been
searched explicitly. Ordinary papers and published commentaries may supplement
the review evidence, but must not silently replace it.

Each result prints a direct \`Review:\` path that can always be opened, plus a
\`Reviewed paper:\` path when an evidence-backed paper link exists:

\`\`\`
paperclip ls /peer_reviews/<review-id>/
paperclip cat /peer_reviews/<review-id>/meta.json
paperclip cat /peer_reviews/<review-id>/content.lines
\`\`\`

Use \`meta.json\` to inspect \`linked_papers\`, \`linked_paper_path\`, match method,
and confidence. OpenReview paper links come from accepted stored link records;
Nature links require an exact DOI match. If no reviewed-paper path is present,
do not infer one from title similarity, the direct review path remains valid.
Patents follow that shell with patent-specific \`abstract.txt\`, \`surechembl/\`, and \`sequences.tsv\` (see \`paperclip skill patents\`).

IDs: \`PMC\` (PubMed Central), \`bio_\` (bioRxiv), \`med_\` (medRxiv), \`arx_\` (arXiv), \`fda_\` (FDA), \`tri_\` (trials), patent publication numbers (\`US-…-B2\`, \`EP-…\`, \`WO-…\`).

Documents can be accessed without a region prefix: \`/trials/NCT03928938/\` works the same as \`/trials/us/NCT03928938/\`.

\`/.gxl/\` is writable scratch space. All other paths are read-only.

## Workflow

### Remote routine routing

\`paperclip skill\` appends the current account-enabled routine registry to this
document. Before starting a Paperclip task, compare the user's intent with that
registry. When a trigger matches, run:

\`\`\`bash
paperclip routines route "<short intent>"
\`\`\`

The command prints the latest remote orchestrator directly into context.
Follow its ordered instructions and fetch only the current phase with
\`paperclip routines show <routine>/phases/<phase>\`. Do not install, locate, or
redirect (\`>\`) local SKILL.md files into the project. Use
\`paperclip routines run <routine> <operation>\` when a phase requests a trusted
ephemeral helper.

1. **Find by topic**: \`search -s pmc "topic"\` -> present results
2. **Find by exact text (across the whole corpus)**: \`grep "term" /papers/\`, full-text regex over every paper's body, not just abstracts. Use this (not \`sql ... ILIKE\`) to locate papers that mention a name/dataset/gene/accession.
3. **One paper**: \`head\`/\`grep\`/\`scan\` on \`/papers/<id>/\`
4. **Many papers**: \`search -n 10\` -> \`map --from ID "q"\` -> \`reduce\` -> synthesize
5. **Cite**: cite directly with line numbers from the text you read (see Citations)
6. **Stats/metadata**: \`sql "SELECT ..."\` (counts, dates, journals, not full-text)

**Repos are OFF by default.** Do not create, add to, or commit repos on your own initiative, cite directly instead. Only use the repo/verification workflow when the user explicitly asks for it (see Paper Repositories). If a command shows a leftover \`[repo: <name>]\` from an earlier task, ignore it, don't add papers to it unless the user asked to use that repo.

## Citations & Verification

Cite directly from the text you've read, using line numbers, this is the default for **every** query, whether a simple lookup or a multi-paper synthesis. Read the relevant lines and cite them; don't paraphrase beyond what the text supports.

Claim verification via repos is **opt-in**: only run it when the user explicitly asks to verify claims or build a cited repo (see Paper Repositories). Do not start repos or run \`repo commit\` verification on your own.

### Citation format

Cite **[1]**, **[2]** inline. End with:

\`\`\`
--------
REFERENCES
[1] Authors. "Title." *Journal* vol, pages (year). doi:XX
    https://paperclip.gxl.ai/citations/papers/<doc_id>#L<n>
\`\`\`

Note that the ONLY valid inline format is \`[N]\`, e.g. \`[1]\`, \`[2]\`. Don't use variants like \`[1, L151]\`, \`[1, line 45]\`, \`[ref 1]\`, \`(L45)\`, \`(L45-L52)\`, \`(L45, L120)\`, or any other modification. The \`L<n>\` format is only valid inside REFERENCES URLs and CLI flags, never inline in prose text. Every direct quote and blockquote (">") must be followed by a citation.

URLs associated with citations should be in the following format: \`https://paperclip.gxl.ai/citations/{papers|fda|trials|patents|sec}/<doc_id>#L<n>\`

- Line numbers from \`L<n>\` prefixes in \`content.lines\`.
- Single: \`#L45\` - range: \`#L45-L52\` - multiple: \`#L45,L120,L210\`.
- Nature style for journals. "bioRxiv/medRxiv (year)" for preprints.
- Get author names, title, DOI from \`meta.json\`.
- Never expose doc_id in prose. Number references in order of first appearance.

## Commands

Run \`<cmd> --help\` for full usage on any command.

### Search & Discovery

| Command | Description |
|---------|-------------|
| \`paperclip search QUERY\` | Semantic + keyword search. Key opts: \`-n\`, \`-s SOURCE\`, \`-e\`, \`--since\`, \`--sort\`, \`--author\`, \`--journal\`, \`--year\`, \`--corpus\` (search full corpus even with a repo active - use during discovery) |
| \`paperclip grep PATTERN PATH\` | Regex search across corpus or within a paper. Use \`--bool '"A" AND NOT "B"' /papers/\` for whole-document boolean regex (\`NOT > AND > OR\`); pure NOT requires \`--from\` or \`search | grep\`. Corpus-wide grep is time-bounded by default; add \`--exhaustive\` for a full-timeout scan when a rare pattern returns nothing. |
| \`paperclip lookup FIELD VALUE\` | Find by metadata: doi, author, title, pmc, pmid, journal |
| \`paperclip sql "SELECT ..."\` | SQL on \`documents\` table (200-row limit) |
| \`paperclip filter --from ID QUERY\` | LLM-based relevance filter on search results |
| \`paperclip refine --from ID FLAGS\` | Deterministic metadata/structure filtering; saves a new result set |
| \`paperclip merge/intersect/subtract IDs...\` | Union, intersection, or subtraction of saved paper sets |

### Reading & Analysis

| Command | Description |
|---------|-------------|
| \`paperclip cat\`, \`head\`, \`tail\`, \`ls\` | Read files, list directories |
| \`paperclip scan FILE "p1" "p2"\` | Multi-pattern search in a file |
| \`paperclip ask-image PATH "q"\` | Analyze figure with vision. \`--fn describe\` / \`--fn extract-data\` |
| \`paperclip map --from ID "q"\` | LLM reader across search results - answers per paper |
| \`paperclip reduce --from ID "q"\` | Synthesize map results. Strategies: summarize, table, themes |
| \`paperclip results [ID]\` | View saved search/map results. \`--list\` to see all |

### Core Skill, Domain References & Routines

| Command | Description |
|---------|-------------|
| \`paperclip install\` | Install the lightweight core agent-skill pointer |
| \`paperclip skill\` | Load current core instructions and enabled-routine triggers |
| \`paperclip skill <domain>\` | Load a domain reference such as \`patents\`, \`proteins\`, or \`sec\` |
| \`paperclip routines list\` | List guided workflows available to the current account |
| \`paperclip routines search "query"\` | Search available routines |
| \`paperclip routines enable/disable <name>\` | Change account-level routine enablement |
| \`paperclip routines show <name>\` | Load an orchestrator or one of its phase files |
| \`paperclip routines route "intent"\` | Load the enabled routine matching the user's request |
| \`paperclip routines run <name> <operation>\` | Run a trusted helper from a verified temporary bundle |

### Paper Repositories - Core (opt-in)

**Only use these when the user explicitly asks to build a repo or verify claims, never by default.** \`paperclip git\` (= \`paperclip repo\`) tracks a named collection of papers + verifiable *claims*, independent of the clipboard. It snapshots and verifies claims against full text; it does **NOT** store arbitrary generated files or copy papers into \`/clipboard/\`. To persist a file you created (e.g. \`analysis.json\`, \`index.html\`, a report), use **\`paperclip upload <file> --into <folder>\`** (see Clipboard below), **never** \`git commit\`/\`repo commit\`, which only records claim metadata.

Repos are deliberately domain-agnostic: claims may be free text or
caller-defined JSON. For a systematic review or quantitative meta-analysis,
load \`paperclip routines show paperclip-meta-analysis\` before creating the repo.
That workflow requires structured, line-pinned JSON claims and deterministic
compile/QA scripts; ordinary free-text claims remain valid for general repos
but are not poolable meta-analysis effects.

| Command | Description |
|---------|-------------|
| \`paperclip git init <name>\` | Enable git tracking for a named repo |
| \`paperclip git add <id> "claim"\` | Add paper + verifiable claim to the repo |
| \`paperclip git add <id>\` | Add paper without claim (collection only, not verified) |
| \`paperclip git commit -m "message"\` | Snapshot + verify all claims against full text in parallel |
| \`paperclip git status\` | Show current repo: papers, claims, [OK]/[X] marks from last commit |
| \`paperclip git log\` | Show commit history |

**Requires an active repo.** Run \`paperclip git init <name>\` first.

**Hosted MCP is stateless:** repo selection never carries across tool calls.
After \`git init <name>\`, identify the repo on every later call with the global
\`paperclip --repo <name> git ...\` form or the git command's \`-f <name>\` option.
Bare repo/git commands intentionally fail instead of using hidden current state.

### Clipboard

\`/clipboard/\` is the user's personal, private document space, uploaded PDFs, saved corpus papers, imported bibliographies, and generated artifacts. Every document is parsed into the same \`meta.json\` + \`content.lines\` + \`sections/\` + \`figures/\` layout as the public corpus, so \`search\`, \`grep\`, \`cat\`/\`head\`, \`map\`, \`ask-image\`, and citations all work on it unchanged. Clipboards are isolated per user (private search indexes) and can be shared by folder.

**Adding documents**

| Command | Description |
|---------|-------------|
| \`paperclip cp ~/papers/\` | Upload local PDFs (file or folder) to \`/clipboard/<folder>/\` |
| \`paperclip cp paper.pdf /clipboard/research/\` | Upload a file into a specific folder |
| \`paperclip cp /papers/<id> /clipboard/<folder>/\` | Save a corpus paper as a zero-copy link (also \`/fda/\`, \`/trials/\`) |
| \`paperclip cp /clipboard/<id> /clipboard/<folder>/\` | Copy/link an existing clipboard doc |
| \`paperclip fetch <url\\|doi> [--into /clipboard/<folder>/]\` | Download a paper via your browser cookies (paywalled/institutional) and add it |
| \`paperclip upload <file>... --into <folder>\` | **Save generated FILES (JSON/HTML/CSV/MD/PDF) into a folder**, this is how you persist analysis artifacts/reports. \`git\`/\`repo commit\` does NOT store files. |
| \`paperclip import refs.bib --into /clipboard/<folder>\` | Import a .bib/.ris, each citation becomes a folder (corpus link when found, else citation metadata) |

**Organizing & reading**

| Command | Description |
|---------|-------------|
| \`paperclip ls /clipboard/[<folder>]\` | List folders / documents |
| \`paperclip tree /clipboard/\` | Recursive listing of folders + documents |
| \`paperclip mkdir /clipboard/<folder>\` | Create a folder (nesting allowed) |
| \`paperclip mv /clipboard/<src> /clipboard/<dest>/\` | Move or rename a folder/document (metadata only) |
| \`paperclip rm /clipboard/<folder> -R\` · \`rm /clipboard/<id>\` | Soft-delete a folder / single document |
| \`paperclip head /clipboard/<folder>/<id>/content.lines\` | Read a document's text |
| \`paperclip du /clipboard/\` · \`find <pat> /clipboard/\` · \`wc <file>\` | Storage summary · find files · counts |
| \`paperclip ask-image /clipboard/<folder>/<id>/figures/<fig> "q"\` | Analyze a figure/table with vision |

**Searching**

| Command | Description |
|---------|-------------|
| \`paperclip search "query" -s clipboard\` | Search across your whole clipboard |
| \`paperclip search "query" -s clipboard/<folder>\` | Scope the search to one folder |
| \`paperclip grep "pattern" /clipboard/[<folder>/]\` | Full-text regex over clipboard docs |

Clipboard is a separate search backend from the public corpus, a single \`-s\` won't merge them. Pass comma sources (\`-s pmc,clipboard\`) to query both and present the union.

**Sharing** (folder-level)

| Command | Description |
|---------|-------------|
| \`paperclip share <folder> <email> [--role viewer\\|editor]\` | Grant a teammate access to a folder |
| \`paperclip unshare <folder> <email>\` | Revoke access |

**Bulk / bidirectional sync**, mirror a local folder to your clipboard:

\`\`\`
paperclip sync add ~/papers --prefix oncology   # register a local folder
paperclip sync run [--dry-run]                   # upload new/modified, remove deleted
paperclip sync status                            # registered folders + remote counts
paperclip sync rm <folder|usr_id|--all>          # delete remote docs
\`\`\`

Notes:
- To save a paper you found via search, use \`cp /papers/<id> /clipboard/<folder>/\`. NOT \`import <id>\` (that fetches the paper's *references*, not the paper itself).
- Corpus links (\`cp /papers/...\`) are references, not copies: reading \`content.lines\` on a link proxies to the original corpus.
- Uploads are also available from the web UI (drag-and-drop at the \`/clipboard\` page) and the Chrome extension (one-click save from any paper page → \`/clipboard/chrome-downloads/\`).
- Limits per user: 200 MB/file, 2,000 pages/PDF, 10,000 documents, 10 GB total.

### Paper Repositories - Advanced (legacy \`repo\` commands)

| Command | Description |
|---------|-------------|
| \`paperclip repo checkout <name>\` | Switch branch or repo. Tries branch first, then repo. Use \`-\` to deactivate. |
| \`paperclip repo branch <name>\` | Create + switch to a new branch (forks current papers) |
| \`paperclip repo merge <branch>\` | Merge a branch into the current one (union of papers) |
| \`paperclip repo\` | List all repos |
| \`paperclip repo history\` | Command audit trail (searches, maps, etc. - not commits) |
| \`paperclip repo citations\` | Citation counts + graph via Semantic Scholar |
| \`paperclip repo export bibtex\\|ris\\|csv\\|markdown\` | Export repo as bibliography or data |
| \`paperclip import\` | Import references: from .bib/.ris files, or fetch a paper's bibliography via Semantic Scholar (does NOT add the paper itself) |
| \`paperclip library\` | Personal paper library |

### Other

| Command | Description |
|---------|-------------|
| \`paperclip config\` | Settings and connection diagnostics |

Text processing: \`sed\`, \`awk\`, \`sort\`, \`cut\`, \`tr\`, \`jq\` - standard tools, pipes via \`bash '...'\`.

## Search

**The \`-s\` flag is required.** Every search must specify a source with \`-s\` or a virtual directory path.

| Scope | Command |
|-------|---------|
| All papers (PMC + bioRxiv + medRxiv + arXiv) | \`search -s papers "CRISPR delivery"\` |
| Specific paper corpora | \`search -s pmc,biorxiv,medrxiv,arxiv "CRISPR delivery"\` |
| PMC (full-text papers) | \`search -s pmc "CRISPR delivery"\` |
| bioRxiv preprints | \`search -s biorxiv "protein design"\` |
| medRxiv preprints | \`search -s medrxiv "long COVID"\` |
| arXiv preprints | \`search -s arxiv "diffusion models"\` |
| Abstracts only (broader) | \`search -s abstracts "drug discovery"\` |
| FDA (all regions) | \`search -s fda "pembrolizumab"\` |
| FDA (specific region) | \`search "pembrolizumab" /fda/us\` |
| Trials (all) | \`search -s trials "breast cancer HER2"\` |
| Trials (specific) | \`search "breast cancer" /trials/us\` |
| Proteins (UniProt/PDB/ChEMBL) | \`search -s proteins "kinase inhibitor"\` |
| Patents | \`search -s patents "kinase inhibitor"\` |
| SEC EDGAR filings | \`search -s sec "Moderna"\` · \`grep "term" /sec/\` · \`cat /sec/{ACCESSION}/content.lines\` |

**Source selection rule:** When the user specifies a domain (e.g. "trials", "regulatory", "FDA", "patents", "SEC"), use the corresponding \`-s\` flag or virtual directory path. For general biomedical literature, use \`-s pmc\`. If a query mentions proteins, compounds, drugs, structures, UniProt, PDB, or ChEMBL, ask the user whether they want structured database data (\`-s proteins\`) or published papers about the topic (\`-s pmc\`). For patent filings, SureChEMBL chemistry, or claims/description text, use \`-s patents\` / \`/patents/\`. Run parallel targeted searches when multiple sources are needed.

**MUST: Before deep patent work (reading claims/description, SureChEMBL compounds, or patent SQL assumptions), run \`paperclip skill patents\` and read it.** Do not invent legacy paths like \`claims/\` or \`family/members.tsv\`.

Key options: \`-n/--limit\`, \`-s/--source\`, \`--ranking [hybrid|bm25|vector|analogical]\`, relevance floors, \`--year[-min|-max]\`, \`--journal\`, \`--article-type\`, repeatable \`--exclude-*\` metadata flags, \`--has-full-text\`, \`--has-block-type\`, \`--without-block-type\`, \`--has-section\`, \`--without-section\`, \`--full-text\`, and \`--bool\`.

### Ordering and determinism

Standard hybrid search uses the same 100 keyword and vector candidates for
every \`-n\` value through 100. For an unchanged query, filter set, and search
index, a smaller result set is a stable prefix of a larger result set:
\`search ... -n 8\` matches the first 8 results from \`search ... -n 50\`.
Requests above 100 expand the candidate pool and can reorder earlier results.
Index updates can also change results between calls.

For \`grep\`, \`-n\` displays line numbers; it is not the match limit. Use \`-m NUM\`
to limit matches. Corpus-wide grep runs parallel, time-bounded scans. When a
scan reaches \`-m\` or its time budget, repeated calls or different \`-m\` values
can return a different set or order. Grep within one document follows file line
order and has stable prefixes. \`--exhaustive\` gives a corpus-wide scan more time,
but it does not make truncated results ranked or deterministic.

Boolean paper search uses quoted, analyzed phrases with case-insensitive \`NOT > AND > OR\` precedence and parentheses. It requires an explicit \`--ranking bm25\`; unlike \`grep\`, operands are OpenSearch phrases, not regexes. It supports PMC, bioRxiv, medRxiv, arXiv, and abstract-only search plus normal source/date/journal/article-type/year/sort/limit/ID-scope filters. Match full paper content with \`--full-text\` (not available for abstract-only sources). Boolean mode cannot be combined with \`-m\`, \`-e\`, \`-r\`, \`-a\`, or \`-t\`.

Example: \`paperclip search -s pmc --bool --ranking bm25 '"CRISPR" AND ("base editing" OR "prime editing") AND NOT "review"'\`

For deterministic cohort refinement, use \`refine --from s_ID\` with the same quality flags. Use \`grep --bool --from s_ID --block-type table --section results EXPR\` to constrain text predicates to structural content. Use \`merge\`, \`intersect\`, and \`subtract\` for saved-set algebra.

Add \`--save-as NAME\` to any result-producing command to create a readable session-scoped alias. Aliases can replace generated \`s_\` IDs in \`--from\`, \`merge\`, \`intersect\`, and \`subtract\`, e.g. \`search --save-as pk_candidates "pharmacokinetics"\` then \`refine --from pk_candidates --has-block-type table --save-as pk_tables\`.

Run reusable deterministic workflows with \`paperclip search --config workflow.yaml\`. A workflow uses named steps with \`operation: search\`, \`grep\`, \`refine\`, \`merge\`, \`intersect\`, or \`subtract\`; later steps reference earlier names through \`from\`. Supply typed parameter overrides with \`--set NAME=VALUE\`, external result IDs or aliases with \`--input NAME=VALUE\`, and name a particular run with \`--save-as NAME\`.

Generate a workflow from proposal text or an existing Markdown/text file, then
review and run it separately:

\`\`\`bash
paperclip generate-search-config proposal.md
paperclip generate-search-config "Find primary pharmacokinetic studies" -o pk.yaml
paperclip search --config pk.yaml --save-as pk-cohort
\`\`\`

Generation writes YAML in the current directory and never executes the search.
The default filename comes from the generated workflow name. Existing files are
preserved unless \`--force\` is supplied. Provider credentials remain server-side;
the command uses the same Paperclip login or API key as other CLI commands.

**Analogical search** (\`--ranking analogical\`): Finds papers that share the same *structural method* across different domains, even when vocabularies are completely different. Use when the user wants cross-domain analogies, methodological parallels, or "what other fields use this technique?" queries.

**How to write the query, this matters a lot:**

The query text gets embedded with a fine-tuned model trained on paper abstracts. Different query formulations produce very different results:

1. **Best: full abstract**. If the user has a specific paper, use its entire abstract as the query. This is what the model was trained on and produces the highest-quality matches. Read the paper first with \`cat\`, extract the abstract, then search with it.
2. **Good: method/problem description (1-2 sentences)**. Describe the *structural method* or *problem pattern*, not the topic. Focus on what the paper *does*, not what it's *about*. Example: "correcting for systematic under-reporting in training data where the missingness mechanism is unknown" finds cross-domain analogies across biodiversity, epidemiology, and proteomics.
3. **Good: plain-language problem**. Describe the problem without jargon: "my training labels are unreliable because some positives are systematically missed as negatives" finds positive-unlabeled learning papers across NLP, biology, and cosmology.
4. **Bad: topic keywords**. Short keyword queries like "influence functions" or "CRISPR delivery nanoparticle" return topically similar papers, not structural analogies. This defeats the purpose, use standard \`--ranking hybrid\` for keyword searches.

**Workflow for a known paper:**
\`\`\`
paperclip cat PMC1234567 | head -30        # read abstract
paperclip search -s arxiv --ranking analogical "<paste full abstract here>" -n 10
paperclip search -s biorxiv --ranking analogical "<paste full abstract here>" -n 10
\`\`\`

**Workflow for a described problem:**
\`\`\`
paperclip search -s arxiv --ranking analogical "I need to approximate an expensive leave-one-out computation cheaply by exploiting low-rank structure in my parameter space" -n 10
\`\`\`

**Tip:** Run analogical search across multiple sources (\`-s arxiv\`, \`-s biorxiv\`, \`-s pmc\`) separately to find analogies in different scientific communities. The most valuable matches are often in the source you'd least expect.

### Filter

Use \`filter\` after \`search\` to remove irrelevant results via LLM evaluation before passing to \`map\`:

\`\`\`
paperclip search -s fda "semaglutide" -n 50
paperclip filter --from s_abc123 "semaglutide cardiovascular outcomes"
paperclip map --from s_abc123 "What were the primary endpoints and results?"
\`\`\`

\`filter\` overwrites the result set in place. If \`--require N\` fails, re-run search with broader terms to get a fresh result ID.

### Lookup

Find by metadata field: \`doi\`, \`author\`, \`title\`, \`pmc\`, \`pmid\`, \`arxiv\`, \`journal\`, \`year\`.

\`\`\`
lookup doi 10.1101/2024.01.15.575613
lookup pmc PMC7194329
lookup author "James Zou" -n 10
\`\`\`

### SQL

\`\`\`
sql "SELECT pub_year, COUNT(*) FROM documents WHERE title ILIKE '%CRISPR%' GROUP BY pub_year ORDER BY pub_year"
\`\`\`

Columns: \`id\`, \`title\`, \`doi\`, \`authors\`, \`source\`, \`abstract_text\`, \`pub_date\`, \`journal_title\`, \`article_type\`, \`pmid\`, \`keywords\`, \`categories\`, \`pub_year\`.

Only \`SELECT\` on the \`documents\` table. 15s timeout, 200-row limit.

**SQL is for metadata + aggregation only, it is NOT full-text search.** It sees only titles/abstracts (\`abstract_text\`), not paper bodies, and \`ILIKE '%term%'\` does a slow unindexed scan. To find papers that *contain* a term, use \`grep "term" /papers/\` (exact, full text, corpus-wide) or \`search "..."\` (semantic), a body-text mention (Methods, Data Availability, references) will be missed by \`abstract_text ILIKE\` but found by \`grep\`. Use SQL for counts, date/journal/author filters, and grouping, not to locate papers by content.

### Proteins SQL (\`-s proteins\`)

\`\`\`
paperclip sql -s proteins "SELECT COUNT(*) FROM uniprot_v.proteins"
paperclip sql -s proteins "SELECT * FROM pdb_v.structures_by_accession WHERE accession='P00533' LIMIT 10"
paperclip grep "TP53" /proteins/
paperclip cat /proteins/P04637/meta.json
\`\`\`

Key views: \`uniprot_v.proteins\`, \`uniprot_v.features\`, \`pdb_v.structures_by_accession\`, \`chembl_v.bioactivities_by_accession\`, \`chembl_v.drugs_by_accession\`. Join key: UniProt accession.

**MUST: Before writing ANY protein SQL (or protein grep/cat/search), you MUST run \`paperclip skill proteins\` and read it.** Do not guess column names, enum values, join keys, or query patterns from memory. Skipping this step produces wrong queries.

### Patents (\`-s patents\`)

\`\`\`
paperclip search -s patents "CDK4 inhibitor"
paperclip cat /patents/US-9585906-B2/meta.json
paperclip cat /patents/US-9585906-B2/content.lines
paperclip cat /patents/US-9585906-B2/surechembl/compounds.tsv
\`\`\`

Doc id = \`publication_number\`. Claims live in \`content_blocks\` (\`section=claims\`), not a separate folder. SureChEMBL compounds join at read time on publication number.

**MUST: Before deep patent work, run \`paperclip skill patents\` and read it.**

### SEC EDGAR filings (\`-s sec\` / \`/sec/\`)

**Catalog for companies; corpus \`grep\` for body topics.** Paths:

\`\`\`
/sec/{ACCESSION}/meta.json
/sec/{ACCESSION}/content.lines          # L numbers are 1-indexed (#L1 is first)
/sec/{ACCESSION}/items/{code}.lines
/sec/{ACCESSION}/exhibits/
/sec/{ACCESSION}/{SEQUENCE}/content.lines
\`\`\`

XBRL facts are not a VFS path, use \`sql -s sec\` on \`xbrl_facts\` (see \`paperclip skill sec\`).

\`\`\`
paperclip search -s sec "Moderna"                   # catalog (prefer over sql ILIKE)
paperclip search -s sec --since 1y "MRNA"
paperclip grep "GLP-1" /sec/                        # corpus body (slab)
paperclip head -40 /sec/{ACCESSION}/content.lines
paperclip grep "myocarditis" /sec/{ACCESSION}/content.lines
paperclip head -40 /sec/{ACCESSION}/{SEQUENCE}/content.lines   # exhibits
\`\`\`

- Catalog: use **\`search -s sec\`** for company/ticker/form/date, do not hand-roll
  \`sql … company_name ILIKE\` for that. Reserve \`sql\` for counts/joins/\`documents\`.
  Never \`search "GLP-1"\` (topics aren't in the catalog).
- Body: \`grep "term" /sec/\` for topics; scoped grep/head on known accessions.
  Never \`sql … content_blocks ILIKE\`.
- **Cite:** printed \`L<n>\` only. Primary → \`https://paperclip.gxl.ai/citations/sec/{ACCESSION}#L<n>\`. If you read
  \`/{SEQUENCE}/\`, **must** cite \`https://paperclip.gxl.ai/citations/sec/{ACCESSION}:{SEQUENCE}#L<n>\` or the viewer
  shows "Line not found". Do not narrate indexing in the answer.

**MUST: Before writing ANY SEC SQL, run \`paperclip skill sec\` and read it.**
Do not invent columns.

## Map & Reduce

\`map\` runs a lightweight LLM reader on each paper. \`reduce\` synthesizes map results.

\`--output-schema\` works with the default map reader.
Pass a Draft 2020-12 JSON Schema for each paper's complete output. Paperclip
requires one strict JSON value and validates it. Invalid output gets one correction
attempt. Paperclip fails that paper if the corrected response is still invalid. Use \`required\`
for mandatory fields, \`additionalProperties: false\` for exact keys, and nullable
types such as \`["number", "null"]\` for unavailable values. Paperclip does not add
\`_citations\` unless the schema defines it. The old \`--output_schema\` spelling and
legacy field maps remain temporary deprecated aliases.

\`\`\`
search -s pmc "protein design" -n 10
map --from s_xxx "What methods were used for protein design?"
reduce --from m_xxx --strategy table "Compare methods and results"
\`\`\`

Reduce strategies: \`summarize\`, \`table\`, \`themes\`, \`consensus\`, \`bullet_points\`, \`extract\`.

**Tips:**
- Be specific. Bad: "Summarize this paper." Good: "What delivery vector was used, what cell type was targeted, and what transfection efficiency was reported?"
- Enumerate every field you want extracted.
- Specify which section to focus on (e.g. "From the Methods section, extract...").
- Keep to **3-10 papers** (\`-n 5\` or \`-n 10\`).
- After map, respond directly - don't follow up by reading individual papers.

## Paper Repositories

**Opt-in only.** Repos are not part of the default workflow, do not create or use them unless the user explicitly asks to build a repo, track a collection, or verify claims. By default, cite directly from the text. The rest of this section applies only once the user has asked for a repo.

### How \`add\` works

- \`repo add <id> "claim"\` - appends a verifiable claim to the paper. Optional: \`--lines L45-L52\` (faster verification).
- \`repo add <id> --json '{"type":"custom",...}' --lines L45-L52\` stores a
  caller-defined structured claim without making the repo domain-specific.
- **Each \`repo add\` with a claim creates a new entry.** A paper can have multiple claims - call \`repo add\` multiple times with the same ID and different claims.
- To replace a wrong claim: \`repo remove <id>\`, then \`repo add <id> "corrected claim"\`.
- \`repo add <id>\` - collection only, never verified.

### How \`commit\` works

- \`repo commit -m "message"\` runs verification on all unchecked claims in
  parallel, then creates the metadata snapshot. Unresolved verifier errors block
  the snapshot so the same command can safely retry them.
- Verification produces [OK] (supported) or [X] (not supported) per claim.
- For a generic repo, [X] is a conclusive advisory verdict and does not block
  the metadata snapshot. Fix it by re-adding a corrected claim, then commit
  again. For a data-curation or meta-analysis workflow, the specialized Phase-6
  compiler requires zero active [X] claims; correct or remove/log every [X]
  before compilation.
- Previously verified claims are not re-checked. Use \`--no-verify\` to skip verification entirely.

### How \`checkout\` works

- \`repo checkout <name>\` - tries to switch **branch** first (within current repo), then falls back to switching **repo**.
- \`repo checkout -\` - deactivates the repo entirely.
- **If the active repo is unrelated to the current request, start a new one (\`repo init <topic>\`) or deactivate it (\`repo checkout -\`) before adding papers - never append unrelated papers to an existing repo.**

**When you are using a repo (the user asked for one), run \`repo status\` before writing your final response** to confirm which claims are verified. Only cite [OK] papers. For [X] claims: revise the claim, find a different source, or drop it. (If you're not using a repo, skip this.)

### Full workflow example

\`\`\`
# 1. Create repo
paperclip repo init my-review

# 2. Search and read (-s is required)
paperclip search -s pmc "topic A" -n 10
paperclip map --from s_xxx "What was the main finding and sample size?"

# 3. Add papers with the claims you'll cite
paperclip repo add PMC123 "Key finding X" --lines L45-L52
paperclip repo add bio_456 "Key finding Y"

# 4. Commit - verifies each claim against full text
paperclip repo commit -m "Initial citations"

# 5. Check results - fix any [X] claims
paperclip repo status
#   [OK] PMC123  claim: Key finding X
#   [X] bio_456 claim: Key finding Y - paper says Z instead

# 6. Fix: remove bad claim, re-add corrected, re-commit
paperclip repo remove bio_456
paperclip repo add bio_456 "Key finding Z" --lines L80
paperclip repo commit -m "Fix bio_456 claim"

# 7. Final check - all [OK], write response
paperclip repo status
\`\`\`

### Branches

Repos start on \`main\`. Use branches to explore parallel lines of evidence:

\`\`\`
paperclip repo branch safety-concerns
paperclip repo add PMC789 "Drug X causes hepatotoxicity in 12%" --lines L200-L210
paperclip repo commit -m "safety claims"

paperclip repo checkout main
# main branch is unaffected; merge when ready:
paperclip repo merge safety-concerns
\`\`\`

## Sandbox Environment

Commands run in a sandboxed virtual shell (vsh).

**Allowed**: \`cd\`, \`ls\`, \`cat\`, \`head\`, \`tail\`, \`grep\`, \`sed\`, \`awk\`, \`sort\`, \`cut\`, \`tr\`, \`jq\`, \`search\`, \`scan\`, and more.
**Blocked**: \`rm\`, \`curl\`, \`wget\`, \`ssh\`, \`sudo\`, etc.
**Not supported**: Shell loops (\`for\`/\`while\`) and \`xargs\` - use pipes or multiple tool calls.

### Files and scratch

- \`/.gxl/\` is writable scratch: \`grep "IC50" /papers/<id>/content.lines > /.gxl/hits.txt\`
- Save any file locally with \`cat > filename\`: \`cat /papers/PMC123/figures/fig1.jpg > fig1.jpg\`
- Supplementary data: \`ls /papers/<id>/supplements/\` then \`head\`/\`awk\`/\`cat >\`.

## Tips

- Prefer \`head -N\`, section files, or \`grep\`/\`scan\` - avoid \`cat\` on full \`content.lines\`.
- Use \`bash '...'\` for pipes or redirection to \`/.gxl/\`.
- \`map\` runs an LLM reader per paper - limit with \`-n 5\` on search.
- Always check \`repo status\` before writing your final response.
- Only cite papers marked [OK].
`;



// Mirrors templates/loop/goal-loop/files/ verbatim — the cloud template is the
// source of truth and tests/local/desktop-onboarding.test.ts fails on drift.
// The loop itself (spawn_chat respawn, locked AGENTS.md/goal.md, the addendum)
// only exists in the cloud; scaffolding locally just stages the files, which is
// why the card copy says to run it there.
const GOAL_LOOP_AGENTS_MD = `# Loop protocol

<!-- Locked so no agent can rewrite its own rules. Locks only stop agents: you can edit this file directly, or unlock it from the file tree if you want agent help writing it. -->

This workspace runs a never-ending loop toward the goal in \`goal.md\`. Every turn is a fresh chat with no memory of the last one, so the files below are the only state that survives. Read them first, every time.

\`AGENTS.md\` and \`goal.md\` are locked: you cannot edit them. Only a human can change the goal or these rules.

## The turn

1. Read \`goal.md\`, then \`tasks.md\`, then \`attempts.md\` **with \`limit: 60\`**. That is your entire memory. \`attempts.md\` is newest-first, so the first 60 lines are the recent history; never read the whole file, it grows with every turn.
2. If \`goal.md\`'s done condition is **already met**, write a final \`attempts.md\` entry explaining why, cancel this chat's schedules, and stop. Do not take a task and do not spawn. Confirming done is a whole turn's job.
3. If your instructions say a heartbeat already exists, skip this step. Otherwise, if \`attempts.md\` has no \`##\` entries yet (the seeded file has none), you are the first turn: arm the workspace heartbeat with \`schedule_create\`: kind \`every\`, every 10 minutes (use a longer interval only if turns take longer than that), prompt: "Heartbeat. Read AGENTS.md. If goal.md's done condition is met, cancel this chat's schedules and stop. Otherwise call list_chats and judge liveness from OTHER CHATS ONLY: ignore this chat entirely, it is marked '(this chat)' and it is you running right now. The chain is alive if any OTHER chat is marked 'agent running' (whatever its timestamp - a turn can work for a long time without writing) OR shows activity within the last 10 minutes; then do nothing this firing and reply 'chain alive'. Only when no other chat is running and none has moved for 10 minutes is the chain dead: then spawn_chat a successor with the prompt 'Read AGENTS.md and run one loop turn. A heartbeat already exists - do not arm another.' (pass the model goal.md names, if any) - do not do loop work in this chat; it stays cheap." Later turns skip this step; the heartbeat already exists and restarts the chain if any turn dies.
4. Pick exactly **one** task from \`tasks.md\`. Prefer the topmost unblocked one. If \`attempts.md\` or the files show it is already done, check it off and take the next one instead of redoing it. If a task has failed the same way twice in \`attempts.md\`, skip it and mark it blocked. If nothing is unblocked, add the follow-up tasks \`goal.md\` implies; if you truly cannot name one, write a final \`attempts.md\` entry saying the queue is empty and stop. Do not spawn.
5. Do the task. Verify the result against the ground truth named in \`goal.md\`. An unverified change is a failed task.
6. Add one entry to \`attempts.md\` **at the top**, directly under the \`# Attempts\` heading and above the previous entry. An entry is a \`## <date> - <task>\` heading followed by three short lines: **Tried:** what you did, **Verified:** what the ground-truth check reported, **Next:** what the following agent should know. At most a few lines; do not restate data the files already hold. Write the entry even when the task failed, especially then.
7. Update \`tasks.md\`: check off what landed, add any follow-up work the attempt revealed, mark anything blocked with the reason.
8. Hand off, last: \`spawn_chat\` with a self-contained prompt. The successor sees none of this conversation, so the prompt must be the instruction alone, e.g. "Read AGENTS.md and run one loop turn." If \`goal.md\` names a model for the loop and this chat is not on it, pass it as \`model\` (successors inherit, so this matters only when starting or reviving the chain). If \`spawn_chat\` returns an error, retry it once. If it still fails, stop; the heartbeat restarts the chain. Nothing else runs after this step.

## Rules

- **One task per turn, even when the goal is one task from done.** Two tasks in one turn means the second one gets no fresh context and no review. After your one task, hand off; a turn that starts with the goal met is the one that declares done.
- **State lives in files, never in chat.** If a fact matters to the next turn, it goes in \`tasks.md\` or \`attempts.md\` before you hand off.
- **Never claim a result you did not verify.** "It should work" belongs in \`attempts.md\` as a failure.
- **Never redo logged work.** If the newest \`attempts.md\` entry already covers the top task and the files agree, that work is done. Take the next task.
- **Keep the log lean.** Long entries make every later turn slower, dearer, and likelier to fail mid-write. A few lines is plenty.
- **One heartbeat per workspace, ever.** Two heartbeats can each mistake the other for a live chain and both stand down, leaving a dead loop unrevived. Only a genuine first turn arms one, and a turn the heartbeat started never does.
- **Never run two branches at once.** If you were started by the heartbeat and another chat is running or has been active in the last 10 minutes, the chain is alive: stop immediately rather than starting a second branch. Two branches racing on the same files is worse than a paused loop. When judging that, never count your own chat as evidence of a live chain.
- **Spawn exactly once, at the very end.** The tools are named exactly \`spawn_chat\`, \`schedule_create\`, \`schedule_list\`, \`schedule_cancel\`, \`list_chats\`, lowercase, as written.

If the chain ever stalls, a human can restart it by sending "Read AGENTS.md and run one loop turn." in any chat here.
`;

const GOAL_LOOP_GOAL_MD = `# Goal

<!-- Locked so no agent can rewrite its own objective. Locks only stop agents: you can edit this file directly, or unlock it from the file tree if you want agent help writing it. -->

## What we are trying to achieve

One paragraph, written for someone with no context. Replace this.

## Ground truth

The check that decides whether a task actually worked. A command whose exit code is the verdict, a test suite, a number that has to move. Name it precisely. Agents will treat anything else as an unverified guess.

## Done means

The condition that ends the loop. When this is true, the agent writes a final entry in \`attempts.md\` and stops spawning successors.

## Out of bounds

Anything the loop must not touch or claim. Cost ceilings, files to leave alone, things only a human decides.
`;

const GOAL_LOOP_TASKS_MD = `# Tasks

The work queue. Agents take the topmost unblocked task, one per turn, and keep this file current. Humans can reorder or add anything at any time.

## Ready

- [ ] Fill in \`goal.md\`, then replace this task with the first real one.

## Blocked

Move a task here with the reason it is stuck and who or what would unblock it.

## Done

Completed tasks, newest last.
`;

const GOAL_LOOP_ATTEMPTS_MD = `# Attempts

Log of every loop turn, newest first: new entries go directly under this heading, above the older ones. Each turn reads only the top of the file rather than the whole history, so turn 100 costs what turn 1 does.

No entries yet. \`AGENTS.md\` defines what an entry looks like.
`;

export const STARTER_PACKS: readonly StarterPack[] = [
  {
    id: 'writing',
    openPath: 'drafts/draft.md',
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
    openPath: 'notes/inbox.md',
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
    openPath: 'log.md',
    title: 'Knowledge base',
    tagline: 'Trusted articles from your sources.',
    namePlaceholder: 'Team Wiki',
    folders: ['articles', 'sources'],
    files: [{ path: 'log.md', content: KB_LOG_MD }],
  },
  {
    id: 'book',
    openPath: 'outline.md',
    title: 'Book',
    tagline: 'One chapter at a time.',
    namePlaceholder: 'My Book',
    folders: [],
    files: [
      { path: 'outline.md', content: OUTLINE_MD },
      { path: 'chapters/chapter-01.md', content: CHAPTER_MD },
    ],
  },
  {
    id: 'goal-loop',
    openPath: 'goal.md',
    title: 'Goal loop',
    tagline: 'Agents work one goal continuously. Runs in the cloud.',
    namePlaceholder: 'My Goal',
    folders: [],
    files: [
      { path: 'AGENTS.md', content: GOAL_LOOP_AGENTS_MD },
      { path: 'goal.md', content: GOAL_LOOP_GOAL_MD },
      { path: 'tasks.md', content: GOAL_LOOP_TASKS_MD },
      { path: 'attempts.md', content: GOAL_LOOP_ATTEMPTS_MD },
    ],
  },
  {
    id: 'research-paper',
    flavor: 'scientific',
    openPath: 'main.tex',
    title: 'Research paper',
    tagline: 'LaTeX with live preview and citations.',
    namePlaceholder: 'My Paper',
    folders: ['figures'],
    files: [
      { path: 'main.tex', content: RESEARCH_TEX },
      { path: 'refs.bib', content: REFS_BIB },
      { path: 'notes/literature.md', content: LITERATURE_MD },
      { path: 'skills/paperclip/SKILL.md', content: PAPERCLIP_SKILL_MD },
    ],
  },
  {
    id: 'lit-review',
    flavor: 'scientific',
    openPath: 'reading-list.md',
    title: 'Literature review',
    tagline: 'Papers in, synthesis out.',
    namePlaceholder: 'Lit Review',
    folders: ['papers', 'notes'],
    files: [
      { path: 'reading-list.md', content: READING_LIST_MD },
      { path: 'synthesis.md', content: SYNTHESIS_MD },
      { path: 'skills/paperclip/SKILL.md', content: PAPERCLIP_SKILL_MD },
    ],
  },
];

/** The packs to list for a flavor; see `StarterPack.flavor`. */
export function starterPacksForFlavor(flavor: 'scientific' | 'general'): readonly StarterPack[] {
  return flavor === 'scientific' ? STARTER_PACKS : STARTER_PACKS.filter((pack) => !pack.flavor);
}

export function starterPackById(id: string): StarterPack | null {
  return STARTER_PACKS.find((pack) => pack.id === id) ?? null;
}
