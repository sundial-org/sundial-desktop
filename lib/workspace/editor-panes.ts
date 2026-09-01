/**
 * Editor panes — the center editor column as a left→right row of panes, each
 * holding an ordered set of file tabs (Obsidian-style). Pane 0 is the PRIMARY
 * pane: the existing full editor surface (toolbars, comments, LaTeX preview,
 * chat context, URL mirroring) stays bound to it, and its `active` path
 * mirrors the page's `selectedFilePath`. Secondary panes are additive lite
 * editors created by dragging a tab to a pane edge ("split").
 *
 * These helpers are pure so every tab/split transition is unit-testable —
 * the same pattern as lib/workspace/layout.ts.
 */
import { isChatTab, isDiffTab, isLauncherTab, isReviewTab, isSpecialTab } from '@/lib/workspace/editor-tabs';

export type EditorPane = {
  id: string;
  /** Ordered open tabs; workspace file paths or special tabs (lib/workspace/editor-tabs). */
  tabs: string[];
  /** The visible tab; '' when the pane is empty. */
  active: string;
};

export type TabDragPayload = { paneId: string; path: string };

export type DropZone = 'left' | 'center' | 'right';

export const PRIMARY_PANE_ID = 'primary';
/** Drag payloads from the sidebar (file tree rows / chat cards) use this
 *  source id: the source "pane" isn't in the layout, so moves/splits skip
 *  source removal and just insert at the destination. */
export const RAIL_PANE_ID = 'rail';
export const MAX_EDITOR_PANES = 3;
/** Custom DnD mime so tab drags never collide with file-tree / upload drags. */
export const EDITOR_TAB_MIME = 'application/x-sundial-editor-tab';

/**
 * Embedded panel (?view=panel): ONE pane ever renders. Any transition that
 * minted a side pane (chat-aside docking on a deep link, the chat reveal, a
 * restored split) collapses back: secondary tabs merge into the primary as
 * background tabs and the primary's active tab stands (an empty primary
 * adopts the first visible secondary). Identity-stable when already single,
 * so the enforcing effect never loops.
 */
export function collapseToPrimaryPane(panes: EditorPane[]): EditorPane[] {
  if (panes.length <= 1) return panes;
  const [first, ...rest] = panes;
  const tabs = [...first.tabs];
  for (const pane of rest) {
    for (const tab of pane.tabs) if (!tabs.includes(tab)) tabs.push(tab);
  }
  const active = first.active || rest.find((pane) => pane.active)?.active || '';
  return [{ ...first, tabs, active }];
}

export function createInitialPanes(): EditorPane[] {
  return [{ id: PRIMARY_PANE_ID, tabs: [], active: '' }];
}

/**
 * Pane ids are a PURE function of the panes in hand, never a module counter.
 * React re-invokes state updaters (StrictMode double-invoke, or any re-render
 * before the update commits), and a counter handed every re-run a DIFFERENT
 * id — the next state never compared equal, so React re-rendered, re-ran the
 * updater, and the workspace spun in an infinite render loop the moment a
 * surface opened beside a chat (2026-08-06). max+1 keeps re-runs idempotent;
 * ids stay unique within a list and are session-local anyway (`panesSnapshot`
 * never persists them).
 */
const nextPaneId = (panes: readonly { id: string }[]) => {
  let max = 0;
  for (const pane of panes) {
    const seq = /^pane-(\d+)$/.exec(pane.id)?.[1];
    if (seq) max = Math.max(max, Number(seq));
  }
  return `pane-${max + 1}`;
};

const primary = (panes: EditorPane[]): EditorPane => panes[0];

/** The empty-pane invariant, applied after every transition: emptied
 *  secondaries dissolve, and when the PRIMARY empties the next pane's content
 *  promotes into the primary slot (PRIMARY_PANE_ID stays panes[0]). Only a
 *  sole primary may remain empty — the workspace empty state. */
