import { Node } from '@tiptap/core';

/**
 * YAML frontmatter as one raw plain-text block (fences included). The codec
 * round-trips its text byte-for-byte — the YAML is never parsed, only held.
 * `code: true` gives literal text input + preserved whitespace, exactly like a
 * code block; the dimmed monospace look lives in globals.css under
 * `pre[data-frontmatter]`. A properties UI is a later project.
 *
 * A frontmatter node is only valid at the START of a document; the
 * `FrontmatterNormalize` extension (separate module, so this one stays free of
 * the codec import cycle) rewrites any interior node into ordinary markdown.
 */
export const Frontmatter = Node.create({
  name: 'frontmatter',
  group: 'block',
  content: 'text*',
  marks: '',
  code: true,
  defining: true,

  parseHTML() {
    // Priority above the default (50): StarterKit's generic `pre` → codeBlock
    // rule matches the same element, and at equal priority the earlier-
    // registered extension wins — a pasted frontmatter block would become a
    // code fence and re-serialize as ```yaml instead of the original YAML.
    return [{ tag: 'pre[data-frontmatter]', preserveWhitespace: 'full', priority: 100 }];
  },

  renderHTML() {
    return ['pre', { 'data-frontmatter': 'true' }, ['code', 0]];
  },
});
