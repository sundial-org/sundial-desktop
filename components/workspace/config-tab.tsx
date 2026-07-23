'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type * as Y from 'yjs';
import { WorkspaceSecretsManager } from '@/components/workspace/workspace-secrets-manager';
import { TemplateSettingsCard } from '@/components/workspace/template-settings-card';
import {
  acquireProvider,
  releaseProvider,
  useWorkspaceCollabSocket,
} from '@/lib/workspace/collab-socket-context';
import { applyMarkdownDiff, serializeDoc } from '@/lib/crdt-js/markdown_yjs.mjs';
import type { WorkspaceFileRow } from '@/lib/workspace/types';

const SAVE_DEBOUNCE_MS = 600;

export const AGENTS_FILE_PATH = 'AGENTS.md';

/**
 * The workspace's root AGENTS.md text file, when it exists. The agent brain
 * prefers this file over `projects.space_instructions`
 * (agent-ts/src/prompt/load-context.ts), so when it exists the instructions
 * panel becomes a view onto the file — single source of truth, no sync logic.
 */
export function findRootAgentsFile(
  files: WorkspaceFileRow[] | null | undefined,
): WorkspaceFileRow | null {
  if (!files) return null;
  return files.find((file) => file.type === 'text' && file.path === AGENTS_FILE_PATH) ?? null;
}

const INSTRUCTIONS_TEXTAREA_CLASSES =
  'w-full text-xs bg-white border border-stone-200 rounded-xl px-3 py-2.5 focus:outline-none focus:border-orange focus:ring-2 focus:ring-orange/20 resize-y text-stone-700 disabled:bg-stone-50 disabled:text-stone-500';

/* ── Workspace Instructions Tab ── */

interface WorkspaceTabProps {
  workspaceId?: string;
  canWrite?: boolean;
  // Controlled by the parent so edits survive close+reopen of the settings
  // panel (this component unmounts when the user switches tabs).
  spaceInstructions: string;
  onSpaceInstructionsChange: (next: string) => void;
  /** Root AGENTS.md row when the workspace has one — flips the panel to file mode. */
  agentsFile?: WorkspaceFileRow | null;
  /** Called with the created row after "Move to AGENTS.md". */
  onAgentsFileCreated?: (file: WorkspaceFileRow) => void;
  templateSlug?: string | null;
  templateName?: string | null;
  templateDefaultAddendum?: string | null;
  templateAddendumOverride?: string | null;
  /** Archived chats — hidden from the rail, revivable only from here. */
  archivedChats?: { id: string; title: string | null }[];
  onUnarchiveChat?: (chatId: string) => void | Promise<void>;
}

/**
 * The AGENTS.md-backed instructions editor: a textarea bound to the file's
 * live Y.Doc over the same shared Hocuspocus socket the editor uses, so edits
 * here ARE file edits (attributed, collaborative, visible in an open editor)
 * and vice versa. Mirrors RawMarkdownEditor's textarea↔Y.Doc sync pattern.
 */