export function pruneEmptyPanes(panes: EditorPane[]): EditorPane[] {
  const kept = panes.filter((pane) => pane.tabs.length > 0);
  if (kept.length === panes.length) return panes;
  if (kept.length === 0) return panes.length === 1 ? panes : [panes[0]];
  if (kept[0].id !== PRIMARY_PANE_ID) kept[0] = { ...kept[0], id: PRIMARY_PANE_ID };
  return kept;
}

/** The tab that takes over when `path` (at `index`) leaves a pane. */
function neighborOf(tabs: string[], index: number): string {
  if (tabs.length === 0) return '';
  return tabs[Math.min(index, tabs.length - 1)];
}

/**
 * Mirror `selectedFilePath` into the primary pane with replace semantics:
 * an already-open path just activates; otherwise the new path REPLACES the
 * active tab in place (a bare file-tree click swaps the document, exactly the
 * pre-tabs behavior) and only lands as an extra tab via the explicit
 * new-tab / split affordances.
 */
export function syncPrimaryActive(panes: EditorPane[], path: string): EditorPane[] {
  const pane = primary(panes);
  if (pane.active === path) return panes;
  // A chat tab holds the view: background file (pre)selection — the initial-file
  // heuristic, deep-link resolution — must not steal focus or replace the chat.
  // Explicit opens route through openTab/replaceActiveTab instead. A path
  // already open in ANY pane (e.g. the first-edit reveal's side pane) stays
  // where it is instead of duplicating into the primary.
  if (isChatTab(pane.active)) {
    if (!path || panes.some((p) => p.tabs.includes(path))) return panes;
    return replacePane(panes, 0, { ...pane, tabs: [...pane.tabs, path] });
  }
  // Already ON SCREEN in another pane: the selection mirror must not pull a
  // second copy into the primary. A rail click that lands in a side pane sets
  // the selection too, and without this the primary swapped to the same file —
  // one click, two panes changed (the onboarding report).
  if (path && panes.some((p, i) => i > 0 && p.active === path)) return panes;
  if (!path) return replacePane(panes, 0, { ...pane, active: '' });
  if (pane.tabs.includes(path)) return replacePane(panes, 0, { ...pane, active: path });
  const activeIndex = pane.tabs.indexOf(pane.active);
  const tabs =
    activeIndex === -1
      ? [...pane.tabs, path]
      : pane.tabs.map((tab, i) => (i === activeIndex ? path : tab));
  return replacePane(panes, 0, { ...pane, tabs, active: path });
}

/**
 * Wireframe replace-on-open: the opened tab REPLACES the focused pane's active
 * tab in place (already-open tabs just activate; diff tabs are never replaced —
 * they're view-only KEEP tabs, so the open lands beside them instead).
 */
export function replaceActiveTab(panes: EditorPane[], paneId: string, tab: string): EditorPane[] {
  const index = panes.findIndex((p) => p.id === paneId);
  if (index === -1 || !tab) return panes;
  const pane = panes[index];
  if (pane.active === tab) return panes;
  // Activating an already-open tab still consumes an active launcher — the
  // "New tab" chooser never survives a pick, even one that lands on a tab
  // this pane already holds.
  if (pane.tabs.includes(tab)) {
    const tabs = isLauncherTab(pane.active) ? pane.tabs.filter((t) => t !== pane.active) : pane.tabs;
    return replacePane(panes, index, { ...pane, tabs, active: tab });
  }
  const activeIndex = pane.tabs.indexOf(pane.active);
  // Diff AND review tabs are view-only KEEP tabs: opening a file FROM one (the
  // timeline's whole job) must land beside it, not consume the view you opened
  // the file from.
  const keepActive = pane.active !== '' && (isDiffTab(pane.active) || isReviewTab(pane.active));
  const tabs =
    activeIndex === -1 || keepActive
      ? [...pane.tabs, tab]
      : pane.tabs.map((t, i) => (i === activeIndex ? tab : t));
  return replacePane(panes, index, { ...pane, tabs, active: tab });
}

