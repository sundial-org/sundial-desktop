'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { XIcon } from '@phosphor-icons/react';
import { ModalShell } from '@/components/modal-shell';
import { getLaunchParam, sidecar, type LocalProject, type SidecarConfig } from '@/lib/local/sidecar';
import { saveLastProjectLocation } from '@/lib/local/last-location';
import type { StarterPack } from '@/lib/local/starter-packs';

/** Which flow the shared dialog shell is running. `pack: null` = blank project. */
export type ProjectDialogIntent = { kind: 'create'; pack: StarterPack | null } | { kind: 'clone' };

const FIELD =
  'w-full rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm text-stone-800 outline-none placeholder:text-stone-400 focus:border-stone-400 disabled:opacity-50';

/** The desktop shell's location picker (`/desktop/pick-location` marker)
 *  returns by rewriting the URL fragment with `pickedPath` — a same-document
 *  navigation. While a dialog is open we watch for it and fill the field. */
function usePickedLocation(onPicked: (path: string) => void) {
  const handler = useRef(onPicked);
  handler.current = onPicked;
  useEffect(() => {
    const onHashChange = () => {
      const picked = getLaunchParam('pickedPath');
      if (picked) handler.current(picked);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);
}

function LocationField({
  value,
  onChange,
  isDesktop,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  isDesktop: boolean;
  disabled: boolean;
}) {
  usePickedLocation(onChange);
  return (
    <div className="flex flex-col gap-1.5">
      <label className="text-sm font-medium text-stone-700" htmlFor="project-location">
        Location
      </label>
      <div className="flex gap-2">
        <input
          id="project-location"
          className={FIELD}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="/Users/you/Documents/Sundial"
          disabled={disabled}
          data-testid="project-location-input"
        />
        {isDesktop && (
          <button
            type="button"
            className="shrink-0 rounded-lg border border-stone-200 bg-white px-4 py-2 text-sm font-medium text-stone-700 hover:bg-stone-100 disabled:opacity-50"
            disabled={disabled}
            onClick={() => window.location.assign('/desktop/pick-location')}
          >
            Browse
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * "Create new project" / "Clone from GitHub" dialog, styled after the starter
 * pack cards that open it. Owns the sidecar call; reports the opened project
 * back so the page can navigate.
 */
export function ProjectDialog({
  intent,
  config,
  defaultLocation,
  isDesktop,
  onClose,
  onCreated,
}: {
  intent: ProjectDialogIntent | null;
  config: SidecarConfig | null;
  defaultLocation: string;
  isDesktop: boolean;
  onClose: () => void;
  onCreated: (project: LocalProject) => void;
}) {
  const [name, setName] = useState('');
  const [repo, setRepo] = useState('');
  const [location, setLocation] = useState(defaultLocation);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset per open, and re-seed the location when the sidecar's default
  // arrives after mount (the /projects fetch races the first open).
  const open = intent !== null;
  useEffect(() => {
    if (!open) return;
    setName('');
    setRepo('');
    setBusy(false);
    setError(null);
  }, [open]);
  useEffect(() => {
    setLocation((current) => current || defaultLocation);
  }, [defaultLocation]);

  const pack = intent?.kind === 'create' ? intent.pack : null;
  const isClone = intent?.kind === 'clone';

  const submit = useCallback(async () => {
    if (!config || !intent) return;
    setBusy(true);
    setError(null);
    try {
      const { project } = isClone
        ? await sidecar.cloneProject(config, { url: repo, location: location.trim() })
        : await sidecar.createProject(config, {
            name: name.trim() || (pack?.namePlaceholder ?? 'My Project'),
            location: location.trim(),
            pack: pack?.id ?? 'blank',
          });
      saveLastProjectLocation(location.trim());
      onCreated(project);
    } catch (err) {
      setBusy(false);
      // A 404 here means the endpoint itself is missing: an outdated sidecar
      // answered — either a stale process from before an update (quit/reopen
      // fixes it) or an old installed build (only updating the app fixes it).
      const stale = (err as { status?: number })?.status === 404;
      setError(
        stale
          ? 'This feature needs a newer version of the Sundial app. Quit and reopen Sundial — if that doesn\'t help, update it via File → "Check for Updates…".'
          : err instanceof Error
            ? err.message
            : 'Something went wrong',
      );
    }
  }, [config, intent, isClone, repo, name, location, pack, onCreated]);

  return (
    <ModalShell
      open={open}
      onClose={() => !busy && onClose()}
      ariaLabel={isClone ? 'Clone from GitHub' : 'Create new project'}
      overlayClassName="fixed inset-0 z-[75] flex items-center justify-center bg-stone-950/50 backdrop-blur-sm p-4"
      panelClassName="relative w-full max-w-md rounded-3xl border border-stone-200 bg-white p-6 shadow-2xl"
    >
      <button
        type="button"
        aria-label="Close"
        className="absolute right-4 top-4 text-stone-400 hover:text-stone-600"
        onClick={onClose}
        disabled={busy}
      >
        <XIcon className="h-4 w-4" aria-hidden />
      </button>

      <h2 className="text-lg font-semibold text-stone-800">
        {isClone ? 'Clone from GitHub' : 'Create new project'}
      </h2>
      <p className="mt-1.5 text-sm text-stone-500">
        {isClone ? (
          'Clone a repository onto this computer and open it as a Sundial project.'
        ) : pack ? (
          <>
            Start from the <span className="font-medium text-stone-700">{pack.title}</span> starter
            pack — ready-made folders and starter files in the folder of your choice.
          </>
        ) : (
          'An empty project in the folder of your choice.'
        )}
      </p>

      <form
        className="mt-5 flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        {isClone ? (
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-stone-700" htmlFor="project-repo">
              Repository
            </label>
            <input
              id="project-repo"
              className={FIELD}
              value={repo}
              onChange={(event) => setRepo(event.target.value)}
              placeholder="owner/repo or https://github.com/owner/repo"
              autoFocus
              disabled={busy}
              data-testid="project-repo-input"
            />
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium text-stone-700" htmlFor="project-name">
              Project name
            </label>
            <input
              id="project-name"
              className={FIELD}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={pack?.namePlaceholder ?? 'My Project'}
              autoFocus
              disabled={busy}
              data-testid="project-name-input"
            />
          </div>
        )}

        <LocationField value={location} onChange={setLocation} isDesktop={isDesktop} disabled={busy} />

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="mt-1 flex justify-end gap-2">
          <button
            type="button"
            className="rounded-lg border border-stone-200 bg-white px-4 py-2 text-sm font-medium text-stone-700 hover:bg-stone-100 disabled:opacity-50"
            onClick={onClose}
            disabled={busy}
          >
            Cancel
          </button>
          <button
            type="submit"
            className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white hover:bg-stone-800 disabled:opacity-50"
            disabled={busy || !location.trim() || (isClone && !repo.trim())}
            data-testid="project-dialog-submit"
          >
            {busy ? (
              <span className="flex items-center gap-2">
                <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                {isClone ? 'Cloning…' : 'Creating…'}
              </span>
            ) : isClone ? (
              'Clone'
            ) : (
              'Create'
            )}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
