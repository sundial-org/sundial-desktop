import type { Editor, Range } from '@tiptap/core';
import type { EditorState } from '@tiptap/pm/state';
import { MATH_TEXT_REGEX } from '@/lib/tiptap/math-decorations';

/* ── Slash-command items ──────────────────────────────────────────────
 *  Plain data consumed by the editor's "/" insert menu (EditorSlashMenu).
 *  Every item maps to a command the top menu bar already exposes, so the
 *  menu adds zero new node types or serialization paths — it's purely a
 *  faster way to reach existing inserts. Kept DOM-free so unit tests can
 *  exercise the commands against a headless editor.
 * ─────────────────────────────────────────────────────────────────── */

export type SlashItemAvailability = {
  hasImageUpload: boolean;
  hasAskSunny?: boolean;
  hasGenerateImage?: boolean;
};

export type SlashItemContext = {
  editor: Editor;
  range: Range;
  /** Opens the OS file picker and uploads at the caret (wired by the editor).
   *  Absent when the surface has no image uploader — the item is hidden. */
  pickImage?: () => void;
  /** Routes an inline agent request (wired by the editor). `text` is the
   *  surrounding paragraph as anchor context; an empty `instruction` means
   *  "open the ask popup" instead of sending directly. */
  askSunny?: (detail: { text: string; instruction: string; caret?: CaretAnchor['caret'] }) => void;
  /** Opens the AI image-generation popup at the caret (wired by the
   *  editor). An empty `prompt` derives one from the doc context. */
  generateImage?: (detail: { prompt: string }) => void;
};

export type SlashItem = {
  title: string;
  description: string;
  /** Matched by the filter besides the title (lowercase). */
  keywords: string[];
  /** Icon key rendered by the menu component. */
  icon: string;
  /** Free-text item: also matched when the query STARTS with a keyword
   *  ("ai fix the typos"), and the remainder becomes its argument. */
  freeText?: boolean;
  /** Hidden when false — e.g. Image without an upload handler. */
  isAvailable?: (ctx: SlashItemAvailability) => boolean;
  run: (ctx: SlashItemContext) => void;
};

/** Table commands come from @tiptap/extension-table, which augments the
 *  command set at runtime; one shared cast instead of one copy per surface.
 *  Used by the slash menu and the top menu bar. */
export function insertDefaultTable(editor: Editor) {
  const commands = editor.commands as unknown as {
    insertTable?: (opts: { rows: number; cols: number; withHeaderRow: boolean }) => boolean;
  };
  commands.insertTable?.({ rows: 3, cols: 2, withHeaderRow: true });
}

/** Pure trigger words stripped from the "/ai …" instruction. */
const ASK_TRIGGERS = ['ai', 'ask', 'sunny', 'agent'];
/** Everything the Ask Sunny item matches on ("write" matches but is kept in
 *  the instruction — it's a verb, not a trigger). */
const ASK_KEYWORDS = [...ASK_TRIGGERS, 'write'];

export type CaretAnchor = {
  /** Anchor text quoted to Sunny so it can find the SPOT, not just the doc. */
  text: string;
  /** Where the caret sits relative to the anchor text. */
  caret: 'inside' | 'after' | 'start';
};

/** Locate the caret for an in-place ask: the caret's own block when it has
 *  text, else the nearest non-empty top-level block above ("/ai" is usually
 *  typed on a fresh empty line — without this Sunny only learns WHICH doc,
 *  not WHERE, and writes in the wrong place). Clipped to the 500 chars
 *  nearest the caret so a huge block doesn't bloat the turn. */
