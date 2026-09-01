/**
 * Forward SyncTeX binding for the Monaco editor (§4.2), kept out of the editor
 * component so it can be unit-tested against a fake editor: "Show in PDF" in
 * the right-click menu, bound to Ctrl/Cmd+Alt+J.
 */

type Disposable = { dispose: () => void };

export type SyncTexBindableEditor = {
  addAction(descriptor: {
    id: string;
    label: string;
    contextMenuGroupId?: string;
    contextMenuOrder?: number;
    keybindings?: number[];
    run: () => void;
  }): Disposable;
};

export type SyncTexBindableMonaco = {
  KeyMod: { CtrlCmd: number; Alt: number; WinCtrl: number };
  KeyCode: { KeyJ: number };
};

/** Wires the binding and returns a disposer. */
export function attachSyncTexBindings({
  editor,
  monaco,
  onShowInPdf,
}: {
  editor: SyncTexBindableEditor;
  monaco: SyncTexBindableMonaco;
  /** Omitted when forward search isn't available — then no menu item is added. */
  onShowInPdf?: () => void;
}): () => void {
  const disposables: Disposable[] = [];
  if (onShowInPdf) {
    disposables.push(
      editor.addAction({
        id: 'sundial-show-in-pdf',
        label: 'Show in PDF',
        contextMenuGroupId: 'navigation',
        contextMenuOrder: 1.6,
        // Ctrl+Alt+J is the advertised chord (Cmd+Alt+J is Chrome's DevTools
        // console on macOS); both are bound.
        keybindings: [
          monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyJ,
          monaco.KeyMod.WinCtrl | monaco.KeyMod.Alt | monaco.KeyCode.KeyJ,
        ],
        run: onShowInPdf,
      }),
    );
  }
  return () => {
    disposables.forEach((d) => d.dispose());
  };
}
