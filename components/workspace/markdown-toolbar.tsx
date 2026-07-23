'use client';

import type { Editor } from '@tiptap/react';
import { forwardRef, useCallback, useEffect, useRef, useState } from 'react';
import { IconTooltip } from '@/components/collab-bubbles';
import {
  ArrowClockwiseIcon,
  ArrowCounterClockwiseIcon,
  CaretDownIcon,
  CaretUpIcon,
  CheckIcon,
  DotsThreeVerticalIcon,
  EraserIcon,
  HighlighterIcon,
  ImageIcon,
  LinkIcon,
  ListBulletsIcon,
  ListChecksIcon,
  ListNumbersIcon,
  MinusIcon,
  PlusIcon,
  PrinterIcon,
  RowsIcon,
  TextAaIcon,
  TextAlignCenterIcon,
  TextAlignJustifyIcon,
  TextAlignLeftIcon,
  TextAlignRightIcon,
  TextBIcon,
  TextIndentIcon,
  TextItalicIcon,
  TextOutdentIcon,
  TextUnderlineIcon,
} from '@phosphor-icons/react';

interface MarkdownToolbarProps {
  editor: Editor;
  readOnly?: boolean;
  containerWidth?: number;
  /** When provided, the zoom display is controlled by the caller. */
  zoom?: number;
  onZoomChange?: (zoom: number) => void;
  /** When provided, the line-height display is controlled by the caller. */
  lineHeight?: number;
  onLineHeightChange?: (lineHeight: number) => void;
  pageChrome?: MarkdownPageChrome;
  onPageChromeChange?: (chrome: MarkdownPageChrome) => void;
  /** Whether the menus (rows above the toolbar) are currently hidden. */
  menusHidden?: boolean;
  /** Called when the user clicks the chevron to show/hide the menus above the toolbar. */
  onToggleMenus?: () => void;
}

// Progressive reveal thresholds, in px of responsive width (container minus the
// overflow reserve). Each value is ≈ the cumulative width of the bar's content
// up to that group, measured from the live toolbar, so groups appear one at a
// time as the bar widens instead of in a few big jumps that leave dead space.
// Keep strictly ascending — the bar relies on that for monotonic reveal.
const SHOW_UNDO = 150; // undo / redo / print / spellcheck
const SHOW_ZOOM = 270; // zoom / page setup
const SHOW_PARAGRAPH = 400; // paragraph style
const SHOW_FONT = 515; // font family
const SHOW_FONT_SIZE = 650; // font-size stepper
const SHOW_MARKS = 800; // bold / italic / underline / color / highlight
const SHOW_LINK = 890; // link / image
const SHOW_ALIGN = 990; // alignment + line spacing
const SHOW_LISTS = 1080; // checklist / bullets / numbers
const SHOW_INDENT = 1140; // indent / outdent
const SHOW_CLEAR = 1225; // clear formatting (last group → everything fits)
const SHOW_ALIGN_BUTTONS = 1300; // alignment as 4 inline buttons vs a dropdown

type HeadingLevel = 1 | 2 | 3;

const FONT_FAMILIES = [
  'Arial',
  'Georgia',
  'Times New Roman',
  'Courier New',
  'Verdana',
  'Roboto',
];

const TEXT_COLORS = [
  '#1c1917',
  '#57534e',
  '#991b1b',
  '#e11d48',
  '#ea580c',
  '#ca8a04',
  '#15803d',
  '#0369a1',
  '#4338ca',
  '#7e22ce',
];

const HIGHLIGHT_COLORS = [
  '#fef08a',
  '#fde68a',
  '#fca5a5',
  '#f9a8d4',
  '#c7d2fe',
  '#a5f3fc',
  '#bbf7d0',
  '#e4e4e7',
];

const ZOOM_LEVELS = [50, 75, 90, 100, 125, 150, 200];
const LINE_HEIGHTS = [1, 1.15, 1.5, 2, 2.5];
type MarkdownPageChrome = {
  margin: 'narrow' | 'normal' | 'wide';
  header: boolean;
  footer: boolean;
};
const DEFAULT_PAGE_CHROME: MarkdownPageChrome = { margin: 'normal', header: false, footer: false };

const Btn = forwardRef<
  HTMLButtonElement,
  {
    active?: boolean;
    disabled?: boolean;
    label: string;
    onClick: () => void;
    children: React.ReactNode;
    width?: 'auto' | 'icon';
    open?: boolean;
  }
>(function Btn({ active, disabled, label, onClick, children, width = 'icon', open }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      onMouseDown={(event) => {
        event.preventDefault();
        if (!disabled) {
          onClick();
        }
      }}
      disabled={disabled}
      aria-label={label}
      aria-pressed={active}
      data-toolbar-btn={label}
      className={[
        'relative group/tip inline-flex h-7 items-center justify-center gap-1 rounded px-1.5 text-[12px] transition-colors',
        width === 'icon' ? 'w-7' : 'min-w-[2.75rem]',
        active
          ? 'bg-stone-300/70 text-stone-900'
          : 'text-stone-600 hover:bg-stone-200/60 hover:text-stone-900',
        disabled ? 'pointer-events-none opacity-40' : 'cursor-pointer',
      ].join(' ')}
    >
      {children}
      <IconTooltip label={label} open={open} />
    </button>
  );
});

function Sep() {
  return <div className="mx-1.5 h-5 w-px shrink-0 bg-stone-300" aria-hidden />;
}