export function caretAnchor(editor: Editor): CaretAnchor {
  const { $from } = editor.state.selection;
  const own = $from.parent.textContent;
  if (own.trim()) {
    // Window AROUND the caret — clipping from the block start could hand
    // Sunny anchor text that doesn't even include the cursor's spot in a
    // long paragraph (Codex P2 on #790).
    const start = Math.min(Math.max(0, $from.parentOffset - 250), Math.max(0, own.length - 500));
    return { text: own.slice(start, start + 500).trim(), caret: 'inside' };
  }
  // Nearest non-empty textblock ABOVE the caret, at any depth — a top-level
  // children walk would skip the previous item of the same nested list and
  // anchor on the wrong block (Codex P2 on #790).
  const before = $from.before($from.depth);
  let anchor = '';
  editor.state.doc.nodesBetween(0, before, (node, pos) => {
    if (node.isTextblock && pos + node.nodeSize <= before) {
      const text = node.textContent.trim();
      if (text) anchor = text;
    }
    return true;
  });
  if (anchor) return { text: anchor.slice(-500), caret: 'after' };
  return { text: '', caret: 'start' };
}

export const SLASH_ITEMS: SlashItem[] = [
  {
    title: 'Text',
    description: 'Plain paragraph',
    keywords: ['paragraph', 'plain', 'normal'],
    icon: 'text',
    run: ({ editor, range }) => editor.chain().focus().deleteRange(range).clearNodes().run(),
  },
  {
    title: 'Heading 1',
    description: 'Large section heading',
    keywords: ['h1', 'title', 'big'],
    icon: 'h1',
    run: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).clearNodes().setNode('heading', { level: 1 }).run(),
  },
  {
    title: 'Heading 2',
    description: 'Medium section heading',
    keywords: ['h2', 'subtitle'],
    icon: 'h2',
    run: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).clearNodes().setNode('heading', { level: 2 }).run(),
  },
  {
    title: 'Heading 3',
    description: 'Small section heading',
    keywords: ['h3', 'subheading'],
    icon: 'h3',
    run: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).clearNodes().setNode('heading', { level: 3 }).run(),
  },
  {
    title: 'Bullet list',
    description: 'Simple unordered list',
    keywords: ['ul', 'unordered', 'point'],
    icon: 'bullet-list',
    run: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).clearNodes().toggleBulletList().run(),
  },
  {
    title: 'Numbered list',
    description: 'Ordered list with numbers',
    keywords: ['ol', 'ordered', 'numbers'],
    icon: 'numbered-list',
    run: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).clearNodes().toggleOrderedList().run(),
  },
  {
    title: 'Task list',
    description: 'Checklist with checkboxes',
    keywords: ['todo', 'checkbox', 'check', 'task'],
    icon: 'task',
    // Decoration-based checkboxes (MarkdownCheckbox): a bullet item whose text
    // starts with `[ ] `. Mirrors the toolbar's guarded checklist: wrap in a
    // bullet list only when not already in one (an unconditional toggle would
    // turn an existing list OFF), and put the marker at the BLOCK START — the
    // checkbox decoration regex is ^-anchored — without doubling one that's
    // already there (a mid-line "/task" trigger leaves text before the caret).
    run: ({ editor, range }) => {
      const chain = editor.chain().focus().deleteRange(range);
      (editor.isActive('bulletList') ? chain : chain.clearNodes().toggleBulletList())
        .command(({ tr }) => {
          const { $from } = tr.selection;
          if (!/^\[[ xX]\]/.test($from.parent.textContent)) {
            tr.insertText('[ ] ', $from.start());
          }
          return true;
        })
        .run();
    },
  },
  {
    title: 'Quote',
    description: 'Block quotation',
    keywords: ['blockquote', 'citation'],
    icon: 'quote',
    run: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).clearNodes().toggleBlockquote().run(),
  },
  {
    title: 'Callout',
    description: 'Highlighted note block',
    keywords: ['note', 'info', 'admonition', 'aside'],
    icon: 'callout',
    // A blockquote with a callout type — serializes to `> [!note]` (Obsidian
    // syntax the codec already round-trips).
    run: ({ editor, range }) =>
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .clearNodes()
        .toggleBlockquote()
        .updateAttributes('blockquote', { calloutType: 'note' })
        .run(),
  },
  {
    title: 'Code block',
    description: 'Fenced code with syntax',
    keywords: ['fence', 'snippet', 'pre'],
    icon: 'code',
    run: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).clearNodes().toggleCodeBlock().run(),
  },
  {
    title: 'Math block',
    description: 'Display equation ($$…$$)',
    keywords: ['equation', 'latex', 'katex', 'formula'],
    icon: 'math',
    // Math is plain `$$…$$` text (decoration-rendered) — seed the fences and
    // park the caret between them.
    run: ({ editor, range }) =>
      editor
        .chain()
        .focus()
        .deleteRange(range)
        .insertContent('$$$$')
        .setTextSelection(range.from + 2)
        .run(),
  },
  {
    title: 'Table',
    description: '3×2 table with header row',
    keywords: ['grid', 'rows', 'columns'],
    icon: 'table',
    run: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).run();
      insertDefaultTable(editor);
    },
  },
  // Before the upload item: both match "/image" and ties keep curated order,
  // so the documented bare-"/image" flow must hit generation first.
  {
    title: 'Generate image',
    description: 'AI image at the caret: /image <description>',
    keywords: ['image', 'img', 'generate', 'gen', 'picture', 'illustration'],
    icon: 'image-gen',
    freeText: true,
    isAvailable: ({ hasGenerateImage }) => !!hasGenerateImage,
    // "/image a red fox in the fog[Enter]" — the description is everything
    // after the matched trigger word; a bare "/image" opens the popup with
    // an empty prompt (the route derives one from the doc context).
    run: ({ editor, range, generateImage }) => {
      const raw = editor.state.doc.textBetween(range.from, range.to).slice(1).trim();
      const lower = raw.toLowerCase();
      const trigger = ['image', 'img', 'generate', 'gen'].find(
        (t) => lower === t || lower.startsWith(`${t} `),
      );
      const prompt = trigger ? raw.slice(trigger.length).trim() : raw;
      editor.chain().focus().deleteRange(range).run();
      generateImage?.({ prompt });
    },
  },
  {
    title: 'Image',
    description: 'Upload from your computer',
    keywords: ['photo', 'picture', 'upload', 'figure'],
    icon: 'image',
    isAvailable: ({ hasImageUpload }) => hasImageUpload,
    run: ({ editor, range, pickImage }) => {
      editor.chain().focus().deleteRange(range).run();
      pickImage?.();
    },
  },
  {
    title: 'Ask agent',
    description: 'AI edit in place: /ai <what to do>',
    keywords: ASK_KEYWORDS,
    icon: 'sparkle',
    freeText: true,
    isAvailable: ({ hasAskSunny }) => !!hasAskSunny,
    // "/ai expand on this[Enter]" — the instruction is the query after the
    // matched trigger word; the surrounding paragraph (minus the trigger)
    // rides along as anchor context so Sunny knows WHERE to edit. "write" is
    // matchable but NOT stripped — it's the verb of the instruction ("/write
    // a haiku" → "write a haiku"). Anything with no instruction left (bare
    // "/ai", a partial like "/ag", "/ask sunny") opens the ask popup instead
    // of sending a fragment as a turn.
    run: ({ editor, range, askSunny }) => {
      const raw = editor.state.doc.textBetween(range.from, range.to).slice(1).trim();
      const lower = raw.toLowerCase();
      const trigger = ASK_TRIGGERS.find((t) => lower === t || lower.startsWith(`${t} `));
      let instruction = trigger ? raw.slice(trigger.length).trim() : raw;
      if (
        ASK_KEYWORDS.includes(instruction.toLowerCase()) ||
        (!trigger && !instruction.includes(' '))
      ) {
        instruction = '';
      }
      editor.chain().focus().deleteRange(range).run();
      askSunny?.({ ...caretAnchor(editor), instruction });
    },
  },
  {
    title: 'Divider',
    description: 'Horizontal rule',
    keywords: ['hr', 'rule', 'separator', 'line'],
    icon: 'divider',
    run: ({ editor, range }) =>
      editor.chain().focus().deleteRange(range).setHorizontalRule().run(),
  },
];