function AgentsFileInstructions({
  workspaceId,
  fileId,
  canWrite,
}: {
  workspaceId: string;
  fileId: string;
  canWrite: boolean;
}) {
  const sharedSocket = useWorkspaceCollabSocket(workspaceId);
  const [value, setValue] = useState('');
  const [synced, setSynced] = useState(false);
  const ydocRef = useRef<Y.Doc | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  const syncedRef = useRef(false);
  syncedRef.current = synced;
  const focusedRef = useRef(false);
  /** Skip the Y.Doc update event our own write-back fires. */
  const suppressNextSyncRef = useRef(false);
  const writeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Apply the textarea's markdown onto the live Y.Doc through the single
  // markdown↔Y.Doc codec (minimal diff, one transaction — concurrent editors
  // see a normal collaborative edit, not a wholesale replace).
  const flushWrite = useCallback((next?: string) => {
    if (writeTimerRef.current) {
      clearTimeout(writeTimerRef.current);
      writeTimerRef.current = null;
    }
    const ydoc = ydocRef.current;
    // Never write before the initial sync — flushing the pre-sync empty
    // textarea would wipe the file.
    if (!ydoc || !syncedRef.current) return;
    const md = next ?? valueRef.current;
    const before = serializeDoc(ydoc);
    if (before === md) return;
    suppressNextSyncRef.current = true;
    applyMarkdownDiff(ydoc, md);
    // If the diff was a semantic no-op (textarea differs from the doc only in
    // formatting that parses to the same blocks — bullet style, trailing space)
    // no 'update' event fires to consume the suppress flag; clear it now so it
    // can't swallow the next genuine remote edit (silent revert).
    if (serializeDoc(ydoc) === before) suppressNextSyncRef.current = false;
  }, []);
  const flushWriteRef = useRef(flushWrite);
  flushWriteRef.current = flushWrite;

  useEffect(() => {
    if (!sharedSocket) return;
    const docName = `${sharedSocket.docNamePrefix ?? ''}${AGENTS_FILE_PATH}`;
    const entry = acquireProvider(sharedSocket.socket, docName, fileId, sharedSocket.getToken);
    ydocRef.current = entry.ydoc;
    const refresh = () => {
      if (suppressNextSyncRef.current) {
        suppressNextSyncRef.current = false;
        return;
      }
      const md = serializeDoc(entry.ydoc);
      // Mid-typing (focused with a pending debounce) the local text is newer
      // than the doc — let the imminent flush reconcile instead of yanking
      // the cursor.
      if (focusedRef.current && writeTimerRef.current) return;
      setValue((prev) => (prev === md ? prev : md));
    };
    const markSynced = () => {
      syncedRef.current = true;
      setSynced(true);
      setValue(serializeDoc(entry.ydoc));
    };
    if (entry.provider.synced) markSynced();
    entry.provider.on?.('synced', markSynced);
    entry.ydoc.on('update', refresh);
    return () => {
      entry.provider.off?.('synced', markSynced);
      entry.ydoc.off('update', refresh);
      // A pending edit must land before the provider is released.
      flushWriteRef.current();
      ydocRef.current = null;
      syncedRef.current = false;
      setSynced(false);
      releaseProvider(sharedSocket.socket, docName, fileId);
    };
  }, [sharedSocket, fileId]);

  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>) => {
      const next = event.target.value;
      setValue(next);
      if (writeTimerRef.current) clearTimeout(writeTimerRef.current);
      writeTimerRef.current = setTimeout(() => {
        writeTimerRef.current = null;
        flushWrite(next);
      }, SAVE_DEBOUNCE_MS);
    },
    [flushWrite],
  );

  const ready = Boolean(sharedSocket) && synced;
  return (
    <div>
      <p className="text-[13px] text-stone-500 mb-3">
        Instructions live in AGENTS.md — edits here update that file.
      </p>
      <textarea
        rows={8}
        value={value}
        onChange={handleChange}
        onFocus={() => {
          focusedRef.current = true;
        }}
        onBlur={() => {
          focusedRef.current = false;
          flushWrite();
        }}
        disabled={!canWrite || !ready}
        placeholder="Write instructions that apply to every chat..."
        className={INSTRUCTIONS_TEXTAREA_CLASSES}
      />
      <div className="text-[11px] text-stone-400 mt-2 shrink-0">
        {ready ? 'Applied to every new message.' : 'Loading AGENTS.md…'}
      </div>
    </div>
  );
}

