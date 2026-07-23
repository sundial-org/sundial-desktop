// Static Phosphor icon markup for the inline Keep/Undo review widgets.
// The editor surfaces build their widgets as HTML strings (ProseMirror /
// Monaco DOM widgets), so we inline the SVG rather than render a React icon.
// Kept in one place so the TipTap and Monaco widgets stay one visual system.

const ICON_ATTRS =
  'width="14" height="14" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true" focusable="false"';

/** Phosphor `Check` (regular weight). */
export const DIFF_CHECK_ICON_SVG = `<svg ${ICON_ATTRS}><path d="M229.66,77.66l-128,128a8,8,0,0,1-11.32,0l-56-56a8,8,0,0,1,11.32-11.32L96,188.69,218.34,66.34a8,8,0,0,1,11.32,11.32Z"></path></svg>`;

/** Phosphor `X` (regular weight). */
export const DIFF_X_ICON_SVG = `<svg ${ICON_ATTRS}><path d="M205.66,194.34a8,8,0,0,1-11.32,11.32L128,139.31,61.66,205.66a8,8,0,0,1-11.32-11.32L116.69,128,50.34,61.66A8,8,0,0,1,61.66,50.34L128,116.69l66.34-66.35a8,8,0,0,1,11.32,11.32L139.31,128Z"></path></svg>`;
