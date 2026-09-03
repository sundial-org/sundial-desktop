/**
 * The starter document every brand-new workspace gets, cloud and local alike.
 * Single source of truth: `lib/workspace/bootstrap.ts` seeds it into a new
 * cloud workspace and `local-server/scaffold.mjs` writes it into a new blank
 * local project folder, so the two can never drift.
 *
 * welcome.md ships verbatim. The doc itself walks the user through making
 * their own first AI edit on the fox-typo blockquote, so no agent-did-this
 * card is pre-seeded — the chat starts empty.
 *
 * Comments first: the doc never mentions chat. The instructed gesture is a
 * comment on the selection that tags the agent, because that is the ONE path
 * a plain new workspace can honour on both stacks — the mention mints the
 * thread's chat and starts the run (cloud: hasAgentMention in
 * lib/workspace/comment-trigger; local: SUNNY_MENTION_RE in
 * local-server/server.mjs). An untagged comment only reaches an agent when
 * some chat already watches the file, which a brand-new local project has no
 * chat to do — so WELCOME_COMMENT_PROMPT keeps the tag, and the tests below
 * assert both stacks' summon checks still match it.
 *
 * IMPORTANT — codec stability: keep this content in the same divergence
 * class as a plain paragraph doc — at most a 1-char trailing-`\n` diff
 * between `markdownToYDoc` (bootstrap snapshot path, via jsdom) and
 * `replaceFromMarkdown` (hocuspocus catch-up path, direct parser). In
 * particular, NEVER put multiple spaces in inline text (e.g. `✍️  [foo]`):
 * jsdom collapses the run to one space while the markdown parser preserves
 * it, producing a structural Y.Doc divergence that trips hocuspocus'
 * `onLoadDocument` catch-up branch with `Unexpected content type in insert
 * operation` and renders the editor empty.
 */
/** The comment the doc asks for, verbatim. The `@Agent` tag is what summons
 *  the agent, so it is a constant both stacks' tests assert against. */
export const WELCOME_COMMENT_PROMPT = '@Agent fix the grammar';

export const WELCOME_MD = `# Welcome to Sundial ☀️

Drag or copy-paste your own doc, .tex, .docx, .md, .py to try Sundial on real work.

## Try this example

> the quick brwn fox jumps over lazy dog

1. Highlight the sentence above and press \`Cmd+Alt+M\` to comment on it.
2. Write "${WELCOME_COMMENT_PROMPT}" and post the comment.
3. The Agent answers on your thread, and its fix lands as a suggestion you accept or reject. Congrats, you've made your first edit with AI :) Add people to this project so they can comment too.

---

Built with 🌟 by a small team that writes with agents every day.
`;

export const WELCOME_PATH = 'welcome.md';

/**
 * The cloud onboarding doc: a LaTeX file, because compiling a real PDF live is
 * the capability worth showing off in the first minute. Seeded into new cloud
 * workspaces (blank, template, invite arrival) by lib/workspace/bootstrap.ts +
 * the routes that call it. New users land here with chat still open and one
 * deliberate compile error for Sunny to repair. Local/desktop scaffolds keep
 * WELCOME_MD above.
 *
 * Invariants the landing flow and tests depend on:
 * - WELCOME_TEX_ERROR_TARGET appears EXACTLY ONCE in WELCOME_TEX. It names a
 *   missing input after `\\begin{document}`: fatal (no PDF even under
 *   `latexmk -f`) and, unlike an EOF/runaway-argument error, reliably reported
 *   against the exact source line so Monaco can mark it.
 * - No emoji (tectonic's default fonts render tofu) and no em dashes.
 */
export const WELCOME_TEX_ERROR_TARGET = '\\input{sundial-intentional-error.tex}';

export const WELCOME_TEX = `\\documentclass{article}
\\usepackage[margin=1.2in]{geometry}
\\setlength{\\parskip}{0.5em}

\\title{Welcome to Sundial}
\\author{}
\\date{}

\\begin{document}
\\maketitle

${WELCOME_TEX_ERROR_TARGET}

Sundial is a collaborative editor where AI edits arrive as signed, reviewable
suggestions. This starter has one deliberate LaTeX compile error.

\\section*{Ask Sunny to fix this file}

Open the chat beside this document and ask Sunny to fix the compile error.
When the edit lands, the PDF preview will compile live.

\\begin{quote}
This document references one intentionally missing input file.
\\end{quote}

Then drag in your own .tex, .md, .docx, or .py to try Sundial on real work,
and add people to this workspace so they can comment too.

\\vspace{1em}
\\noindent Built by a small team that writes with agents every day.

\\end{document}
`;

export const WELCOME_TEX_ERROR_LINE =
  WELCOME_TEX.slice(0, WELCOME_TEX.indexOf(WELCOME_TEX_ERROR_TARGET)).split('\n').length;

// NESTED on purpose: a root-level \documentclass file would become a second
// root candidate and flip real projects (main.tex + sections/) to
// `ambiguous`, disabling compile while editing fragments. Inside its own
// folder, the nearest-root rule only ever picks it for files it contains.
export const WELCOME_TEX_PATH = 'onboarding/welcome.tex';

/** Mime for the seeded tex file; readers key off the extension anyway
 *  (lib/sync/policy isLatexDocumentFile), this just matches the starter-pack
 *  convention in app/api/workspace/route.ts. */
export const WELCOME_TEX_MIME = 'text/x-tex';

/** Paint this known diagnostic immediately while the real compile verifies it
 * in the background. The starter is immutable at creation time, so waiting on
 * the compile service before showing the error only adds latency. */
export const WELCOME_TEX_INITIAL_COMPILE_ERROR = {
  message: 'LaTeX compilation failed',
  details: `onboarding/welcome.tex:${WELCOME_TEX_ERROR_LINE}: File \`sundial-intentional-error.tex' not found.`,
} as const;

export function hasWelcomeTexInitialCompileMarker(
  markers: ReadonlyArray<{ line: number; severity: string; message: string }>,
): boolean {
  return markers.some(
    (marker) =>
      marker.line === WELCOME_TEX_ERROR_LINE &&
      marker.severity === 'error' &&
      marker.message.includes('sundial-intentional-error.tex'),
  );
}
