import Blockquote from '@tiptap/extension-blockquote';
import Link from '@tiptap/extension-link';
import { resolveCalloutType } from '@/lib/markdown/callout-types.mjs';

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
        // `data-callout` is the type AS TYPED (the round-trip source, and what
        // parseHTML reads back on paste); `data-callout-resolved` is the
        // render-only canonical type an alias maps to — the hook CSS uses for
        // the color group and the icon. Unknown types emit no resolved attr and
        // keep the default styling.
        renderHTML: (attributes) => {
          if (!attributes.calloutType) return {};
          const resolved = resolveCalloutType(attributes.calloutType as string);
          return {
            'data-callout': attributes.calloutType,
            ...(resolved ? { 'data-callout-resolved': resolved } : {}),
          };
        },
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
