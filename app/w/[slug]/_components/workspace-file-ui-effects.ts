'use client';

import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import { isInFloatingActionMenu } from '@/components/workspace/anchored-dropdown';
import type { WorkspaceFileRow } from '@/lib/workspace/types';
import { isOfficeFile } from './workspace-file-helpers';

type DraftEntryLike = { id: string } | null;
type RenameEntryLike = { path: string; source: 'list' | 'header' | 'tab' } | null;

export function useWorkspaceActiveFileEffects<TMarkdownEditor, TRichEditor, TTextEditor>({
  projectId,
  activeIsMarkdown,
  activeWorkspaceDefaultsToRichViewer,
  activeWorkspaceFileId,
  activeWorkspaceFileResetKey,
  activeWorkspaceFileType,
  fileContentReady,
  isEditableFileOpen,
  collabStatus,
  activePreviewFile,
  binaryPreviewNonce,
  richEditorRef,
  textEditorRef,
  fileHideTimerRef,
  resetActiveComment,
  setShowRawView,
  setShowRichViewer,
  setMarkdownEditor,
  setReadyFileId,
  setViewerContent,
  setFileContentVisible,
  setConnectingGraceElapsed,
  setBinaryPreviewUrl,
  setBinaryPreviewStatus,
  fetchImpl,
}: {
  projectId: string;
  activeIsMarkdown: boolean;
  activeWorkspaceDefaultsToRichViewer: boolean;
  activeWorkspaceFileId: string | null;
  activeWorkspaceFileResetKey: string | null;
  activeWorkspaceFileType: WorkspaceFileRow['type'] | null;
  fileContentReady: boolean;
  isEditableFileOpen: boolean;
  collabStatus: 'local' | 'connecting' | 'connected' | 'disconnected';
  activePreviewFile: WorkspaceFileRow | null;
  binaryPreviewNonce: number;
  richEditorRef: MutableRefObject<TRichEditor | null>;
  textEditorRef: MutableRefObject<TTextEditor | null>;
  fileHideTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  resetActiveComment: () => void;
  setShowRawView: Dispatch<SetStateAction<boolean>>;
  setShowRichViewer: Dispatch<SetStateAction<boolean>>;
  setMarkdownEditor: Dispatch<SetStateAction<TMarkdownEditor | null>>;
  setReadyFileId: Dispatch<SetStateAction<string | null>>;
  setViewerContent: Dispatch<SetStateAction<string | null>>;
  setFileContentVisible: Dispatch<SetStateAction<boolean>>;
  setConnectingGraceElapsed: Dispatch<SetStateAction<boolean>>;
  setBinaryPreviewUrl: Dispatch<SetStateAction<string | null>>;
  setBinaryPreviewStatus: Dispatch<SetStateAction<'idle' | 'loading' | 'error'>>;
  /** Local projects route the preview lookup through the sidecar shim. */
  fetchImpl?: typeof fetch;
}) {
  useEffect(() => {
    if (!activeIsMarkdown) {
      setShowRawView(false);
    }
  }, [activeIsMarkdown, setShowRawView]);

  useEffect(() => {
    setShowRichViewer(activeWorkspaceDefaultsToRichViewer);
    richEditorRef.current = null;
    setMarkdownEditor(null);
    resetActiveComment();
    textEditorRef.current = null;
    if (
      activeWorkspaceFileId &&
      (activeWorkspaceFileType === 'binary' ||
        activeWorkspaceFileType === 'blob_ref' ||
        activeWorkspaceFileType === 'folder')
    ) {
      setReadyFileId(activeWorkspaceFileId);
    }
    setViewerContent(null);
  }, [
    activeWorkspaceDefaultsToRichViewer,
    activeWorkspaceFileId,
    activeWorkspaceFileResetKey,
    activeWorkspaceFileType,
    resetActiveComment,
    richEditorRef,
    setMarkdownEditor,
    setReadyFileId,
    setShowRichViewer,
    setViewerContent,
    textEditorRef,
  ]);

  useEffect(() => {
    if (fileContentReady) {
      if (fileHideTimerRef.current) {
        clearTimeout(fileHideTimerRef.current);
        fileHideTimerRef.current = null;
      }
      setFileContentVisible(true);
    } else {
      fileHideTimerRef.current = setTimeout(() => {
        setFileContentVisible(false);
      }, 150);
    }
    return () => {
      if (fileHideTimerRef.current) {
        clearTimeout(fileHideTimerRef.current);
        fileHideTimerRef.current = null;
      }
    };
  }, [fileContentReady, fileHideTimerRef, setFileContentVisible]);

  useEffect(() => {
    if (!projectId || !activePreviewFile) {
      setBinaryPreviewUrl(null);
      setBinaryPreviewStatus('idle');
      return;
    }

    const controller = new AbortController();
    let didCancel = false;
    setBinaryPreviewUrl(null);
    setBinaryPreviewStatus('loading');

    const loadPreview = async () => {
      try {
        // Office docs go through the conversion route (blob → PDF, cached by
        // source sha); images/PDFs get a plain signed URL. Derived here so
        // file and endpoint can never disagree.
        const endpoint = isOfficeFile(activePreviewFile)
          ? '/api/workspace/office-preview'
          : '/api/workspace/files/preview';
        const res = await (fetchImpl ?? fetch)(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId, fileId: activePreviewFile.id }),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error('Failed to load preview.');
        const payload = (await res.json()) as { signedUrl?: string | null };
        if (didCancel) return;
        if (!payload.signedUrl) throw new Error('Missing preview URL.');
        setBinaryPreviewUrl(payload.signedUrl);
        setBinaryPreviewStatus('idle');
      } catch (error) {
        if (didCancel) return;
        if ((error as Error)?.name === 'AbortError') return;
        setBinaryPreviewUrl(null);
        setBinaryPreviewStatus('error');
      }
    };

    void loadPreview();

    return () => {
      didCancel = true;
      controller.abort();
    };
  }, [
    activePreviewFile?.id,
    activePreviewFile?.storage_key,
    activePreviewFile?.path,
    activePreviewFile?.mime,
    binaryPreviewNonce,
    fetchImpl,
    projectId,
    setBinaryPreviewStatus,
    setBinaryPreviewUrl,
  ]);

  useEffect(() => {
    if (!isEditableFileOpen || collabStatus !== 'connecting') {
      setConnectingGraceElapsed(false);
      return;
    }

    const timeout = setTimeout(() => {
      setConnectingGraceElapsed(true);
    }, 12000);

    return () => clearTimeout(timeout);
  }, [collabStatus, isEditableFileOpen, setConnectingGraceElapsed]);
}