/**
 * Deep-link/arrival claim: the doc takes the primary pane, and an active chat
 * tab moves ASIDE (wireframe: shared file+chat shows both) instead of being
 * discarded. Order-independent with the chat-activation path: whichever runs
 * second converges to doc-primary + chat-side.
 */
export function openWithChatAside(panes: EditorPane[], path: string): EditorPane[] {
  const activeChat = isChatTab(primary(panes).active) ? primary(panes).active : null;
  let next = replaceActiveTab(panes, PRIMARY_PANE_ID, path);
  if (!activeChat) return next;
  next = openToSide(next, activeChat);
  // Prefer the pane SHOWING the chat: when `path` was already a background
  // tab, replaceActiveTab keeps the chat tab in the primary's background, and
  // matching by containment would demote the side pane we just opened.
  const holder =
    next.find((pane) => pane.active === activeChat) ??
    next.find((pane) => pane.tabs.includes(activeChat));
  return holder ? enforceSingleActiveChat(next, holder.id) : next;
}

/**
 * Single-live-chat invariant: the workspace runs ONE live chat stream, so at
 * most one pane may show a chat tab. After `activePaneId` takes a chat tab,
 * every other pane showing a chat falls back to its nearest non-chat tab
 * (keeping the chat as a background tab). Panes are pruned as usual.
 */
export function enforceSingleActiveChat(panes: EditorPane[], activePaneId: string): EditorPane[] {
  let changed = false;
  const next = panes.map((pane) => {
    if (pane.id === activePaneId || !isChatTab(pane.active)) return pane;
    changed = true;
    const nonChat = pane.tabs.filter((t) => !isChatTab(t));
    return { ...pane, active: nonChat.length ? nonChat[nonChat.length - 1] : '' };
  });
  if (!changed) return panes;
  // A secondary pane whose only content was the demoted chat keeps the chat as
  // a background tab — pruning only drops panes with no tabs at all.
  return pruneEmptyPanes(next);
}

function replacePane(panes: EditorPane[], index: number, pane: EditorPane): EditorPane[] {
  return panes.map((p, i) => (i === index ? pane : p));
}

/** Append (or activate) a tab in a pane. An active LAUNCHER tab is consumed
 *  in place — ⌘T's "New tab" IS the slot the next open fills (Obsidian). */
export function openTab(panes: EditorPane[], paneId: string, path: string): EditorPane[] {
  const index = panes.findIndex((p) => p.id === paneId);
  if (index === -1 || !path) return panes;
  const pane = panes[index];
  if (pane.tabs.includes(path)) {
    // Same consumption rule as replaceActiveTab's already-open path — but a
    // repeat ⌘T re-activates the launcher ITSELF, which must not self-consume.
    const consume = isLauncherTab(pane.active) && path !== pane.active;
    const tabs = consume ? pane.tabs.filter((t) => t !== pane.active) : pane.tabs;
    return replacePane(panes, index, { ...pane, tabs, active: path });
  }
  const tabs = isLauncherTab(pane.active)
    ? pane.tabs.map((t) => (t === pane.active ? path : t))
    : [...pane.tabs, path];
  return replacePane(panes, index, { ...pane, tabs, active: path });
}

/**
 * Open a path in the pane beside the primary, creating the split when needed.
 * Reuses the first secondary pane so repeated "Open to the side" doesn't stack
 * new columns.
 */
export function openToSide(panes: EditorPane[], path: string): EditorPane[] {
  if (!path) return panes;
  if (panes.length > 1) return openTab(panes, panes[1].id, path);
  if (panes.length >= MAX_EDITOR_PANES) return panes;
  return [...panes, { id: nextPaneId(panes), tabs: [path], active: path }];
}