/** Contexts where the slash menu must NOT open:
 *  - code (fenced blocks or `inline code`) — a "/" is ordinary text there;
 *  - table cells — nearly every item is block-structural, and the markdown
 *    codec can't round-trip block nodes in cells (a heading degrades to
 *    literal "# text", a nested table to escaped pipes);
 *  - `$…$`/`$$…$$` math (plain text, decoration-rendered) — Enter would
 *    deleteRange equation source;
 *  - an open wiki-link trigger (`[[ /tab`) — the wiki menu owns the keys and
 *    two stacked menus would render. */
export function allowSlashMenu(state: EditorState, from: number): boolean {
  const $from = state.doc.resolve(from);
  if ($from.parent.type.name === 'codeBlock') return false;
  const codeMark = state.schema.marks.code;
  if (codeMark && $from.marks().some((mark) => mark.type === codeMark)) return false;
  for (let depth = $from.depth; depth > 0; depth--) {
    const name = $from.node(depth).type.name;
    if (name === 'tableCell' || name === 'tableHeader') return false;
  }
  const text = $from.parent.textContent;
  const offset = from - $from.start();
  // Fresh matchAll iterator — the shared regex is /g, and a bare .exec would
  // carry lastIndex across calls.
  for (const match of text.matchAll(MATH_TEXT_REGEX)) {
    const index = match.index ?? 0;
    if (offset > index && offset < index + match[0].length) return false;
  }
  const beforeTrigger = text.slice(0, offset);
  // Unclosed math draft: typing `$a /` or `$$a /` left-to-right before the
  // closing delimiter exists yields no MATH_TEXT_REGEX match (it needs a
  // close), so the loop above misses it. Strip the closed spans, then an
  // opener-shaped `$` left over means the cursor sits in an open equation —
  // where choosing an item would deleteRange the source. (A lone `$5` currency
  // amount matches the same opener shape and is over-suppressed; that's the
  // math regex's own ambiguity, and a dismissable menu beats a wrecked one.)
  if (/(?<!\\)\$(?!\s)/.test(beforeTrigger.replace(MATH_TEXT_REGEX, ''))) return false;
  const wikiIdx = beforeTrigger.lastIndexOf('[[');
  if (wikiIdx !== -1 && !beforeTrigger.slice(wikiIdx + 2).includes(']]')) return false;
  return true;
}

