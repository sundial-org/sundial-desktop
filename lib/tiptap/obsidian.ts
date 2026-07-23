import Blockquote from '@tiptap/extension-blockquote';
import Link from '@tiptap/extension-link';

function parseBooleanAttribute(value: string | null) {
  return value === 'true' || value === '1';
}

export const ObsidianBlockquote = Blockquote.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      calloutType: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-callout'),
        renderHTML: (attributes) =>
          attributes.calloutType ? { 'data-callout': attributes.calloutType } : {},
      },
      calloutFoldable: {
        default: false,
        parseHTML: (element) => parseBooleanAttribute(element.getAttribute('data-callout-foldable')),
        renderHTML: (attributes) =>
          attributes.calloutFoldable ? { 'data-callout-foldable': 'true' } : {},
      },
      calloutCollapsed: {
        default: false,
        parseHTML: (element) => parseBooleanAttribute(element.getAttribute('data-callout-collapsed')),
        renderHTML: (attributes) =>
          attributes.calloutCollapsed ? { 'data-callout-collapsed': 'true' } : {},
      },
      calloutTitleExplicit: {
        default: false,
        parseHTML: (element) => parseBooleanAttribute(element.getAttribute('data-callout-title-explicit')),
        renderHTML: (attributes) =>
          attributes.calloutTitleExplicit ? { 'data-callout-title-explicit': 'true' } : {},
      },
    };
  },
});

export const ObsidianLink = Link.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      obsidianType: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-obsidian-link-type'),
        renderHTML: (attributes) =>
          attributes.obsidianType ? { 'data-obsidian-link-type': attributes.obsidianType } : {},
      },
      obsidianTarget: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-obsidian-target'),
        renderHTML: (attributes) =>
          attributes.obsidianTarget ? { 'data-obsidian-target': attributes.obsidianTarget } : {},
      },
      obsidianAlias: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-obsidian-alias'),
        renderHTML: (attributes) =>
          attributes.obsidianAlias ? { 'data-obsidian-alias': attributes.obsidianAlias } : {},
      },
      obsidianEmbed: {
        default: false,
        parseHTML: (element) => parseBooleanAttribute(element.getAttribute('data-obsidian-embed')),
        renderHTML: (attributes) =>
          attributes.obsidianEmbed ? { 'data-obsidian-embed': 'true' } : {},
      },
    };
  },
});