function Popover({
  open,
  onClose,
  anchorRef,
  align = 'left',
  children,
}: {
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLElement | null>;
  align?: 'left' | 'right';
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleMouseDown = (event: MouseEvent) => {
      if (
        ref.current &&
        !ref.current.contains(event.target as Node) &&
        anchorRef.current &&
        !anchorRef.current.contains(event.target as Node)
      ) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [anchorRef, onClose, open]);

  if (!open) return null;

  return (
    <div
      ref={ref}
      className={`absolute top-full z-50 mt-1 min-w-[160px] rounded-lg border border-stone-200 bg-white p-1 shadow-[0_8px_24px_-12px_rgba(28,25,23,0.35)] ${
        align === 'right' ? 'right-0' : 'left-0'
      }`}
    >
      {children}
    </div>
  );
}

function DropdownItem({
  active,
  onClick,
  children,
  testId,
}: {
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onMouseDown={(event) => {
        event.preventDefault();
        onClick();
      }}
      data-dropdown-item={testId}
      className={[
        'flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] transition-colors',
        active ? 'bg-stone-100 text-stone-900' : 'text-stone-700 hover:bg-stone-100',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

// Open the editor's styled, cursor-anchored link inserter (the popover ⌘K
// opens). Used wherever a native window.prompt would otherwise appear, and where
// a Tier-D link Popover is unreachable (e.g. display:none when condensed).
export function openEditorLinkMenu(editor: Editor) {
  editor.chain().focus().run();
  window.dispatchEvent(new CustomEvent('sundial:open-link-menu'));
}

// Shared swatch grid for the text-color / highlight pickers (Tier-D popovers and
// the condensed overflow menu). gridClass/swatchClass let callers size it; pass
// onRemove to append a "Remove" row.
function SwatchGrid({
  colors,
  onPick,
  ariaPrefix,
  gridClass,
  swatchClass = 'h-6 w-6',
  onRemove,
  removeLabel,
}: {
  colors: readonly string[];
  onPick: (color: string) => void;
  ariaPrefix: string;
  gridClass: string;
  swatchClass?: string;
  onRemove?: () => void;
  removeLabel?: string;
}) {
  return (
    <>
      <div className={`grid gap-1 ${gridClass}`}>
        {colors.map((color) => (
          <button
            key={color}
            type="button"
            onMouseDown={(event) => { event.preventDefault(); onPick(color); }}
            className={`${swatchClass} rounded border border-stone-200 transition-transform hover:scale-105`}
            style={{ backgroundColor: color }}
            aria-label={`${ariaPrefix} ${color}`}
          />
        ))}
      </div>
      {onRemove && (
        <button
          type="button"
          onMouseDown={(event) => { event.preventDefault(); onRemove(); }}
          className="mt-2 w-full rounded px-2 py-1 text-[11px] text-stone-600 hover:bg-stone-100"
        >
          {removeLabel}
        </button>
      )}
    </>
  );
}

// Shared URL→image inserter for the Tier-D popover, the condensed overflow menu,
// and the menu bar's Insert→Image — one markup + submit path keeps every image
// inserter visually consistent.
export function ImageInsertField({
  value,
  onChange,
  onSubmit,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
}) {
  return (
    <div className="flex w-64 items-center gap-1 p-2">
      <input
        type="url"
        placeholder="Image URL"
        value={value}
        autoFocus
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter') onSubmit(); }}
        className="min-w-0 flex-1 rounded border border-stone-200 px-2 py-1.5 text-[12px] outline-none focus:border-stone-400"
        data-toolbar-image-url
      />
      <button
        type="button"
        onMouseDown={(event) => { event.preventDefault(); onSubmit(); }}
        className="flex shrink-0 items-center gap-1 rounded bg-stone-800 px-2.5 py-1.5 text-[11px] font-medium text-white hover:bg-stone-700"
        aria-label="Insert image"
        data-toolbar-image-apply
      >
        <ImageIcon className="h-3.5 w-3.5" aria-hidden /> Insert
      </button>
    </div>
  );
}

function DropdownBtn({
  disabled,
  label,
  onToggle,
  open,
  anchorRef,
  children,
  minWidth = '6.5rem',
}: {
  disabled?: boolean;
  label: string;
  onToggle: () => void;
  open: boolean;
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  children: React.ReactNode;
  minWidth?: string;
}) {
  return (
    <button
      ref={anchorRef}
      type="button"
      onMouseDown={(event) => {
        event.preventDefault();
        if (!disabled) onToggle();
      }}
      disabled={disabled}
      aria-label={label}
      aria-expanded={open}
      data-toolbar-btn={label}
      className={[
        'relative group/tip inline-flex h-7 items-center justify-between gap-1 rounded px-2 text-[12px] transition-colors',
        open
          ? 'bg-stone-200/80 text-stone-900'
          : 'text-stone-700 hover:bg-stone-200/60 hover:text-stone-900',
        disabled ? 'pointer-events-none opacity-40' : 'cursor-pointer',
      ].join(' ')}
      style={{ minWidth }}
    >
      {children}
      <IconTooltip label={label} open={open} />
    </button>
  );
}

export function MarkdownToolbar({
  editor,
  readOnly = false,
  containerWidth = Infinity,
  zoom: zoomProp,
  onZoomChange,
  lineHeight: lineHeightProp,
  onLineHeightChange,
  pageChrome,
  onPageChromeChange,
  menusHidden = false,
  onToggleMenus,
}: MarkdownToolbarProps) {
  const responsiveWidth =
    containerWidth === 0 || !Number.isFinite(containerWidth)
      ? containerWidth
      : Math.max(0, containerWidth - (onToggleMenus ? 36 : 0) - 36);
  // width 0 = unmeasured (initial/SSR): show the full bar rather than collapse.
  const fits = (min: number) => responsiveWidth === 0 || responsiveWidth >= min;
  const showUndo = fits(SHOW_UNDO);
  const showZoom = fits(SHOW_ZOOM);
  const showParagraph = fits(SHOW_PARAGRAPH);
  const showFont = fits(SHOW_FONT);
  const showFontSize = fits(SHOW_FONT_SIZE);
  const showMarks = fits(SHOW_MARKS);
  const showLink = fits(SHOW_LINK);
  const showAlign = fits(SHOW_ALIGN);
  const showLists = fits(SHOW_LISTS);
  const showIndent = fits(SHOW_INDENT);
  const showClear = fits(SHOW_CLEAR);
  const showAlignButtons = fits(SHOW_ALIGN_BUTTONS);
  // Thresholds ascend, so the last group fitting means every group fits.
  const showOverflow = !showClear;
  // During a file switch the page keeps this bar rendered against the previous,
  // now-destroyed editor (frozen on its last state) so it doesn't blank. Reads
  // are safe, but commands aren't — make the frozen bar inert so a formatting
  // click isn't silently run against the dead editor. No visual change (no
  // greying), so fast switches don't flash.
  const frozen = editor.isDestroyed;
  const [, forceRender] = useState(0);
  const bumpRender = useCallback(() => forceRender((value) => value + 1), []);

  // Re-render the toolbar on every selection/transaction so each Btn's
  // `active` (driven by editor.isActive('bold'|'heading'|…)) and the Paragraph
  // control's label track the cursor — this is what makes the toolbar reflect
  // the header/active marks at the caret (Alexis fix #12).
  useEffect(() => {
    const onUpdate = () => bumpRender();
    editor.on('selectionUpdate', onUpdate);
    editor.on('transaction', onUpdate);
    return () => {
      editor.off('selectionUpdate', onUpdate);
      editor.off('transaction', onUpdate);
    };
  }, [editor, bumpRender]);

  const [paragraphOpen, setParagraphOpen] = useState(false);
  const [fontOpen, setFontOpen] = useState(false);
  const [alignOpen, setAlignOpen] = useState(false);
  const [lineSpacingOpen, setLineSpacingOpen] = useState(false);
  const [zoomOpen, setZoomOpen] = useState(false);
  const [pageOpen, setPageOpen] = useState(false);
  const [colorOpen, setColorOpen] = useState(false);
  const [highlightOpen, setHighlightOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [imageOpen, setImageOpen] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [spellcheckEnabled, setSpellcheckEnabled] = useState(() => {
    // v3 throws on `editor.view` once the editor is destroyed; the toolbar is
    // rendered against the last (frozen) editor during file switches, so guard.
    const dom = editor.isDestroyed ? undefined : (editor.view.dom as HTMLElement | undefined);
    return dom?.getAttribute('spellcheck') !== 'false';
  });

  const [linkUrl, setLinkUrl] = useState('');
  const [linkText, setLinkText] = useState('');
  const [imageUrl, setImageUrl] = useState('');

  const paragraphRef = useRef<HTMLButtonElement | null>(null);
  const fontRef = useRef<HTMLButtonElement | null>(null);
  const alignRef = useRef<HTMLButtonElement | null>(null);
  const lineSpacingRef = useRef<HTMLButtonElement | null>(null);
  const zoomRef = useRef<HTMLButtonElement | null>(null);
  const pageRef = useRef<HTMLButtonElement | null>(null);
  const colorRef = useRef<HTMLButtonElement | null>(null);
  const highlightRef = useRef<HTMLButtonElement | null>(null);
  const linkRef = useRef<HTMLButtonElement | null>(null);
  const imageRef = useRef<HTMLButtonElement | null>(null);
  const overflowRef = useRef<HTMLButtonElement | null>(null);

  const [localZoom, setLocalZoom] = useState(100);
  const [localLineHeight, setLocalLineHeight] = useState(1.5);
  const zoom = zoomProp ?? localZoom;
  const lineHeight = lineHeightProp ?? localLineHeight;
  const [localPageChrome, setLocalPageChrome] = useState<MarkdownPageChrome>(DEFAULT_PAGE_CHROME);
  const effectivePageChrome = pageChrome ?? localPageChrome;

  const headingLevel = ([1, 2, 3] as const).find((level) =>
    editor.isActive('heading', { level }),
  ) as HeadingLevel | undefined;

  const activeFontFamily =
    (editor.getAttributes('textStyle').fontFamily as string | undefined) ?? 'Arial';
  const activeFontSize = (() => {
    const raw = editor.getAttributes('textStyle').fontSize as string | undefined;
    if (!raw) return 11;
    const n = parseInt(raw.replace('px', ''), 10);
    return Number.isFinite(n) ? n : 11;
  })();

  const closeAll = useCallback(() => {
    setParagraphOpen(false);
    setFontOpen(false);
    setAlignOpen(false);
    setLineSpacingOpen(false);
    setZoomOpen(false);
    setPageOpen(false);
    setColorOpen(false);
    setHighlightOpen(false);
    setLinkOpen(false);
    setImageOpen(false);
    setOverflowOpen(false);
  }, []);

  const undo = useCallback(() => editor.chain().focus().undo().run(), [editor]);
  const redo = useCallback(() => editor.chain().focus().redo().run(), [editor]);
  const print = useCallback(() => {
    if (typeof window !== 'undefined') window.print();
  }, []);
  const clearFormatting = useCallback(
    () => editor.chain().focus().unsetAllMarks().clearNodes().run(),
    [editor],
  );
  const toggleSpellcheck = useCallback(() => {
    setSpellcheckEnabled((prev) => {
      const next = !prev;
      const dom = editor.isDestroyed ? undefined : (editor.view.dom as HTMLElement | undefined);
      dom?.setAttribute('spellcheck', next ? 'true' : 'false');
      return next;
    });
  }, [editor]);

  const setParagraph = useCallback(() => {
    editor.chain().focus().setParagraph().run();
    setParagraphOpen(false);
  }, [editor]);
  const setHeading = useCallback(
    (level: HeadingLevel) => {
      editor.chain().focus().toggleHeading({ level }).run();
      setParagraphOpen(false);
    },
    [editor],
  );

  const pickFont = useCallback(
    (family: string) => {
      editor.chain().focus().setFontFamily(family).run();
      setFontOpen(false);
    },
    [editor],
  );

  const stepFontSize = useCallback(
    (delta: number) => {
      const next = Math.max(6, Math.min(96, activeFontSize + delta));
      editor.chain().focus().setFontSize(`${next}px`).run();
    },
    [editor, activeFontSize],
  );

  const bold = useCallback(() => editor.chain().focus().toggleBold().run(), [editor]);
  const italic = useCallback(() => editor.chain().focus().toggleItalic().run(), [editor]);
  const underline = useCallback(() => editor.chain().focus().toggleUnderline().run(), [editor]);
  const setColor = useCallback(
    (color: string) => {
      editor.chain().focus().setColor(color).run();
      setColorOpen(false);
    },
    [editor],
  );
  const unsetColor = useCallback(() => {
    editor.chain().focus().unsetColor().run();
    setColorOpen(false);
  }, [editor]);
  const toggleHighlight = useCallback(
    (color: string) => {
      editor.chain().focus().toggleHighlight({ color }).run();
      setHighlightOpen(false);
    },
    [editor],
  );
  const removeHighlight = useCallback(() => {
    editor.chain().focus().unsetHighlight().run();
    setHighlightOpen(false);
  }, [editor]);

  const setAlign = useCallback(
    (value: 'left' | 'center' | 'right' | 'justify') => {
      editor.chain().focus().setTextAlign(value).run();
      setAlignOpen(false);
    },
    [editor],
  );

  const applyLineHeight = useCallback(
    (value: number) => {
      setLocalLineHeight(value);
      onLineHeightChange?.(value);
      setLineSpacingOpen(false);
    },
    [onLineHeightChange],
  );

  const applyZoom = useCallback(
    (value: number) => {
      setLocalZoom(value);
      onZoomChange?.(value);
      setZoomOpen(false);
    },
    [onZoomChange],
  );
  const applyPageChrome = useCallback(
    (next: MarkdownPageChrome) => {
      setLocalPageChrome(next);
      onPageChromeChange?.(next);
    },
    [onPageChromeChange],
  );

  const bulletList = useCallback(() => editor.chain().focus().toggleBulletList().run(), [editor]);
  const orderedList = useCallback(() => editor.chain().focus().toggleOrderedList().run(), [editor]);
  const checklist = useCallback(() => {
    if (!editor.isActive('bulletList')) {
      editor.chain().focus().toggleBulletList().run();
    }
    const { $from } = editor.state.selection;
    const paragraph = $from.parent;
    if (
      paragraph.type.name === 'paragraph' &&
      !paragraph.textContent.startsWith('[ ]') &&
      !paragraph.textContent.startsWith('[x]')
    ) {
      editor.chain().focus().insertContentAt($from.start(), '[ ] ').run();
    }
  }, [editor]);
  const indent = useCallback(() => editor.chain().focus().sinkListItem('listItem').run(), [editor]);
  const outdent = useCallback(
    () => editor.chain().focus().liftListItem('listItem').run(),
    [editor],
  );

  const openLinkPopover = useCallback(() => {
    const href = (editor.getAttributes('link').href as string | undefined) ?? '';
    const { from, to } = editor.state.selection;
    setLinkUrl(href);
    setLinkText(from !== to ? editor.state.doc.textBetween(from, to) : '');
    closeAll();
    setLinkOpen(true);
  }, [editor, closeAll]);

  const submitLink = useCallback(() => {
    if (!linkUrl.trim()) {
      editor.chain().focus().unsetLink().run();
      setLinkOpen(false);
      setLinkText('');
      setLinkUrl('');
      return;
    }
    if (linkText.trim()) {
      editor
        .chain()
        .focus()
        .insertContent({
          type: 'text',
          text: linkText.trim(),
          marks: [{ type: 'link', attrs: { href: linkUrl.trim() } }],
        })
        .run();
    } else {
      editor.chain().focus().extendMarkRange('link').setLink({ href: linkUrl.trim() }).run();
    }
    setLinkOpen(false);
    setLinkText('');
    setLinkUrl('');
  }, [editor, linkText, linkUrl]);

  const submitImage = useCallback(() => {
    const url = imageUrl.trim();
    if (!url) return;
    // Insert a real @tiptap Image node (Google-Docs style); the codec
    // serializes it back to `![](src)`.
    editor.chain().focus().setImage({ src: url }).run();
    setImageUrl('');
    setImageOpen(false);
  }, [editor, imageUrl]);

  // `editor.can()` throws on a destroyed editor (v3 nulls the command manager),
  // and undo/redo commands only exist once the Yjs Collaboration extension loads
  // (StarterKit history is disabled) — calling them before that throws — so guard
  // both: when frozen the bar is inert anyway, so every "can" flag is false.
  const canChain = (frozen ? undefined : editor.can()) as
    | Record<string, (() => boolean) | undefined>
    | undefined;
  const canUndo = typeof canChain?.undo === 'function' ? canChain.undo() : false;
  const canRedo = typeof canChain?.redo === 'function' ? canChain.redo() : false;
  const canSinkListItem = !frozen && editor.can().sinkListItem('listItem');
  const canLiftListItem = !frozen && editor.can().liftListItem('listItem');

  const alignmentActive = (value: 'left' | 'center' | 'right' | 'justify') =>
    editor.isActive({ textAlign: value });

  return (
    <div
      className={`flex w-full min-w-0 flex-nowrap items-center gap-0.5 px-2 py-1.5${frozen ? ' pointer-events-none' : ''}`}
      role="toolbar"
      aria-label="Document formatting toolbar"
      aria-disabled={frozen || undefined}
      data-testid="markdown-toolbar"
    >
      <div className="flex min-w-0 items-center gap-0.5">
        {/* Tier B — undo/redo/print/spell, then zoom/page setup */}
        <div className="flex items-center gap-0.5">
          <div className={`items-center gap-0.5 ${showUndo ? 'flex' : 'hidden'}`}>
          <Btn disabled={readOnly || !canUndo} label="Undo" onClick={undo}>
            <ArrowCounterClockwiseIcon className="h-4 w-4" weight="regular" aria-hidden />
          </Btn>
          <Btn disabled={readOnly || !canRedo} label="Redo" onClick={redo}>
            <ArrowClockwiseIcon className="h-4 w-4" weight="regular" aria-hidden />
          </Btn>
          <Btn label="Print" onClick={print}>
            <PrinterIcon className="h-4 w-4" weight="regular" aria-hidden />
          </Btn>
          <Btn
            active={spellcheckEnabled}
            label="Spelling and grammar check"
            onClick={toggleSpellcheck}
          >
            <span className="relative inline-flex items-center justify-center">
              <TextAaIcon className="h-4 w-4" weight="regular" aria-hidden />
              <CheckIcon
                className="absolute -bottom-1 -right-1 h-2.5 w-2.5"
                weight="bold"
                aria-hidden
              />
            </span>
          </Btn>
          </div>

          <div className={`items-center gap-0.5 ${showZoom ? 'flex' : 'hidden'}`}>
          <Sep />

          <div className="relative">
            <DropdownBtn
              label="Zoom"
              anchorRef={zoomRef}
              open={zoomOpen}
              onToggle={() => {
                const wasOpen = zoomOpen;
                closeAll();
                setZoomOpen(!wasOpen);
              }}
              minWidth="4.5rem"
            >
              <span>{zoom}%</span>
              <CaretDownIcon className="h-3 w-3" weight="regular" aria-hidden />
            </DropdownBtn>
            <Popover open={zoomOpen} onClose={() => setZoomOpen(false)} anchorRef={zoomRef}>
              {ZOOM_LEVELS.map((value) => (
                <DropdownItem key={value} active={value === zoom} onClick={() => applyZoom(value)}>
                  {value}%
                </DropdownItem>
              ))}
            </Popover>
          </div>
          <div className="relative">
            <Btn
              ref={pageRef}
              active={pageOpen}
              open={pageOpen}
              label="Page setup"
              onClick={() => {
                const wasOpen = pageOpen;
                closeAll();
                setPageOpen(!wasOpen);
              }}
            >
              <RowsIcon className="h-4 w-4" weight="regular" aria-hidden />
            </Btn>
            <Popover open={pageOpen} onClose={() => setPageOpen(false)} anchorRef={pageRef}>
              <div className="p-1">
                {(['narrow', 'normal', 'wide'] as const).map((margin) => (
                  <DropdownItem
                    key={margin}
                    active={effectivePageChrome.margin === margin}
                    onClick={() => applyPageChrome({ ...effectivePageChrome, margin })}
                  >
                    {margin[0].toUpperCase() + margin.slice(1)} margins
                  </DropdownItem>
                ))}
                <div className="my-1 h-px bg-stone-100" />
                <DropdownItem
                  active={effectivePageChrome.header}
                  onClick={() =>
                    applyPageChrome({ ...effectivePageChrome, header: !effectivePageChrome.header })
                  }
                >
                  Header
                </DropdownItem>
                <DropdownItem
                  active={effectivePageChrome.footer}
                  onClick={() =>
                    applyPageChrome({ ...effectivePageChrome, footer: !effectivePageChrome.footer })
                  }
                >
                  Footer
                </DropdownItem>
              </div>
            </Popover>
          </div>
          </div>
        </div>

        {/* Tier C — paragraph / font / font-size, each revealed in turn */}
        <div className="flex items-center gap-0.5">
          <div className={`items-center gap-0.5 ${showParagraph ? 'flex' : 'hidden'}`}>
          <Sep />

          <div className="relative">
            <DropdownBtn
              disabled={readOnly}
              label="Paragraph"
              anchorRef={paragraphRef}
              open={paragraphOpen}
              onToggle={() => {
                const wasOpen = paragraphOpen;
                closeAll();
                setParagraphOpen(!wasOpen);
              }}
              minWidth="7.5rem"
            >
              <span>
                {headingLevel === 1
                  ? 'Heading 1'
                  : headingLevel === 2
                    ? 'Heading 2'
                    : headingLevel === 3
                      ? 'Heading 3'
                      : 'Normal text'}
              </span>
              <CaretDownIcon className="h-3 w-3" weight="regular" aria-hidden />
            </DropdownBtn>
            <Popover
              open={paragraphOpen}
              onClose={() => setParagraphOpen(false)}
              anchorRef={paragraphRef}
            >
              <DropdownItem active={!headingLevel} onClick={setParagraph}>
                Normal text
              </DropdownItem>
              {([1, 2, 3] as HeadingLevel[]).map((level) => (
                <DropdownItem
                  key={level}
                  active={headingLevel === level}
                  onClick={() => setHeading(level)}
                >
                  <span
                    style={{
                      fontSize: level === 1 ? '18px' : level === 2 ? '15px' : '13px',
                      fontWeight: 600,
                    }}
                  >
                    Heading {level}
                  </span>
                </DropdownItem>
              ))}
            </Popover>
          </div>
          </div>

          <div className={`items-center gap-0.5 ${showFont ? 'flex' : 'hidden'}`}>
          <Sep />

          <div className="relative">
            <DropdownBtn
              disabled={readOnly}
              label="Font"
              anchorRef={fontRef}
              open={fontOpen}
              onToggle={() => {
                const wasOpen = fontOpen;
                closeAll();
                setFontOpen(!wasOpen);
              }}
              minWidth="7rem"
            >
              <span className="truncate" style={{ fontFamily: activeFontFamily }}>
                {activeFontFamily}
              </span>
              <CaretDownIcon className="h-3 w-3 shrink-0" weight="regular" aria-hidden />
            </DropdownBtn>
            <Popover open={fontOpen} onClose={() => setFontOpen(false)} anchorRef={fontRef}>
              {FONT_FAMILIES.map((family) => (
                <DropdownItem
                  key={family}
                  active={family === activeFontFamily}
                  onClick={() => pickFont(family)}
                >
                  <span style={{ fontFamily: family }}>{family}</span>
                </DropdownItem>
              ))}
            </Popover>
          </div>
          </div>

          <div className={`items-center gap-0.5 ${showFontSize ? 'flex' : 'hidden'}`}>
          <Sep />

          <Btn disabled={readOnly} label="Smaller" onClick={() => stepFontSize(-1)}>
            <MinusIcon className="h-3.5 w-3.5" weight="bold" aria-hidden />
          </Btn>
          <div
            className="inline-flex h-7 w-9 items-center justify-center rounded border border-stone-300 bg-white text-[12px] tabular-nums text-stone-800"
            aria-label="Font size"
            data-toolbar-font-size
          >
            {activeFontSize}
          </div>
          <Btn disabled={readOnly} label="Larger" onClick={() => stepFontSize(1)}>
            <PlusIcon className="h-3.5 w-3.5" weight="bold" aria-hidden />
          </Btn>
          </div>
        </div>

        {/* Tier D — text marks, then link / image */}
        <div className="flex items-center gap-0.5">
          <div className={`items-center gap-0.5 ${showMarks ? 'flex' : 'hidden'}`}>
          <Sep />

          <Btn
            active={editor.isActive('bold')}
            disabled={readOnly}
            label="Bold"
            onClick={bold}
          >
            <TextBIcon className="h-4 w-4" weight="bold" aria-hidden />
          </Btn>
          <Btn
            active={editor.isActive('italic')}
            disabled={readOnly}
            label="Italic"
            onClick={italic}
          >
            <TextItalicIcon className="h-4 w-4" weight="regular" aria-hidden />
          </Btn>
          <Btn
            active={editor.isActive('underline')}
            disabled={readOnly}
            label="Underline"
            onClick={underline}
          >
            <TextUnderlineIcon className="h-4 w-4" weight="regular" aria-hidden />
          </Btn>

          <div className="relative">
            <Btn
              ref={colorRef}
              active={colorOpen}
              open={colorOpen}
              disabled={readOnly}
              label="Text color"
              onClick={() => {
                const wasOpen = colorOpen;
                closeAll();
                setColorOpen(!wasOpen);
              }}
            >
              <span className="relative flex flex-col items-center">
                <TextAaIcon className="h-4 w-4" weight="regular" aria-hidden />
                <span
                  className="mt-0.5 h-[3px] w-3.5 rounded-sm"
                  style={{
                    backgroundColor:
                      (editor.getAttributes('textStyle').color as string | undefined) ?? '#1c1917',
                  }}
                />
              </span>
            </Btn>
            <Popover open={colorOpen} onClose={() => setColorOpen(false)} anchorRef={colorRef}>
              <div className="p-1">
                <SwatchGrid
                  colors={TEXT_COLORS}
                  onPick={setColor}
                  ariaPrefix="Set text color"
                  gridClass="grid-cols-5"
                  onRemove={unsetColor}
                  removeLabel="Remove color"
                />
              </div>
            </Popover>
          </div>

          <div className="relative">
            <Btn
              ref={highlightRef}
              active={highlightOpen || editor.isActive('highlight')}
              open={highlightOpen}
              disabled={readOnly}
              label="Highlight"
              onClick={() => {
                const wasOpen = highlightOpen;
                closeAll();
                setHighlightOpen(!wasOpen);
              }}
            >
              <HighlighterIcon className="h-4 w-4" weight="regular" aria-hidden />
            </Btn>
            <Popover
              open={highlightOpen}
              onClose={() => setHighlightOpen(false)}
              anchorRef={highlightRef}
            >
              <div className="p-1">
                <SwatchGrid
                  colors={HIGHLIGHT_COLORS}
                  onPick={toggleHighlight}
                  ariaPrefix="Apply highlight"
                  gridClass="grid-cols-4"
                  onRemove={removeHighlight}
                  removeLabel="Remove highlight"
                />
              </div>
            </Popover>
          </div>
          </div>

          <div className={`items-center gap-0.5 ${showLink ? 'flex' : 'hidden'}`}>
          <Sep />

          <div className="relative">
            <Btn
              ref={linkRef}
              active={editor.isActive('link') || linkOpen}
              open={linkOpen}
              disabled={readOnly}
              label="Link"
              onClick={openLinkPopover}
            >
              <LinkIcon className="h-4 w-4" weight="regular" aria-hidden />
            </Btn>
            <Popover open={linkOpen} onClose={() => setLinkOpen(false)} anchorRef={linkRef}>
              <div className="w-64 space-y-2 p-2">
                <input
                  type="url"
                  placeholder="https://example.com"
                  value={linkUrl}
                  onChange={(event) => setLinkUrl(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') submitLink();
                  }}
                  className="w-full rounded border border-stone-200 px-2 py-1.5 text-[12px] outline-none focus:border-stone-400"
                  autoFocus
                  data-toolbar-link-url
                />
                <input
                  type="text"
                  placeholder="Link text (optional)"
                  value={linkText}
                  onChange={(event) => setLinkText(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') submitLink();
                  }}
                  className="w-full rounded border border-stone-200 px-2 py-1.5 text-[12px] outline-none focus:border-stone-400"
                />
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onMouseDown={(event) => {
                      event.preventDefault();
                      submitLink();
                    }}
                    className="rounded bg-stone-800 px-2.5 py-1 text-[11px] font-medium text-white hover:bg-stone-700"
                    data-toolbar-link-apply
                  >
                    Apply
                  </button>
                  {editor.isActive('link') && (
                    <button
                      type="button"
                      onMouseDown={(event) => {
                        event.preventDefault();
                        editor.chain().focus().unsetLink().run();
                        setLinkOpen(false);
                      }}
                      className="rounded px-2 py-1 text-[11px] text-red-600 hover:bg-red-50"
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>
            </Popover>
          </div>

          <div className="relative">
            <Btn
              ref={imageRef}
              active={imageOpen}
              open={imageOpen}
              disabled={readOnly}
              label="Image"
              onClick={() => {
                const wasOpen = imageOpen;
                closeAll();
                setImageOpen(!wasOpen);
              }}
            >
              <ImageIcon className="h-4 w-4" weight="regular" aria-hidden />
            </Btn>
            <Popover open={imageOpen} onClose={() => setImageOpen(false)} anchorRef={imageRef}>
              <ImageInsertField value={imageUrl} onChange={setImageUrl} onSubmit={submitImage} />
            </Popover>
          </div>
          </div>
        </div>

        {/* Tier E — align/spacing, lists, indent, clear; each revealed in turn */}
        <div className="flex items-center gap-0.5">
          <div className={`items-center gap-0.5 ${showAlign ? 'flex' : 'hidden'}`}>
          <Sep />

          {/* Alignment: dropdown when collapsed, 4 inline buttons when wide */}
          <div className={`relative ${showAlignButtons ? 'hidden' : ''}`}>
            <DropdownBtn
              disabled={readOnly}
              label="Align"
              anchorRef={alignRef}
              open={alignOpen}
              onToggle={() => {
                const wasOpen = alignOpen;
                closeAll();
                setAlignOpen(!wasOpen);
              }}
              minWidth="2.5rem"
            >
              {alignmentActive('center') ? (
                <TextAlignCenterIcon className="h-4 w-4" weight="regular" aria-hidden />
              ) : alignmentActive('right') ? (
                <TextAlignRightIcon className="h-4 w-4" weight="regular" aria-hidden />
              ) : alignmentActive('justify') ? (
                <TextAlignJustifyIcon className="h-4 w-4" weight="regular" aria-hidden />
              ) : (
                <TextAlignLeftIcon className="h-4 w-4" weight="regular" aria-hidden />
              )}
              <CaretDownIcon className="h-3 w-3" weight="regular" aria-hidden />
            </DropdownBtn>
            <Popover open={alignOpen} onClose={() => setAlignOpen(false)} anchorRef={alignRef}>
              <DropdownItem active={alignmentActive('left')} onClick={() => setAlign('left')}>
                <TextAlignLeftIcon className="h-4 w-4" weight="regular" aria-hidden /> Left
              </DropdownItem>
              <DropdownItem active={alignmentActive('center')} onClick={() => setAlign('center')}>
                <TextAlignCenterIcon className="h-4 w-4" weight="regular" aria-hidden /> Center
              </DropdownItem>
              <DropdownItem active={alignmentActive('right')} onClick={() => setAlign('right')}>
                <TextAlignRightIcon className="h-4 w-4" weight="regular" aria-hidden /> Right
              </DropdownItem>
              <DropdownItem active={alignmentActive('justify')} onClick={() => setAlign('justify')}>
                <TextAlignJustifyIcon className="h-4 w-4" weight="regular" aria-hidden /> Justify
              </DropdownItem>
            </Popover>
          </div>
          <div className={`items-center gap-0.5 ${showAlignButtons ? 'flex' : 'hidden'}`}>
            <Btn
              active={alignmentActive('left')}
              disabled={readOnly}
              label="Align left"
              onClick={() => setAlign('left')}
            >
              <TextAlignLeftIcon className="h-4 w-4" weight="regular" aria-hidden />
            </Btn>
            <Btn
              active={alignmentActive('center')}
              disabled={readOnly}
              label="Align center"
              onClick={() => setAlign('center')}
            >
              <TextAlignCenterIcon className="h-4 w-4" weight="regular" aria-hidden />
            </Btn>
            <Btn
              active={alignmentActive('right')}
              disabled={readOnly}
              label="Align right"
              onClick={() => setAlign('right')}
            >
              <TextAlignRightIcon className="h-4 w-4" weight="regular" aria-hidden />
            </Btn>
            <Btn
              active={alignmentActive('justify')}
              disabled={readOnly}
              label="Justify"
              onClick={() => setAlign('justify')}
            >
              <TextAlignJustifyIcon className="h-4 w-4" weight="regular" aria-hidden />
            </Btn>
          </div>

          <div className="relative">
            <DropdownBtn
              disabled={readOnly}
              label="Spacing"
              anchorRef={lineSpacingRef}
              open={lineSpacingOpen}
              onToggle={() => {
                const wasOpen = lineSpacingOpen;
                closeAll();
                setLineSpacingOpen(!wasOpen);
              }}
              minWidth="2.5rem"
            >
              <RowsIcon className="h-4 w-4" weight="regular" aria-hidden />
              <CaretDownIcon className="h-3 w-3" weight="regular" aria-hidden />
            </DropdownBtn>
            <Popover
              open={lineSpacingOpen}
              onClose={() => setLineSpacingOpen(false)}
              anchorRef={lineSpacingRef}
            >
              {LINE_HEIGHTS.map((value) => (
                <DropdownItem
                  key={value}
                  active={Math.abs(lineHeight - value) < 0.01}
                  onClick={() => applyLineHeight(value)}
                >
                  {value.toFixed(2).replace(/\.?0+$/, '')}
                </DropdownItem>
              ))}
            </Popover>
          </div>
          </div>

          <div className={`items-center gap-0.5 ${showLists ? 'flex' : 'hidden'}`}>
          <Sep />

          <Btn
            active={
              editor.isActive('bulletList') &&
              editor.state.selection.$from.parent.textContent.startsWith('[')
            }
            disabled={readOnly}
            label="Checklist"
            onClick={checklist}
          >
            <ListChecksIcon className="h-4 w-4" weight="regular" aria-hidden />
          </Btn>
          <Btn
            active={editor.isActive('bulletList')}
            disabled={readOnly}
            label="Bullets"
            onClick={bulletList}
          >
            <ListBulletsIcon className="h-4 w-4" weight="regular" aria-hidden />
          </Btn>
          <Btn
            active={editor.isActive('orderedList')}
            disabled={readOnly}
            label="Numbered"
            onClick={orderedList}
          >
            <ListNumbersIcon className="h-4 w-4" weight="regular" aria-hidden />
          </Btn>
          </div>

          <div className={`items-center gap-0.5 ${showIndent ? 'flex' : 'hidden'}`}>
          <Sep />

          <Btn disabled={readOnly || !canLiftListItem} label="Outdent" onClick={outdent}>
            <TextOutdentIcon className="h-4 w-4" weight="regular" aria-hidden />
          </Btn>
          <Btn disabled={readOnly || !canSinkListItem} label="Indent" onClick={indent}>
            <TextIndentIcon className="h-4 w-4" weight="regular" aria-hidden />
          </Btn>
          </div>

          <div className={`items-center gap-0.5 ${showClear ? 'flex' : 'hidden'}`}>
          <Sep />

          <Btn disabled={readOnly} label="Clear formatting" onClick={clearFormatting}>
            <EraserIcon className="h-4 w-4" weight="regular" aria-hidden />
          </Btn>
          </div>
        </div>
      </div>

      {/* Overflow — only renders items hidden by the current tier; hidden entirely when nothing's hidden */}
      {showOverflow && (
        <div className="relative ml-auto shrink-0 pl-1.5">
          <Btn
            ref={overflowRef}
            active={overflowOpen}
            open={overflowOpen}
            disabled={readOnly}
            label="More"
            onClick={() => {
              const wasOpen = overflowOpen;
              closeAll();
              setOverflowOpen(!wasOpen);
            }}
          >
            <DotsThreeVerticalIcon className="h-4 w-4" weight="bold" aria-hidden />
          </Btn>
          <Popover
            open={overflowOpen}
            onClose={() => setOverflowOpen(false)}
            anchorRef={overflowRef}
            align="right"
          >
            <div className="w-64">
              {!showUndo && (
                <>
                  <DropdownItem onClick={() => { undo(); setOverflowOpen(false); }}>
                    <ArrowCounterClockwiseIcon className="h-4 w-4" aria-hidden /> Undo
                  </DropdownItem>
                  <DropdownItem onClick={() => { redo(); setOverflowOpen(false); }}>
                    <ArrowClockwiseIcon className="h-4 w-4" aria-hidden /> Redo
                  </DropdownItem>
                  <DropdownItem onClick={() => { print(); setOverflowOpen(false); }}>
                    <PrinterIcon className="h-4 w-4" aria-hidden /> Print
                  </DropdownItem>
                  <DropdownItem
                    active={spellcheckEnabled}
                    onClick={() => { toggleSpellcheck(); setOverflowOpen(false); }}
                  >
                    <TextAaIcon className="h-4 w-4" aria-hidden /> Spelling and grammar
                  </DropdownItem>
                  <div className="my-1 border-t border-stone-200" />
                </>
              )}
              {!showMarks && (
                <>
                  <DropdownItem
                    testId="overflow-bold"
                    active={editor.isActive('bold')}
                    onClick={() => { bold(); setOverflowOpen(false); }}
                  >
                    <TextBIcon className="h-4 w-4" weight="bold" aria-hidden /> Bold
                  </DropdownItem>
                  <DropdownItem
                    active={editor.isActive('italic')}
                    onClick={() => { italic(); setOverflowOpen(false); }}
                  >
                    <TextItalicIcon className="h-4 w-4" aria-hidden /> Italic
                  </DropdownItem>
                  <DropdownItem
                    active={editor.isActive('underline')}
                    onClick={() => { underline(); setOverflowOpen(false); }}
                  >
                    <TextUnderlineIcon className="h-4 w-4" aria-hidden /> Underline
                  </DropdownItem>
                  {/* Text color / Highlight have no overflow-safe sub-popover (their
                      bar popovers are display:none when condensed), so render the
                      swatches inline to keep parity with the full bar. */}
                  {[
                    { label: 'Text color', aria: 'Set text color', colors: TEXT_COLORS, apply: setColor },
                    { label: 'Highlight', aria: 'Apply highlight', colors: HIGHLIGHT_COLORS, apply: toggleHighlight },
                  ].map(({ label, aria, colors, apply }) => (
                    <div key={label} className="px-2 pb-1 pt-1.5">
                      <div className="pb-1 text-[10px] font-medium uppercase tracking-wide text-stone-400">
                        {label}
                      </div>
                      <SwatchGrid
                        colors={colors}
                        onPick={(color) => { apply(color); setOverflowOpen(false); }}
                        ariaPrefix={aria}
                        gridClass="grid-cols-5"
                        swatchClass="h-5 w-5"
                      />
                    </div>
                  ))}
                  <div className="my-1 border-t border-stone-200" />
                </>
              )}
              {!showLink && (
                <>
                  <DropdownItem onClick={() => { openEditorLinkMenu(editor); setOverflowOpen(false); }}>
                    <LinkIcon className="h-4 w-4" aria-hidden /> Link
                  </DropdownItem>
                  <ImageInsertField
                    value={imageUrl}
                    onChange={setImageUrl}
                    onSubmit={() => { submitImage(); setOverflowOpen(false); }}
                  />
                  <div className="my-1 border-t border-stone-200" />
                </>
              )}
              {!showAlign && (
                <>
                  <DropdownItem
                    active={alignmentActive('left')}
                    onClick={() => { setAlign('left'); setOverflowOpen(false); }}
                  >
                    <TextAlignLeftIcon className="h-4 w-4" aria-hidden /> Align left
                  </DropdownItem>
                  <DropdownItem
                    active={alignmentActive('center')}
                    onClick={() => { setAlign('center'); setOverflowOpen(false); }}
                  >
                    <TextAlignCenterIcon className="h-4 w-4" aria-hidden /> Align center
                  </DropdownItem>
                  <DropdownItem
                    active={alignmentActive('right')}
                    onClick={() => { setAlign('right'); setOverflowOpen(false); }}
                  >
                    <TextAlignRightIcon className="h-4 w-4" aria-hidden /> Align right
                  </DropdownItem>
                  <DropdownItem
                    active={alignmentActive('justify')}
                    onClick={() => { setAlign('justify'); setOverflowOpen(false); }}
                  >
                    <TextAlignJustifyIcon className="h-4 w-4" aria-hidden /> Justify
                  </DropdownItem>
                  <div className="my-1 border-t border-stone-200" />
                </>
              )}
              {!showLists && (
                <>
                  <DropdownItem
                    active={editor.isActive('bulletList')}
                    onClick={() => { bulletList(); setOverflowOpen(false); }}
                  >
                    <ListBulletsIcon className="h-4 w-4" aria-hidden /> Bulleted list
                  </DropdownItem>
                  <DropdownItem
                    active={editor.isActive('orderedList')}
                    onClick={() => { orderedList(); setOverflowOpen(false); }}
                  >
                    <ListNumbersIcon className="h-4 w-4" aria-hidden /> Numbered list
                  </DropdownItem>
                  <DropdownItem onClick={() => { checklist(); setOverflowOpen(false); }}>
                    <ListChecksIcon className="h-4 w-4" aria-hidden /> Checklist
                  </DropdownItem>
                  <div className="my-1 border-t border-stone-200" />
                </>
              )}
              {!showIndent && (
                <>
                  <DropdownItem onClick={() => { indent(); setOverflowOpen(false); }}>
                    <TextIndentIcon className="h-4 w-4" aria-hidden /> Increase indent
                  </DropdownItem>
                  <DropdownItem onClick={() => { outdent(); setOverflowOpen(false); }}>
                    <TextOutdentIcon className="h-4 w-4" aria-hidden /> Decrease indent
                  </DropdownItem>
                  <div className="my-1 border-t border-stone-200" />
                </>
              )}
              {!showClear && (
                <DropdownItem onClick={() => { clearFormatting(); setOverflowOpen(false); }}>
                  <EraserIcon className="h-4 w-4" aria-hidden /> Clear formatting
                </DropdownItem>
              )}
            </div>
          </Popover>
        </div>
      )}

      {/* Collapse/expand — rightmost icon; hides the menus (rows above) but keeps the toolbar */}
      {onToggleMenus && (
        <div className={`${showOverflow ? '' : 'ml-auto'} shrink-0 pl-1`}>
          <Btn
            label={menusHidden ? 'Show menus' : 'Hide menus'}
            onClick={() => {
              closeAll();
              onToggleMenus();
            }}
          >
            {menusHidden ? (
              <CaretDownIcon className="h-4 w-4" weight="regular" aria-hidden />
            ) : (
              <CaretUpIcon className="h-4 w-4" weight="regular" aria-hidden />
            )}
          </Btn>
        </div>
      )}
    </div>
  );
}