export function filterSlashItems(
  items: SlashItem[],
  query: string,
  ctx: SlashItemAvailability,
): SlashItem[] {
  const q = query.trim().toLowerCase();
  const matched = items.filter((item) => {
    if (item.isAvailable && !item.isAvailable(ctx)) return false;
    // Any whitespace in the query means the user typed past one token — only
    // free-text items may stay matched ("/ai fix the typos"). Ordinary items
    // must drop out so Enter returns to the editor: with allowSpaces on the
    // suggestion plugin, "/ ", "/table foo" or a trailing space would
    // otherwise leave a stale match that Enter fires (Codex P2 on #790) —
    // this restores the old exit-on-space semantics for everything else.
    if (/\s/.test(query)) {
      return !!item.freeText && item.keywords.some((k) => q === k || q.startsWith(`${k} `));
    }
    if (!q) return true;
    return item.title.toLowerCase().includes(q) || item.keywords.some((k) => k.includes(q));
  });
  if (!q) return matched;
  // Prefix matches outrank substring matches: "/ai" must put Ask Sunny
  // (keyword "ai") above Text (keyword "pl-ai-n"). Array.sort is stable, so
  // ties keep the curated SLASH_ITEMS order.
  const rank = (item: SlashItem) =>
    item.title.toLowerCase().startsWith(q) || item.keywords.some((k) => k.startsWith(q)) ? 0 : 1;
  return matched.sort((a, b) => rank(a) - rank(b));
}