/**
 * Which pane an explicit RAIL open (file-tree row, chat card, command palette)
 * should land in — the ONE pane such a click may change. Rules, in order:
 *
 *  1. the pane already SHOWING that exact tab (the click is a focus no-op),
 *  2. the FOCUSED pane when it shows the same KIND of surface (files-left /
 *     chats-right: a doc click claims a doc pane, a chat click a chat pane),
 *  3. the first pane showing that kind,
 *  4. null — nothing of that kind is on screen; the caller decides (split
 *     aside / primary).
 *
 * Focus-first is the fix for the onboarding report: with two document panes
 * open, "the first pane showing a file" always meant the LEFT one, so clicking
 * files in the rail kept swapping a pane the user wasn't working in. A
 * background copy of the tab never wins — replacing a pane that merely HOLDS
 * the tab behind its active one is what made a rail chat click swap the
 * document in one pane and the chat in another at the same time.
 */
export function resolveOpenTargetPaneId(
  panes: EditorPane[],
  kind: 'file' | 'chat',
  focusedPaneId: string | null | undefined,
  tab?: string,
): string | null {
  const showsKind = (pane: EditorPane) =>
    kind === 'chat' ? isChatTab(pane.active) : pane.active !== '' && !isSpecialTab(pane.active);
  if (tab) {
    const shown = panes.find((pane) => pane.active === tab);
    if (shown) return shown.id;
  }
  const focused = panes.find((pane) => pane.id === focusedPaneId);
  if (focused && showsKind(focused)) return focused.id;
  return panes.find(showsKind)?.id ?? null;
}

/** Drop `tab` from every pane except `keepPaneId` (omit it to drop everywhere,
 *  e.g. just before the tab lands in a pane that doesn't exist yet) — a tab
 *  lives in exactly one pane, so moving it must not leave a background copy
 *  behind. A stale copy is what a later rail click would hijack. */
export function dropTabElsewhere(panes: EditorPane[], tab: string, keepPaneId?: string): EditorPane[] {
  if (!tab) return panes;
  let changed = false;
  const next = panes.map((pane) => {
    if (pane.id === keepPaneId || !pane.tabs.includes(tab)) return pane;
    changed = true;
    const tabs = pane.tabs.filter((t) => t !== tab);
    const active = pane.active === tab ? neighborOf(tabs, pane.tabs.indexOf(tab)) : pane.active;
    return { ...pane, tabs, active };
  });
  return changed ? pruneEmptyPanes(next) : panes;
}

export type CloseTabResult = {
  panes: EditorPane[];
  /** Set when the PRIMARY pane's active tab changed ('' = pane emptied). */
  primaryActive?: string;
};

export function closeTab(panes: EditorPane[], paneId: string, path: string): CloseTabResult {
  const index = panes.findIndex((p) => p.id === paneId);
  if (index === -1) return { panes };
  const pane = panes[index];
  const tabIndex = pane.tabs.indexOf(path);
  if (tabIndex === -1) return { panes };
  const tabs = pane.tabs.filter((t) => t !== path);
  const active = pane.active === path ? neighborOf(tabs, tabIndex) : pane.active;
  const next = pruneEmptyPanes(replacePane(panes, index, { ...pane, tabs, active }));
  return {
    panes: next,
    // next[0].active, not `active`: an emptied primary adopts the promoted
    // pane's content, and the hand-off must follow it.
    primaryActive: index === 0 && pane.active === path ? next[0].active : undefined,
  };
}

export type MoveTabResult = CloseTabResult;

/**
 * Move a tab to `dst.paneId` at `dst.index` (clamped; -1 = append). Handles
 * same-pane reorders; a path already open in the destination just activates
 * there (no duplicate tabs within one pane). Emptied secondary panes vanish.
 * A RAIL_PANE_ID source (file tree / chat card drag) has no source pane to
 * remove from — the tab just inserts/activates at the destination.
 */