export function WorkspaceTab({
  workspaceId,
  canWrite = true,
  spaceInstructions,
  onSpaceInstructionsChange,
  agentsFile,
  onAgentsFileCreated,
  templateSlug,
  templateName,
  templateDefaultAddendum,
  templateAddendumOverride,
  archivedChats,
  onUnarchiveChat,
}: WorkspaceTabProps) {
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [movingToFile, setMovingToFile] = useState(false);
  const savedRef = useRef(spaceInstructions);
  const valueRef = useRef(spaceInstructions);
  valueRef.current = spaceInstructions;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(async () => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    const next = valueRef.current;
    if (!workspaceId || !canWrite || next === savedRef.current) return;
    setStatus('saving');
    try {
      const res = await fetch('/api/workspace', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ projectId: workspaceId, space_instructions: next }),
      });
      if (!res.ok) throw new Error(`Save failed (${res.status})`);
      savedRef.current = next;
      setStatus('saved');
    } catch {
      setStatus('error');
    }
  }, [workspaceId, canWrite]);

  // Debounced autosave. onBlur (below) covers fast close-before-debounce.
  // Skipped in AGENTS.md mode, where the file is the single source of truth.
  useEffect(() => {
    if (agentsFile) return;
    if (spaceInstructions === savedRef.current) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => void flush(), SAVE_DEBOUNCE_MS);
  }, [agentsFile, spaceInstructions, flush]);

  // "Move to AGENTS.md": create the file with the current instructions text
  // through the normal file-create rail; afterwards the panel is a file view.
  // The brain already prefers the file, so the column can stay as-is.
  const moveToAgentsFile = useCallback(async () => {
    if (!workspaceId || !canWrite || movingToFile) return;
    setMovingToFile(true);
    try {
      await flush(); // don't lose an unsaved column edit if the create fails
      const res = await fetch('/api/workspace/files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId: workspaceId,
          path: AGENTS_FILE_PATH,
          type: 'text',
          content: valueRef.current,
        }),
      });
      if (!res.ok) throw new Error(`Create failed (${res.status})`);
      const payload = (await res.json()) as { file: WorkspaceFileRow };
      onAgentsFileCreated?.(payload.file);
    } catch {
      setStatus('error');
    } finally {
      setMovingToFile(false);
    }
  }, [canWrite, flush, movingToFile, onAgentsFileCreated, workspaceId]);

  return (
    <div className="p-5 flex flex-col overflow-auto flex-1 gap-4">
      {templateSlug && templateName && templateDefaultAddendum && workspaceId ? (
        <TemplateSettingsCard
          projectId={workspaceId}
          canWrite={canWrite}
          templateSlug={templateSlug}
          templateName={templateName}
          defaultAddendum={templateDefaultAddendum}
          initialOverride={templateAddendumOverride ?? null}
        />
      ) : null}
      {agentsFile && workspaceId ? (
        <AgentsFileInstructions
          workspaceId={workspaceId}
          fileId={agentsFile.id}
          canWrite={canWrite}
        />
      ) : (
      <div>
        <p className="text-[13px] text-stone-500 mb-3">These instructions apply to every chat here.</p>
        <textarea
          rows={8}
          value={spaceInstructions}
          onChange={(e) => onSpaceInstructionsChange(e.target.value)}
          onBlur={() => void flush()}
          disabled={!canWrite}
          placeholder="Write instructions that apply to every chat..."
          className={INSTRUCTIONS_TEXTAREA_CLASSES}
        />
        <div className="mt-2 flex items-baseline justify-between gap-3 shrink-0">
          <span className="text-[11px] text-stone-400">
            {status === 'saving' ? 'Saving…'
              : status === 'error' ? <span className="text-red-500">Save failed</span>
              : status === 'saved' ? 'Saved.'
              : 'Applied to every new message.'}
          </span>
          {canWrite && workspaceId ? (
            <button
              type="button"
              onClick={() => void moveToAgentsFile()}
              disabled={movingToFile}
              className="text-[11px] text-stone-400 transition-colors hover:text-stone-600 disabled:opacity-50"
            >
              {movingToFile ? 'Moving…' : 'Move to AGENTS.md'}
            </button>
          ) : null}
        </div>
      </div>
      )}
      {archivedChats && archivedChats.length > 0 ? (
        // Archived chats live only here (never in the rail) — unarchive
        // returns them to the chat list.
        <div data-testid="archived-chats-section">
          <p className="text-[13px] text-stone-500 mb-2">Archived chats</p>
          <div className="divide-y divide-stone-100 rounded-xl border border-stone-200">
            {archivedChats.map((chat) => (
              <div key={chat.id} className="flex items-center gap-3 px-3 py-2">
                <span className="min-w-0 flex-1 truncate text-[13px] text-stone-600">
                  {chat.title?.trim() || 'New chat'}
                </span>
                {onUnarchiveChat ? (
                  <button
                    type="button"
                    onClick={() => void onUnarchiveChat(chat.id)}
                    className="shrink-0 text-[11px] text-stone-400 transition-colors hover:text-stone-600"
                  >
                    Unarchive
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ── Secrets Tab ── */

interface SecretsTabProps {
  workspaceId: string;
  canWrite: boolean;
}

export function SecretsTab({ workspaceId, canWrite }: SecretsTabProps) {
  return (
    <WorkspaceSecretsManager
      canWrite={canWrite}
      loadUrl={`/api/workspace/secrets?projectId=${encodeURIComponent(workspaceId)}`}
      actionUrl="/api/workspace/secrets"
      requestBodyBase={{ projectId: workspaceId }}
      title="Secrets"
      intro="Encrypted keys and passwords your chats can use without pasting them."
      addButtonLabel="New secret"
      reserveCloseSpace
      footerNote="Encrypted at rest. Available to your chats automatically."
    />
  );
}