export function useWorkspaceFileEditingEffects({
  workspaceFileByPath,
  pendingEditedFilePath,
  openEditedFileInlinePath,
}: {
  workspaceFileByPath: Map<string, WorkspaceFileRow>;
  pendingEditedFilePath: string | null;
  openEditedFileInlinePath: (path: string) => void;
}) {
  // Opens a file the user explicitly chose from a diff/wiki card once it lands
  // in the file map. Agent turns no longer auto-surface their edited file —
  // navigation stays under the user's control.
  useEffect(() => {
    if (!pendingEditedFilePath) return;
    const file = workspaceFileByPath.get(pendingEditedFilePath);
    if (!file || file.type === 'folder' || file.type === 'proposal') return;
    openEditedFileInlinePath(pendingEditedFilePath);
  }, [openEditedFileInlinePath, pendingEditedFilePath, workspaceFileByPath]);
}

export function useWorkspaceFileInputEffects({
  draftEntry,
  renameEntry,
  openMenuPath,
  draftInputRef,
  renameInputRef,
  renameClickOffsetRef,
  fileMenuRef,
  cancelDraftRef,
  setOpenMenuPath,
}: {
  draftEntry: DraftEntryLike;
  renameEntry: RenameEntryLike;
  openMenuPath: string | null;
  draftInputRef: MutableRefObject<HTMLInputElement | null>;
  renameInputRef: MutableRefObject<HTMLInputElement | null>;
  renameClickOffsetRef: MutableRefObject<{ x: number; text: string } | null>;
  fileMenuRef: MutableRefObject<HTMLDivElement | null>;
  cancelDraftRef: MutableRefObject<boolean>;
  setOpenMenuPath: Dispatch<SetStateAction<string | null>>;
}) {
  useEffect(() => {
    if (!draftEntry) return;
    cancelDraftRef.current = false;
    requestAnimationFrame(() => {
      draftInputRef.current?.focus();
      draftInputRef.current?.select();
    });
  }, [cancelDraftRef, draftEntry?.id, draftInputRef]);

  const renameEntryPath = renameEntry?.path ?? null;
  const renameEntrySource = renameEntry?.source ?? null;
  useEffect(() => {
    if (!renameEntryPath || !renameEntrySource) return;
    requestAnimationFrame(() => {
      const input = renameInputRef.current;
      if (!input) return;
      input.focus();
      if (renameEntrySource === 'list') {
        input.select();
      } else {
        const click = renameClickOffsetRef.current;
        if (click && click.text === input.value) {
          const style = window.getComputedStyle(input);
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
            let pos = input.value.length;
            for (let i = 0; i <= input.value.length; i++) {
              const width = ctx.measureText(input.value.slice(0, i)).width;
              if (width >= click.x) {
                pos = Math.max(
                  0,
                  i -
                    (i > 0 && width - click.x > click.x - ctx.measureText(input.value.slice(0, i - 1)).width
                      ? 1
                      : 0)
                );
                break;
              }
            }
            input.setSelectionRange(pos, pos);
          } else {
            const len = input.value.length;
            input.setSelectionRange(len, len);
          }
        } else {
          const len = input.value.length;
          input.setSelectionRange(len, len);
        }
        renameClickOffsetRef.current = null;
      }
    });
  }, [renameClickOffsetRef, renameEntryPath, renameEntrySource, renameInputRef]);

  useEffect(() => {
    if (!openMenuPath) return;
    const handleClick = (event: MouseEvent) => {
      if (isInFloatingActionMenu(event.target)) return;
      if (!fileMenuRef.current?.contains(event.target as Node)) {
        setOpenMenuPath(null);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => {
      document.removeEventListener('mousedown', handleClick);
    };
  }, [fileMenuRef, openMenuPath, setOpenMenuPath]);
}