export function moveTab(
  panes: EditorPane[],
  src: TabDragPayload,
  dst: { paneId: string; index: number },
): MoveTabResult {
  const fromRail = src.paneId === RAIL_PANE_ID;
  const srcPaneIndex = panes.findIndex((p) => p.id === src.paneId);
  const dstPaneIndex = panes.findIndex((p) => p.id === dst.paneId);
  if ((srcPaneIndex === -1 && !fromRail) || dstPaneIndex === -1 || !src.path) return { panes };
  let next = panes;
  let srcActive: string | undefined;
  let srcWasPrimaryActive = false;
  if (!fromRail) {
    const srcPane = panes[srcPaneIndex];
    const srcTabIndex = srcPane.tabs.indexOf(src.path);
    if (srcTabIndex === -1) return { panes };

    if (src.paneId === dst.paneId) {
      // Reorder within the strip. dst.index is measured against the strip with
      // the dragged tab still rendered, so a drop to the RIGHT of its own slot
      // must shift left one to match the insertion bar after removal.
      const tabs = srcPane.tabs.filter((t) => t !== src.path);
      let at = dst.index < 0 ? tabs.length : dst.index;
      if (dst.index >= 0 && srcTabIndex < dst.index) at -= 1;
      at = Math.min(Math.max(at, 0), tabs.length);
      tabs.splice(at, 0, src.path);
      // Dropping back onto its own slot is a no-op.
      if (tabs.every((t, i) => t === srcPane.tabs[i])) return { panes };
      return { panes: replacePane(panes, srcPaneIndex, { ...srcPane, tabs }) };
    }

    const srcTabs = srcPane.tabs.filter((t) => t !== src.path);
    srcActive = srcPane.active === src.path ? neighborOf(srcTabs, srcTabIndex) : srcPane.active;
    srcWasPrimaryActive = srcPaneIndex === 0 && srcPane.active === src.path;
    next = replacePane(panes, srcPaneIndex, { ...srcPane, tabs: srcTabs, active: srcActive });
  }

  const dstPane = next[dstPaneIndex];
  if (dstPane.tabs.includes(src.path)) {
    next = replacePane(next, dstPaneIndex, { ...dstPane, active: src.path });
  } else {
    const tabs = [...dstPane.tabs];
    const at = dst.index < 0 ? tabs.length : Math.min(Math.max(dst.index, 0), tabs.length);
    tabs.splice(at, 0, src.path);
    next = replacePane(next, dstPaneIndex, { ...dstPane, tabs, active: src.path });
  }
  // The moved tab activates in its destination — landing in the PRIMARY pane
  // must hand the path off to selectedFilePath just like leaving it does. An
  // emptied primary adopts the promoted pane's content, so the hand-off reads
  // the pruned result.
  const pruned = pruneEmptyPanes(next);
  return {
    panes: pruned,
    primaryActive: dstPaneIndex === 0 ? src.path : srcWasPrimaryActive ? pruned[0].active : undefined,
  };
}

/**
 * Split: pull `src` out into a NEW pane immediately left/right of the target
 * pane. No-op at the pane cap, when the tab is the target pane's only content
 * shortcut to itself, or on unknown ids. A RAIL_PANE_ID source skips source
 * removal (the tab comes from the sidebar, not a pane).
 */
