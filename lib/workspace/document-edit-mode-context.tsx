'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  DEFAULT_EDIT_MODE,
  documentEditModeStorageKey,
  readStoredEditMode,
  writeStoredEditMode,
  type WorkspaceEditMode,
} from '@/lib/workspace/edit-mode';

type DocumentEditModeValue = {
  mode: WorkspaceEditMode;
  setMode: (mode: WorkspaceEditMode) => void;
  /** True only when rendered inside a {@link DocumentEditModeProvider}. */
  present: boolean;
};

const Ctx = createContext<DocumentEditModeValue | null>(null);

/**
 * Holds the human document Edit/Suggest mode for a workspace. Persisted per
 * workspace in localStorage. The collab socket reads this to mint a
 * mode-scoped Hocuspocus token (so manual edits persist as `edit` vs
 * `suggest`), and the editor toolbar reads/writes it via {@link useDocumentEditMode}.
 *
 * Mounted above {@link WorkspaceCollabSocketProvider} so a mode change can
 * recreate the socket with a fresh token.
 */
export function DocumentEditModeProvider({
  workspaceId,
  children,
}: {
  workspaceId: string | null;
  children: React.ReactNode;
}) {
  const [mode, setModeState] = useState<WorkspaceEditMode>(DEFAULT_EDIT_MODE);

  useEffect(() => {
    if (!workspaceId) {
      setModeState(DEFAULT_EDIT_MODE);
      return;
    }
    setModeState(readStoredEditMode(documentEditModeStorageKey(workspaceId)) ?? DEFAULT_EDIT_MODE);
  }, [workspaceId]);

  const setMode = useCallback(
    (next: WorkspaceEditMode) => {
      setModeState(next);
      if (workspaceId) writeStoredEditMode(documentEditModeStorageKey(workspaceId), next);
    },
    [workspaceId],
  );

  const value = useMemo(() => ({ mode, setMode, present: true }), [mode, setMode]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Read the workspace document mode. Returns `edit` when no provider is present. */
export function useDocumentEditMode(): DocumentEditModeValue {
  return useContext(Ctx) ?? { mode: DEFAULT_EDIT_MODE, setMode: () => {}, present: false };
}
