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
  ghost.style.cssText =
    'display:flex;align-items:center;gap:6px;padding:4px 10px;border-radius:8px;background:#f5f5f4;border:1px solid #d6d3d1;font:500 13px/1 system-ui;color:#44403c;white-space:nowrap;position:fixed;top:-100px;left:-100px;pointer-events:none;z-index:9999;';
  ghost.textContent = label;
  document.body.appendChild(ghost);
  event.dataTransfer.setDragImage(ghost, 0, 0);
  requestAnimationFrame(() => ghost.remove());
}

export function getSidebarListItemStateClasses(isSelected: boolean) {
  return isSelected
    ? 'bg-stone-300/80 text-stone-800 transition-colors'
    : 'bg-transparent text-stone-600 hover:bg-stone-200/80 hover:text-stone-800 transition-colors';
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
 * The first source file a turn changed — skipping deletions and compile
 * artifacts — i.e. what an auto-open / "open diff" should surface.
 */
export function firstEditableTurnEditPath(turn: TurnEditsResponse | null | undefined): string | null {
  return turn?.files.find((f) => !f.isDeleted && !isCompileArtifactPath(f.filePath))?.filePath ?? null;
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

function WorkspaceSvgIcon({
  className,
  toneClassName = 'text-stone-400',
  children,
  withTile = true,
}: {
  className: string;
  toneClassName?: string;
  children: ReactNode;
  withTile?: boolean;
}) {
  return (
    <svg className={`${className} ${toneClassName}`} viewBox="0 0 24 24" fill="none" aria-hidden>
      {withTile && <rect x="2.75" y="3.75" width="18.5" height="16.5" rx="4.25" fill="currentColor" opacity="0.18" />}
      <g stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
        {children}
      </g>
    </svg>
  );
}

function WorkspaceMonogramIcon({
  className,
  toneClassName,
  label,
}: {
  className: string;
  toneClassName: string;
  label: string;
}) {
  const length = label.length;
  const fontSize = length <= 1 ? 14 : length === 2 ? 10 : length === 3 ? 7.5 : 6.5;

  return (
    <svg className={`${className} ${toneClassName}`} viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="3.5" y="4.5" width="17" height="15" rx="4" fill="currentColor" opacity="0.18" />
      <text
        x="12"
        y="15"
        textAnchor="middle"
        fill="currentColor"
        fontFamily="ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif"
        fontSize={fontSize}
        fontWeight="700"
      >
        {label}
      </text>
    </svg>
  );
}

function WorkspaceFolderGlyph({ className }: { className: string }) {
  return (
    <svg className={`${className} text-stone-400`} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M3 8a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8Z" fill="currentColor" opacity="0.08" />
      <path d="M3 8a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8Z" stroke="currentColor" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function WorkspaceGitGlyph({ className }: { className: string }) {
  return (
    <WorkspaceSvgIcon className={className} toneClassName="text-sky-600">
      <circle cx="7" cy="6.5" r="1.75" />
      <circle cx="17" cy="6.5" r="1.75" />
      <circle cx="12" cy="17.5" r="1.75" />
      <path d="M8.5 7.75 11 16m4.5-8.25L13 16" />
    </WorkspaceSvgIcon>
  );
}

function WorkspaceSettingsGlyph({ className }: { className: string }) {
  return (
    <WorkspaceSvgIcon className={className} toneClassName="text-stone-500">
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" />
    </WorkspaceSvgIcon>
  );
}

function WorkspaceTableGlyph({ className }: { className: string }) {
  return (
    <WorkspaceSvgIcon className={className} toneClassName="text-emerald-600">
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <path d="M4 10h16M9.5 5v14M14.5 5v14" />
    </WorkspaceSvgIcon>
  );
}

function WorkspaceImageGlyph({ className }: { className: string }) {
  return (
    <WorkspaceSvgIcon className={className} toneClassName="text-rose-500">
      <rect x="4" y="5" width="16" height="14" rx="2" />
      <circle cx="9" cy="10" r="1.5" />
      <path d="m6 17 4-4 3 3 3-5 2 2" />
    </WorkspaceSvgIcon>
  );
}

function WorkspaceAudioGlyph({ className }: { className: string }) {
  return (
    <WorkspaceSvgIcon className={className} toneClassName="text-emerald-600">
      <path d="M4 12h2l2-4 3 8 2-6 2 4h5" />
    </WorkspaceSvgIcon>
  );
}

function WorkspaceVideoGlyph({ className }: { className: string }) {
  return (
    <WorkspaceSvgIcon className={className} toneClassName="text-rose-500">
      <rect x="4" y="6" width="16" height="12" rx="2" />
      <path d="m10 10 5 2-5 2Z" fill="currentColor" stroke="none" />
    </WorkspaceSvgIcon>
  );
}

function WorkspaceDatabaseGlyph({ className }: { className: string }) {
  return (
    <WorkspaceSvgIcon className={className} toneClassName="text-cyan-700">
      <ellipse cx="12" cy="7" rx="6.5" ry="2.5" />
      <path d="M5.5 7v10c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5V7" />
      <path d="M5.5 12c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5" />
    </WorkspaceSvgIcon>
  );
}

function WorkspaceArchiveGlyph({ className }: { className: string }) {
  return (
    <WorkspaceSvgIcon className={className} toneClassName="text-stone-600">
      <path d="M7 4h10v16H7z" />
      <path d="M10 4v4h4V4M12 8v8M10.5 10h3M10.5 13h3" />
    </WorkspaceSvgIcon>
  );
}

function WorkspaceDocumentGlyph({ className }: { className: string }) {
  return (
    <WorkspaceSvgIcon className={className} toneClassName="text-stone-400" withTile={false}>
      <path d="M7 4h7l4 4v12H7z" />
      <path d="M14 4v4h4M9 13h6M9 17h6" />
    </WorkspaceSvgIcon>
  );
}

export function WorkspaceEntryIcon({
  path,
  isFolder = false,
  className,
}: {
  path: string;
  isFolder?: boolean;
  className: string;
}) {
  if (isFolder) return <WorkspaceFolderGlyph className={className} />;

  const ext = getExtension(path);
  const lowerPath = path.toLowerCase();
  const fileName = getFileName(lowerPath);

  if (fileName === '.env') return <WorkspaceSettingsGlyph className={className} />;
  if (fileName.startsWith('.env.')) return <WorkspaceMonogramIcon className={className} toneClassName="text-emerald-600" label="$" />;
  if (fileName.startsWith('.git')) return <WorkspaceGitGlyph className={className} />;
  if (WORKSPACE_LOCKFILE_NAMES.has(fileName)) return <WorkspaceMonogramIcon className={className} toneClassName="text-stone-500" label="{}" />;
  if (isPolicyMarkdownFile(path)) return <WorkspaceMonogramIcon className={className} toneClassName="text-violet-500" label="MD" />;
  if (ext === '.py') return <WorkspaceMonogramIcon className={className} toneClassName="text-emerald-600" label="PY" />;
  if (TYPESCRIPT_EXTENSIONS.has(ext)) return <WorkspaceMonogramIcon className={className} toneClassName="text-sky-600" label="TS" />;
  if (JAVASCRIPT_EXTENSIONS.has(ext)) return <WorkspaceMonogramIcon className={className} toneClassName="text-stone-500" label="JS" />;
  if (HTML_EXTENSIONS.has(ext)) return <WorkspaceMonogramIcon className={className} toneClassName="text-orange-600" label="</>" />;
  if (STYLE_EXTENSIONS.has(ext)) return <WorkspaceMonogramIcon className={className} toneClassName="text-blue-600" label="#" />;
  if (CSV_EXTENSIONS.has(ext)) return <WorkspaceTableGlyph className={className} />;
  if (IMAGE_EXTENSIONS.has(ext)) return <WorkspaceImageGlyph className={className} />;
  if (isPolicyPdfFile(path)) return <WorkspaceMonogramIcon className={className} toneClassName="text-red-600" label="PDF" />;
  if (SLIDES_EXTENSIONS.has(ext)) return <WorkspaceMonogramIcon className={className} toneClassName="text-orange-600" label="PPT" />;
  if (WORD_EXTENSIONS.has(ext)) return <WorkspaceMonogramIcon className={className} toneClassName="text-sky-700" label="DOC" />;
  if (SPREADSHEET_EXTENSIONS.has(ext)) return <WorkspaceTableGlyph className={className} />;
  if (AUDIO_EXTENSIONS.has(ext)) return <WorkspaceAudioGlyph className={className} />;
  if (VIDEO_EXTENSIONS.has(ext)) return <WorkspaceVideoGlyph className={className} />;
  if (ext === '.sql') return <WorkspaceDatabaseGlyph className={className} />;
  if (CPP_EXTENSIONS.has(ext)) return <WorkspaceMonogramIcon className={className} toneClassName="text-sky-700" label="C++" />;
  if (CSHARP_EXTENSIONS.has(ext)) return <WorkspaceMonogramIcon className={className} toneClassName="text-emerald-600" label="C#" />;
  if (lowerPath.endsWith('/dockerfile') || lowerPath === 'dockerfile') return <WorkspaceMonogramIcon className={className} toneClassName="text-sky-600" label=">_" />;
  if (SHELL_EXTENSIONS.has(ext)) return <WorkspaceMonogramIcon className={className} toneClassName="text-lime-600" label=">_" />;
  if (ext === '.go') return <WorkspaceMonogramIcon className={className} toneClassName="text-cyan-600" label="GO" />;
  if (ext === '.rb') return <WorkspaceMonogramIcon className={className} toneClassName="text-red-600" label="RB" />;
  if (ext === '.java') return <WorkspaceMonogramIcon className={className} toneClassName="text-orange-700" label="JV" />;
  if (ext === '.rs') return <WorkspaceMonogramIcon className={className} toneClassName="text-orange-600" label="RS" />;
  if (ext === '.php') return <WorkspaceMonogramIcon className={className} toneClassName="text-indigo-500" label="PHP" />;
  if (ext === '.swift') return <WorkspaceMonogramIcon className={className} toneClassName="text-orange-500" label="SW" />;
  if (ext === '.kt' || ext === '.kts') return <WorkspaceMonogramIcon className={className} toneClassName="text-violet-600" label="KT" />;
  if (ext === '.lua') return <WorkspaceMonogramIcon className={className} toneClassName="text-blue-700" label="LUA" />;
  if (ext === '.r' || ext === '.R') return <WorkspaceMonogramIcon className={className} toneClassName="text-blue-600" label="R" />;
  if (ext === '.xml') return <WorkspaceMonogramIcon className={className} toneClassName="text-orange-600" label="XML" />;
  if (ARCHIVE_EXTENSIONS.has(ext)) return <WorkspaceArchiveGlyph className={className} />;
  if (ext === '.m') return <WorkspaceSettingsGlyph className={className} />;
  if (CONFIG_EXTENSIONS.has(ext)) return <WorkspaceMonogramIcon className={className} toneClassName="text-stone-500" label="{}" />;
  if (CODE_EXTENSIONS.has(ext)) return <WorkspaceMonogramIcon className={className} toneClassName="text-stone-500" label="</>" />;
  return <WorkspaceDocumentGlyph className={className} />;
}