export function splitWithTab(
  panes: EditorPane[],
  src: TabDragPayload,
  targetPaneId: string,
  side: 'left' | 'right',
): MoveTabResult {
  if (panes.length >= MAX_EDITOR_PANES) return { panes };
  const fromRail = src.paneId === RAIL_PANE_ID;
  const srcPaneIndex = panes.findIndex((p) => p.id === src.paneId);
  const targetIndex = panes.findIndex((p) => p.id === targetPaneId);
  if ((srcPaneIndex === -1 && !fromRail) || targetIndex === -1 || !src.path) return { panes };
  let next = panes;
  let primaryActive: string | undefined;
  if (!fromRail) {
    const srcPane = panes[srcPaneIndex];
    const srcTabIndex = srcPane.tabs.indexOf(src.path);
    if (srcTabIndex === -1) return { panes };
    // Splitting a pane's only tab against itself would recreate the same layout
    // (or, for the primary pane, pointlessly demote its document to a lite pane).
    if (src.paneId === targetPaneId && srcPane.tabs.length === 1) {
      return { panes };
    }
    const srcTabs = srcPane.tabs.filter((t) => t !== src.path);
    const srcActive = srcPane.active === src.path ? neighborOf(srcTabs, srcTabIndex) : srcPane.active;
    if (srcPaneIndex === 0 && srcPane.active === src.path) primaryActive = srcActive;
    next = replacePane(panes, srcPaneIndex, { ...srcPane, tabs: srcTabs, active: srcActive });
  }
  const newPane: EditorPane = { id: nextPaneId(next), tabs: [src.path], active: src.path };
  const insertAt = next.findIndex((p) => p.id === targetPaneId) + (side === 'right' ? 1 : 0);
  // The primary pane must stay panes[0] — it carries the full editor chrome —
  // so a left split of the LEFTMOST pane swaps contents instead of inserting:
  // the primary adopts the dragged tab and its previous tabs shift right into
  // the new pane, landing the dragged tab visually leftmost as previewed.
  if (insertAt === 0) {
    const prim = next[0];
    next = [
      { ...prim, tabs: newPane.tabs, active: newPane.active },
      { ...newPane, tabs: prim.tabs, active: prim.active },
      ...next.slice(1),
    ];
    return { panes: pruneEmptyPanes(next), primaryActive: src.path };
  }
  next = [...next.slice(0, insertAt), newPane, ...next.slice(insertAt)];
  const pruned = pruneEmptyPanes(next);
  // An emptied primary adopts the promoted pane's content — hand that off.
  return { panes: pruned, primaryActive: primaryActive === undefined ? undefined : pruned[0].active };
}

/** Exact path or descendant — a bare prefix match would catch `${base}-old`. */
export const isPathWithin = (path: string, base: string) =>
  path === base || path.startsWith(`${base}/`);

/** Follow a `from`→`to` move for one path; identity when not covered. */
export const remapPath = (path: string, from: string, to: string) =>
  isPathWithin(path, from) ? `${to}${path.slice(from.length)}` : path;

const within = isPathWithin;

/** Follow a file/folder move: prefix-remap every tab and active path.
 *  Special (chat/diff) tabs are never paths — skip them, or a folder named
 *  like a tab scheme could rewrite a chat tab. Reference-stable when the
 *  move touches nothing open. */
export function remapPanePaths(panes: EditorPane[], from: string, to: string): EditorPane[] {
  const remapTab = (tab: string) => (isSpecialTab(tab) ? tab : remapPath(tab, from, to));
  let changed = false;
  const next = panes.map((pane) => {
    let paneChanged = false;
    const tabs: string[] = [];
    for (const tab of pane.tabs) {
      const remapped = remapTab(tab);
      if (remapped !== tab) paneChanged = true;
      if (!tabs.includes(remapped)) tabs.push(remapped); // a remap collision keeps the first
    }
    const active = remapTab(pane.active);
    if (active !== pane.active) paneChanged = true;
    if (!paneChanged) return pane;
    changed = true;
    return { ...pane, tabs, active };
  });
  return changed ? next : panes;
}

export type RemovePathsResult = CloseTabResult;

/** Close every tab at or under the deleted paths. Special (chat/diff) tabs
 *  are never paths — skip them, like remapPanePaths. */
export function removePanePaths(panes: EditorPane[], paths: string[]): RemovePathsResult {
  if (paths.length === 0) return { panes };
  const gone = (path: string) => !isSpecialTab(path) && paths.some((p) => within(path, p));
  let primaryActive: string | undefined;
  const next = panes.map((pane, index) => {
    const tabs = pane.tabs.filter((t) => !gone(t));
    if (tabs.length === pane.tabs.length) return pane;
    let active = pane.active;
    if (gone(active)) {
      active = neighborOf(tabs, pane.tabs.indexOf(active));
      if (index === 0) primaryActive = active;
    }
    return { ...pane, tabs, active };
  });
  const pruned = pruneEmptyPanes(next);
  return { panes: pruned, primaryActive: primaryActive === undefined ? undefined : pruned[0].active };
}

