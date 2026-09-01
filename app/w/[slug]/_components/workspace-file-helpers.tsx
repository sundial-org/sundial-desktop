'use client';

import type { ReactNode } from 'react';
import { getExtension } from '@/lib/workspace/uploads';
import type { WorkspaceFileRow } from '@/lib/workspace/types';
import type { TurnEditsResponse } from '@/lib/workspace/turn-edits';
import { isIgnoredWorkspacePath } from '@/lib/workspace/ignored-paths';
import {
  isLatexDocumentFile as isPolicyLatexDocumentFile,
  isMarkdownFile as isPolicyMarkdownFile,
  isOfficePreviewFile as isPolicyOfficeFile,
  isPdfFile as isPolicyPdfFile,
} from '@/lib/sync/policy';
import { isWorkspaceMetaPath } from '@/lib/workspace/spaces';

export const WORKSPACE_ACTIONS_MENU_PATH = '__workspace_actions_menu__';
// Compact rows: one knob for file/folder row density in the Files panel.
export const SIDEBAR_ENTRY_ROW_CLASSES =
  'group flex w-full cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1 text-sm';
export const SIDEBAR_DRAFT_ROW_CLASSES =
  'flex w-full items-center gap-1.5 rounded-lg bg-stone-100/70 px-2 py-1 text-sm text-stone-800';
// Visual-only classes for the action dropdown panels; positioning is owned by
// AnchoredDropdown (fixed) so the menus escape the sidebar sections' overflow.
export const SIDEBAR_ACTION_MENU_CLASSES =
  'w-36 rounded-md border border-stone-200 bg-white py-1 text-xs shadow-lg';

const IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.avif',
  '.bmp',
  '.tif',
  '.tiff',
]);
const AUDIO_EXTENSIONS = new Set(['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.avi', '.mkv']);
const ARCHIVE_EXTENSIONS = new Set(['.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar']);
const JAVASCRIPT_EXTENSIONS = new Set(['.js', '.jsx', '.mjs', '.cjs']);
const TYPESCRIPT_EXTENSIONS = new Set(['.ts', '.tsx']);
const STYLE_EXTENSIONS = new Set(['.css', '.scss', '.sass', '.less']);
const SHELL_EXTENSIONS = new Set(['.sh', '.bash', '.zsh', '.fish']);
const CONFIG_EXTENSIONS = new Set([
  '.m',
  '.json',
  '.jsonc',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
  '.env',
  '.properties',
  '.hcl',
  '.tf',
]);
const CPP_EXTENSIONS = new Set(['.c', '.cc', '.cpp', '.cxx', '.h', '.hpp']);
const CSHARP_EXTENSIONS = new Set(['.cs']);
const CSV_EXTENSIONS = new Set(['.csv', '.tsv']);
const SLIDES_EXTENSIONS = new Set(['.ppt', '.pptx', '.odp']);
const WORD_EXTENSIONS = new Set(['.doc', '.docx', '.odt']);
const SPREADSHEET_EXTENSIONS = new Set(['.xls', '.xlsx', '.ods']);
const JSON_EXTENSIONS = new Set(['.json']);
const HTML_EXTENSIONS = new Set(['.html', '.htm']);
const WORKSPACE_LOCKFILE_NAMES = new Set(['bun.lock', 'bun.lockb', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']);
const CODE_FILENAMES = new Set(['dockerfile', 'makefile', 'gnumakefile', '.gitignore', '.dockerignore', '.editorconfig']);
const CODE_EXTENSIONS = new Set([
  '.py',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.json',
  '.jsonc',
  '.yaml',
  '.yml',
  '.toml',
  '.ini',
  '.cfg',
  '.conf',
  '.sql',
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.env',
  '.txt',
  '.log',
  '.go',
  '.rs',
  '.java',
  '.c',
  '.cpp',
  '.cc',
  '.cxx',
  '.h',
  '.hpp',
  '.cs',
  '.rb',
  '.php',
  '.swift',
  '.kt',
  '.kts',
  '.r',
  '.R',
  '.lua',
  '.scala',
  '.dart',
  '.ex',
  '.exs',
  '.erl',
  '.clj',
  '.zig',
  '.sol',
  '.pl',
  '.pm',
  '.html',
  '.htm',
  '.css',
  '.scss',
  '.less',
  '.xml',
  '.graphql',
  '.gql',
  '.dockerfile',
  '.tf',
  '.hcl',
  '.properties',
]);

export function getFileName(path: string) {
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

export function getFolderPath(path: string) {
  const parts = path.split('/');
  if (parts.length <= 1) return null;
  return parts.slice(0, -1).join('/');
}

export function getAncestorFolders(path: string) {
  const parts = path.split('/');
  if (parts.length <= 1) return [];
  const folders: string[] = [];
  for (let i = 1; i < parts.length; i += 1) {
    folders.push(parts.slice(0, i).join('/'));
  }
  return folders;
}

export function formatFileName(name: string) {
  // Show the extension for markdown like every other file type (.tex, .py, …)
  // so the sidebar/breadcrumbs read consistently.
  return name;
}

// Explicit drag ghost for sidebar entries. The browser's default drag image
// snapshots the row's bounding box inflated by its absolutely-positioned hover
// tooltips/menus, so neighboring rows bleed into the ghost.
export function setSidebarDragGhost(event: { dataTransfer: DataTransfer }, label: string) {
  const ghost = document.createElement('div');
  // Literal colors (the ghost is rasterized before CSS vars from a class
  // would resolve) — pick the palette by the applied theme class so the
  // ghost isn't a glaring light chip on a dark desk.
  const dark = document.documentElement.classList.contains('dark');
  const palette = dark
    ? 'background:#2a2723;border:1px solid #44403c;color:#d6d3d1;'
    : 'background:#f5f5f4;border:1px solid #d6d3d1;color:#44403c;';
  ghost.style.cssText =
    `display:flex;align-items:center;gap:6px;padding:4px 10px;border-radius:8px;${palette}font:500 13px/1 system-ui;white-space:nowrap;position:fixed;top:-100px;left:-100px;pointer-events:none;z-index:9999;`;
  ghost.textContent = label;
  document.body.appendChild(ghost);
  event.dataTransfer.setDragImage(ghost, 0, 0);
  requestAnimationFrame(() => ghost.remove());
}

export function getSidebarListItemStateClasses(isSelected: boolean, isHovered?: boolean) {
  if (isSelected) return 'bg-stone-300/80 text-stone-800 transition-colors';
  // JS-tracked hover (files tree): Chromium strands CSS :hover on a row across
  // window switches, so rows that track the pointer pass the state explicitly.
  if (isHovered !== undefined)
    return isHovered
      ? 'bg-stone-200/80 text-stone-800 transition-colors'
      : 'bg-transparent text-stone-600 transition-colors';
  return 'bg-transparent text-stone-600 hover:bg-stone-200/80 hover:text-stone-800 transition-colors';
}

export function formatRelativeTime(value?: string | null) {
  if (!value) return 'just now';
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return 'just now';
  const diffMs = Date.now() - timestamp;
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return `${weeks} week${weeks === 1 ? '' : 's'} ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  const years = Math.floor(days / 365);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

export function isMetaPath(path: string) {
  // `.synctex.gz` is a compile artifact the viewer fetches by path for
  // click-to-source — hide it from the file tree (it's not an `ignored_path`,
  // so `files/download` can still serve it), like Overleaf does.
  return (
    isIgnoredWorkspacePath(path) ||
    isWorkspaceMetaPath(path) ||
    path.toLowerCase().endsWith('.synctex.gz')
  );
}

/**
 * Agent operating files — the root `AGENTS.md` instructions file, the
 * `skills/` and `logs/` trees, and hidden dotfiles/dot-folders (`.github/`,
 * `.gitignore`, …). Visible by default; the Files section's eye toggle hides
 * them to declutter the tree. AGENTS.md/skills/logs are root-level only: a
 * nested `notes/skills/…` is ordinary content.
 */
export function isAgentMetadataPath(path: string) {
  const normalized = path.replace(/^\/+/, '');
  return (
    normalized === 'AGENTS.md' ||
    normalized === 'skills' ||
    normalized.startsWith('skills/') ||
    normalized === 'logs' ||
    normalized.startsWith('logs/') ||
    normalized.split('/').some((segment) => segment.startsWith('.'))
  );
}

const COMPILE_ARTIFACT_RE = /(\.(aux|bbl|blg|fdb_latexmk|fls|log|nav|out|pdf|snm|toc|vrb)|\.synctex\.gz)$/i;

/**
 * Build byproducts (`.log`, `.pdf`, `.aux`, `.synctex.gz`, …). The agent's
 * compile records these as turn edits, but auto-surfacing an edit should jump
 * to the *source* it changed — never a generated artifact.
 */
export function isCompileArtifactPath(path: string): boolean {
  return COMPILE_ARTIFACT_RE.test(path);
}


/**
 * `binary` and `blob_ref` are both stored-bytes types — only the storage
 * mechanism differs. Treat them the same for preview routing so files that
 * happen to land as `blob_ref` (e.g. dedup'd uploads) still get the right
 * viewer.
 */
export function isBinaryFile(file: WorkspaceFileRow | null) {
  if (!file) return false;
  return file.type === 'binary' || file.type === 'blob_ref';
}

export function isImageFile(file: WorkspaceFileRow | null) {
  if (!isBinaryFile(file)) return false;
  if (file!.mime?.startsWith('image/')) return true;
  return IMAGE_EXTENSIONS.has(getExtension(file!.path));
}

export function isPdfFile(file: WorkspaceFileRow | null) {
  if (!isBinaryFile(file)) return false;
  return isPolicyPdfFile(file!.path, file!.mime);
}

/** Office documents (slides/doc/sheet) previewable via LibreOffice → PDF conversion. */
export function isOfficeFile(file: WorkspaceFileRow | null) {
  if (!isBinaryFile(file)) return false;
  return isPolicyOfficeFile(file!.path, file!.mime);
}

export function isTexFile(file: WorkspaceFileRow | null) {
  if (!file) return false;
  if (file.type !== 'text') return false;
  return isPolicyLatexDocumentFile(file.path, file.mime);
}

export function isCodeFile(file: WorkspaceFileRow | null) {
  if (!file) return false;
  if (file.type !== 'text') return false;
  const ext = getExtension(file.path);
  if (CODE_EXTENSIONS.has(ext)) return true;
  const fileName = getFileName(file.path).toLowerCase();
  if (CODE_FILENAMES.has(fileName)) return true;
  if (isPolicyMarkdownFile(file.path)) return false;
  return true;
}

export function isMarkdownFile(file: WorkspaceFileRow | null) {
  if (!file) return false;
  if (file.type !== 'text') return false;
  return isPolicyMarkdownFile(file.path);
}

export function isCsvFile(file: WorkspaceFileRow | null) {
  if (!file) return false;
  if (file.type !== 'text') return false;
  return CSV_EXTENSIONS.has(getExtension(file.path));
}

export function isJsonFile(file: WorkspaceFileRow | null) {
  if (!file) return false;
  if (file.type !== 'text') return false;
  return JSON_EXTENSIONS.has(getExtension(file.path));
}

export function isHtmlFile(file: WorkspaceFileRow | null) {
  if (!file) return false;
  if (file.type !== 'text') return false;
  return HTML_EXTENSIONS.has(getExtension(file.path));
}

export function shouldDefaultRichViewer(file: WorkspaceFileRow | null) {
  return isCsvFile(file) || isHtmlFile(file);
}

/** Wireframe share glyph: person + filled dot = shared, live-synced. */
export function SharedLiveGlyph({ className }: { className: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" aria-hidden>
      <g stroke="currentColor" strokeWidth={1.3}>
        <circle cx="7" cy="5.5" r="2.4" />
        <path d="M2.5 13.5c.6-2.7 2.3-4 4.5-4s3.9 1.3 4.5 4" />
      </g>
      <circle cx="12.5" cy="12.5" r="2.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Wireframe local-origin glyph: a device ("On this device"). */
export function LocalRootGlyph({ className }: { className: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.3} aria-hidden>
      <rect x="2.5" y="3.5" width="11" height="7.5" rx="1" />
      <path d="M1.5 13h13" />
    </svg>
  );
}

/** Wireframe workspace glyph: two overlapping rounded squares. */
export function WorkspaceRootGlyph({ className }: { className: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinejoin="round" aria-hidden>
      <rect x="1.8" y="5.3" width="8.9" height="8.9" rx="1.4" />
      <path d="M5.3 5.3V3.6a1.4 1.4 0 0 1 1.4-1.4h6a1.4 1.4 0 0 1 1.4 1.4v6a1.4 1.4 0 0 1-1.4 1.4h-1.7" />
    </svg>
  );
}

/** Wireframe thin-line icon language (prototypes/desktop): 16-grid, 1.3
 *  stroke, monochrome — exact types collapse into a few calm glyph families. */
function WireGlyph({ className, children }: { className: string; children: ReactNode }) {
  return (
    <svg
      className={/\btext-/.test(className) ? className : `${className} text-stone-400`}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  );
}

function WireDocGlyph({ className, children }: { className: string; children?: ReactNode }) {
  return (
    <WireGlyph className={className}>
      <path d="M4 2h5l3 3v9H4z" />
      <path d="M9 2v3h3" />
      {children}
    </WireGlyph>
  );
}

const CODE_LANG_EXTENSIONS = new Set(['.py', '.go', '.rb', '.java', '.rs', '.php', '.swift', '.kt', '.kts', '.lua', '.r', '.xml']);

export function WorkspaceEntryIcon({
  path,
  isFolder = false,
  className,
}: {
  path: string;
  isFolder?: boolean;
  className: string;
}) {
  if (isFolder) {
    return (
      <WireGlyph className={className}>
        <path d="M2 4.5h4l1.4 1.6H14v6.4H2z" />
      </WireGlyph>
    );
  }

  const ext = getExtension(path);
  const lowerPath = path.toLowerCase();
  const fileName = getFileName(lowerPath);

  if (fileName === '.env' || fileName.startsWith('.env.') || ext === '.m') {
    return (
      <WireGlyph className={className}>
        <circle cx="8" cy="8" r="2" />
        <path d="M8 2.5v2M8 11.5v2M2.5 8h2M11.5 8h2M4.1 4.1l1.4 1.4M10.5 10.5l1.4 1.4M11.9 4.1l-1.4 1.4M5.5 10.5l-1.4 1.4" />
      </WireGlyph>
    );
  }
  if (fileName.startsWith('.git')) {
    return (
      <WireGlyph className={className}>
        <circle cx="4.5" cy="4" r="1.2" />
        <circle cx="11.5" cy="4" r="1.2" />
        <circle cx="8" cy="12" r="1.2" />
        <path d="M5.5 5 7.3 10.9M10.5 5 8.7 10.9" />
      </WireGlyph>
    );
  }
  if (WORKSPACE_LOCKFILE_NAMES.has(fileName) || CONFIG_EXTENSIONS.has(ext)) {
    return (
      <WireGlyph className={className}>
        <path d="M6.2 2.8c-1.5.3-1.1 2-1.1 3.2S3.4 8 3.4 8s1.7.8 1.7 2-.4 2.9 1.1 3.2M9.8 2.8c1.5.3 1.1 2 1.1 3.2S12.6 8 12.6 8s-1.7.8-1.7 2 .4 2.9-1.1 3.2" />
      </WireGlyph>
    );
  }
  if (ext === '.tex') {
    return (
      <WireDocGlyph className={className}>
        <path d="M6.1 9h4M7.2 9v2.7M9.4 9v2.7" />
      </WireDocGlyph>
    );
  }
  if (ext === '.ipynb') {
    return (
      <WireGlyph className={className}>
        <rect x="4.3" y="2.3" width="8.2" height="11.4" rx="1.2" />
        <path d="M2.6 4.6h1.7M2.6 8h1.7M2.6 11.4h1.7M7 5.4h3.2M7 8h3.2" />
      </WireGlyph>
    );
  }
  if (CSV_EXTENSIONS.has(ext) || SPREADSHEET_EXTENSIONS.has(ext)) {
    return (
      <WireGlyph className={className}>
        <rect x="2.5" y="3.5" width="11" height="9" rx="1" />
        <path d="M2.5 7h11M6.5 3.5v9M10 3.5v9" />
      </WireGlyph>
    );
  }
  if (IMAGE_EXTENSIONS.has(ext)) {
    return (
      <WireGlyph className={className}>
        <rect x="2.5" y="3.5" width="11" height="9" rx="1" />
        <circle cx="5.6" cy="6.2" r="1" />
        <path d="m4 11.2 3-3 2 2 2.4-2.8 2.1 2.4" />
      </WireGlyph>
    );
  }
  if (isPolicyPdfFile(path) || WORD_EXTENSIONS.has(ext) || SLIDES_EXTENSIONS.has(ext)) {
    return (
      <WireDocGlyph className={className}>
        <path d="M6 8.6h4M6 10.8h4" />
      </WireDocGlyph>
    );
  }
  if (AUDIO_EXTENSIONS.has(ext)) {
    return (
      <WireGlyph className={className}>
        <path d="M2.5 8h1.3l1.4-2.7 2 5.4 1.4-4 1.3 2.7h3.6" />
      </WireGlyph>
    );
  }
  if (VIDEO_EXTENSIONS.has(ext)) {
    return (
      <WireGlyph className={className}>
        <rect x="2.5" y="4" width="11" height="8" rx="1" />
        <path d="m6.8 6.4 3.4 1.6-3.4 1.6z" />
      </WireGlyph>
    );
  }
  if (ext === '.sql') {
    return (
      <WireGlyph className={className}>
        <ellipse cx="8" cy="4.4" rx="4.4" ry="1.7" />
        <path d="M3.6 4.4v7.2c0 .9 2 1.7 4.4 1.7s4.4-.8 4.4-1.7V4.4" />
        <path d="M3.6 8c0 .9 2 1.7 4.4 1.7S12.4 8.9 12.4 8" />
      </WireGlyph>
    );
  }
  if (ARCHIVE_EXTENSIONS.has(ext)) {
    return (
      <WireGlyph className={className}>
        <path d="M4.6 2.5h6.8v11H4.6z" />
        <path d="M6.6 2.5v2.7h2.8V2.5M8 5.2v5.4M7 6.6h2M7 8.6h2" />
      </WireGlyph>
    );
  }
  if (lowerPath.endsWith('/dockerfile') || lowerPath === 'dockerfile' || SHELL_EXTENSIONS.has(ext)) {
    return (
      <WireGlyph className={className}>
        <path d="m3 5 3 3-3 3M8.5 11.5H13" />
      </WireGlyph>
    );
  }
  // CODE_EXTENSIONS is the "opens in the code editor" set — .txt/.log belong
  // there but read as documents, not code, in the tree.
  if (ext === '.txt' || ext === '.log') return <WireDocGlyph className={className} />;
  if (
    TYPESCRIPT_EXTENSIONS.has(ext) ||
    JAVASCRIPT_EXTENSIONS.has(ext) ||
    HTML_EXTENSIONS.has(ext) ||
    STYLE_EXTENSIONS.has(ext) ||
    CPP_EXTENSIONS.has(ext) ||
    CSHARP_EXTENSIONS.has(ext) ||
    CODE_EXTENSIONS.has(ext) ||
    CODE_LANG_EXTENSIONS.has(ext)
  ) {
    return (
      <WireGlyph className={className}>
        <path d="M5 5.4 2.6 8 5 10.6M11 5.4 13.4 8 11 10.6M9.2 4.2 6.8 11.8" />
      </WireGlyph>
    );
  }
  return <WireDocGlyph className={className} />;
}