/**
 * Web (no-tabs) layout: at most doc-left + chat-right. The browser already has
 * a tab row, so the web shell renders no strips — a restored (possibly
 * desktop-shell) snapshot reduces to "the visible file + whether a chat is
 * open": the primary keeps only its visible file, one side pane keeps the
 * visible chat, and every other pane/tab drops. A chat with no visible file
 * keeps the primary alone (full-width chat).
 */
export function flattenPanesForWeb(panes: EditorPane[]): EditorPane[] {
  const filePane = panes.find((p) => p.active !== '' && !isSpecialTab(p.active));
  const chatPane = panes.find((p) => isChatTab(p.active));
  const out: EditorPane[] = [];
  if (filePane) out.push({ id: PRIMARY_PANE_ID, tabs: [filePane.active], active: filePane.active });
  if (chatPane) {
    const id = out.length === 0 ? PRIMARY_PANE_ID : nextPaneId(out);
    out.push({ id, tabs: [chatPane.active], active: chatPane.active });
  }
  return out.length > 0 ? out : createInitialPanes();
}

/**
 * Validate a persisted value (localStorage) against the current file list.
 * Unknown paths drop; empty secondary panes drop; the primary pane is
 * guaranteed and capped panes beyond MAX_EDITOR_PANES drop.
 */
export function normalizePanes(value: unknown, existingPaths: Set<string>): EditorPane[] {
  const initial = createInitialPanes();
  if (!value || typeof value !== 'object') return initial;
  const rawPanes = (value as { panes?: unknown }).panes;
  if (!Array.isArray(rawPanes)) return initial;
  const out: EditorPane[] = [];
  for (const raw of rawPanes) {
    if (out.length >= MAX_EDITOR_PANES) break;
    if (!raw || typeof raw !== 'object') continue;
    const rawTabs = (raw as { tabs?: unknown }).tabs;
    const rawActive = (raw as { active?: unknown }).active;
    const tabs: string[] = [];
    if (Array.isArray(rawTabs)) {
      for (const tab of rawTabs) {
        if (typeof tab !== 'string' || tabs.includes(tab)) continue;
        // Chat tabs restore (the page prunes unknown chat ids once chats load);
        // diff tabs are ephemeral view-only surfaces and never restore.
        if (isChatTab(tab) ? true : isSpecialTab(tab) ? false : existingPaths.has(tab)) {
          tabs.push(tab);
        }
      }
    }
    if (out.length > 0 && tabs.length === 0) continue;
    const active =
      typeof rawActive === 'string' && tabs.includes(rawActive)
        ? rawActive
        : tabs[tabs.length - 1] ?? '';
    out.push({ id: out.length === 0 ? PRIMARY_PANE_ID : nextPaneId(out), tabs, active });
  }
  // A primary restored empty beside surviving secondaries (its only tab was a
  // dropped diff/dead path) promotes the next pane — never an empty pane.
  return out.length > 0 ? pruneEmptyPanes(out) : initial;
}

/** Serializable snapshot for persistence (ids are session-local, not saved). */
export function panesSnapshot(panes: EditorPane[]): { panes: { tabs: string[]; active: string }[] } {
  return { panes: panes.map(({ tabs, active }) => ({ tabs, active })) };
}

/**
 * Which drop zone a pointer position maps to inside a pane body. Edge quarters
 * split; the middle half moves the tab into this pane (Obsidian's geometry).
 */
export function resolveDropZone(x: number, width: number): DropZone {
  if (width <= 0) return 'center';
  const ratio = Math.min(Math.max(x / width, 0), 1);
  if (ratio < 0.25) return 'left';
  if (ratio > 0.75) return 'right';
  return 'center';
}

export function parseTabDragPayload(raw: string): TabDragPayload | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const { paneId, path } = parsed as { paneId?: unknown; path?: unknown };
    if (typeof paneId !== 'string' || typeof path !== 'string' || !path) return null;
    return { paneId, path };
  } catch {
    return null;
  }
}
