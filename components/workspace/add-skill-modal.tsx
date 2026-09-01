'use client';

import { useCallback, useRef, useState } from 'react';
import { SparkleIcon, UploadSimpleIcon, XIcon } from '@phosphor-icons/react';
import { ModalShell } from '@/components/modal-shell';
import { FEATURED_SKILLS, type FeaturedSkill } from '@/lib/skills/featured';

/**
 * Install a skill into `skills/<id>/SKILL.md` — from a GitHub/GitLab source or
 * a local SKILL.md. Source resolution and the fetch happen server-side in
 * `/api/workspace/skills` (the host allowlist there is an SSRF control, so the
 * URL must never be fetched from the browser and posted as content instead).
 */
export function AddSkillModal({
  open,
  onClose,
  projectId,
  onAdded,
  canSaveSecrets = false,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  /** Fired with the created path so the host can refresh + reveal the file. */
  onAdded: (path: string) => void;
  /**
   * Workspace secrets are owner-only; a featured skill's API-key input renders
   * only when this caller can actually save one — an editor typing a key into
   * a doomed 403 would lose the skill install along with it.
   */
  canSaveSecrets?: boolean;
}) {
  const [source, setSource] = useState('');
  // The raw File is kept (not its text): a `.skill`/`.zip` bundle is binary, and
  // reading it as text would corrupt it before it ever reaches the server.
  const [upload, setUpload] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Files the server omitted from an otherwise-successful install (non-text or
  // ignored-path references). Closing silently would tell the user the whole
  // skill landed when files its SKILL.md names did not.
  const [skipped, setSkipped] = useState<string[] | null>(null);
  // Per-featured-skill API key drafts, keyed by skill id.
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({});
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  /**
   * Every dismissal path routes through here so a previous source/error can't
   * bleed into the next open — cheaper and more predictable than resetting from
   * an effect on `open`, which would cascade a render on each close.
   */
  const close = useCallback(() => {
    setSource('');
    setUpload(null);
    setError(null);
    setBusy(false);
    setSkipped(null);
    setKeyDrafts({});
    onClose();
  }, [onClose]);

  /** Close on success — unless files were skipped, which the user must see. */
  const finish = useCallback(
    (path: string, skippedFiles: string[] | undefined) => {
      onAdded(path);
      if (skippedFiles && skippedFiles.length > 0) {
        setBusy(false);
        setSkipped(skippedFiles);
      } else {
        close();
      }
    },
    [onAdded, close],
  );

  const handleFile = useCallback((file: File | undefined) => {
    if (!file) return;
    setError(null);
    setUpload(file);
    setSource('');
  }, []);

  const canSubmit = !busy && (source.trim().length > 0 || upload !== null);

  /**
   * One-click install of a featured skill: save its API key first when one was
   * entered (so nothing is half-done if the key is rejected), then post the
   * canned SKILL.md through the same route a pasted skill takes.
   */
  const handleAddFeatured = useCallback(
    async (skill: FeaturedSkill) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        const key = canSaveSecrets ? (keyDrafts[skill.id] ?? '').trim() : '';
        if (skill.secret && key) {
          const secretBody = JSON.stringify({ projectId, name: skill.secret.name, value: key });
          const opts = {
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include' as const,
            body: secretBody,
          };
          let saved = await fetch('/api/workspace/secrets', { method: 'POST', ...opts });
          // POST creates; an existing secret rotates instead of failing.
          if (!saved.ok) saved = await fetch('/api/workspace/secrets', { method: 'PATCH', ...opts });
          if (!saved.ok) {
            const body = (await saved.json().catch(() => null)) as { error?: string } | null;
            throw new Error(body?.error ?? `Failed to save ${skill.secret.name} (${saved.status})`);
          }
        }
        const response = await fetch('/api/workspace/skills', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ projectId, content: skill.content, id: skill.id }),
        });
        const body = (await response.json().catch(() => null)) as
          | { file?: { path: string }; skipped?: string[]; error?: string }
          | null;
        if (!response.ok || !body?.file) {
          throw new Error(body?.error ?? `Failed to add skill (${response.status})`);
        }
        finish(body.file.path, body.skipped);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : 'Failed to add skill');
        setBusy(false);
      }
    },
    [busy, keyDrafts, canSaveSecrets, projectId, finish],
  );

  const handleAdd = useCallback(async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      let response: Response;
      if (upload) {
        // Multipart: a bundle is raw zip bytes, which JSON can't carry.
        const form = new FormData();
        form.append('projectId', projectId);
        form.append('file', upload);
        // The filename is the only id hint a browser upload carries, and a bare
        // `SKILL.md`/`.zip` says nothing — leave it empty and let the server
        // name the skill from its frontmatter.
        const stem = upload.name.replace(/\.(md|zip|skill)$/i, '');
        form.append('id', /^SKILL$/i.test(stem) ? '' : stem);
        response = await fetch('/api/workspace/skills', {
          method: 'POST',
          credentials: 'include',
          body: form,
        });
      } else {
        response = await fetch('/api/workspace/skills', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ projectId, source: source.trim() }),
        });
      }
      const body = (await response.json().catch(() => null)) as
        | { file?: { path: string }; skipped?: string[]; error?: string }
        | null;
      if (!response.ok || !body?.file) {
        throw new Error(body?.error ?? `Failed to add skill (${response.status})`);
      }
      finish(body.file.path, body.skipped);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to add skill');
      setBusy(false);
    }
  }, [canSubmit, upload, source, projectId, finish]);

  return (
    <ModalShell
      open={open}
      onClose={close}
      ariaLabel="Add skill"
      panelClassName="relative flex w-full max-w-xl flex-col rounded-2xl border border-stone-200 bg-white shadow-xl"
      // Don't let a dismissal — stray click, Escape, X, Cancel — land while the
      // fetch is in flight: it would leave the request running, and a resubmit
      // then imports the skill twice.
      closeOnBackdrop={!busy}
      closeOnEscape={!busy}
    >
      <button
        type="button"
        onClick={close}
        disabled={busy}
        aria-label="Close"
        className="absolute right-3 top-3 inline-flex h-8 w-8 items-center justify-center rounded-full text-stone-400 hover:bg-stone-100 hover:text-stone-600 disabled:opacity-50"
      >
        <XIcon className="h-4 w-4" weight="bold" aria-hidden />
      </button>

      <header className="border-b border-stone-200 px-6 py-4">
        <h2 className="flex items-center gap-2 text-base font-semibold text-stone-900">
          <SparkleIcon className="h-5 w-5 text-amber-600" weight="fill" aria-hidden />
          Add a skill
        </h2>
        <p className="mt-1 text-xs text-stone-500">
          A skill is a reusable instruction file the agent follows. It lands in <code>skills/</code>{' '}
          as a normal workspace file you can edit.
        </p>
      </header>

      {skipped ? (
        <>
          <div className="space-y-3 px-6 py-5 text-sm" data-testid="skill-partial-install">
            <p className="text-stone-700">
              The skill was installed, but {skipped.length === 1 ? 'one file' : `${skipped.length} files`}{' '}
              its SKILL.md references {skipped.length === 1 ? 'was' : 'were'} skipped:
            </p>
            <ul className="max-h-40 overflow-auto rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 font-mono text-xs text-amber-800">
              {skipped.map((path) => (
                <li key={path} className="truncate">
                  {path}
                </li>
              ))}
            </ul>
            <p className="text-xs text-stone-500">
              The agent can still follow the skill; sections pointing at these files will not resolve.
            </p>
          </div>
          <footer className="flex justify-end gap-2 border-t border-stone-200 px-6 py-3">
            <button
              type="button"
              onClick={close}
              className="rounded-lg bg-stone-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-stone-800"
            >
              Done
            </button>
          </footer>
        </>
      ) : (
        <>
      <div className="space-y-4 px-6 py-5 text-sm">
        {FEATURED_SKILLS.map((skill) => (
          <div
            key={skill.id}
            data-testid={`featured-skill-${skill.id}`}
            className="rounded-xl border border-amber-200 bg-amber-50/60 p-3"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5 text-sm font-semibold text-stone-900">
                  <SparkleIcon className="h-4 w-4 shrink-0 text-amber-600" weight="fill" aria-hidden />
                  {skill.name}
                </div>
                <p className="mt-0.5 text-xs text-stone-500">{skill.tagline}</p>
              </div>
              <button
                type="button"
                onClick={() => void handleAddFeatured(skill)}
                disabled={busy}
                className="shrink-0 rounded-lg bg-stone-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-stone-800 disabled:opacity-50"
              >
                {busy ? 'Adding…' : 'Add'}
              </button>
            </div>
            {skill.secret && canSaveSecrets ? (
              <div className="mt-2">
                <input
                  type="password"
                  value={keyDrafts[skill.id] ?? ''}
                  onChange={(event) =>
                    setKeyDrafts((prev) => ({ ...prev, [skill.id]: event.target.value }))
                  }
                  disabled={busy}
                  placeholder={skill.secret.placeholder}
                  aria-label={`${skill.name} API key`}
                  className="w-full rounded-lg border border-stone-300 bg-white px-3 py-1.5 font-mono text-xs outline-none focus:border-stone-500 disabled:opacity-50"
                />
                <p className="mt-1 text-[11px] text-stone-400">
                  Get a free key at{' '}
                  <a
                    href={skill.secret.createUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="underline hover:text-stone-600"
                  >
                    {skill.secret.createUrl.replace(/^https?:\/\//, '')}
                  </a>
                  . Stored encrypted as the <code>{skill.secret.name}</code> workspace secret
                  (skippable if it&rsquo;s already set, or add it later in Settings &rarr; Secrets).
                </p>
              </div>
            ) : null}
          </div>
        ))}

        <div className="flex items-center gap-3 text-xs text-stone-400">
          <span className="h-px flex-1 bg-stone-200" />
          or install from a source
          <span className="h-px flex-1 bg-stone-200" />
        </div>

        <label className="block">
          <span className="text-xs font-medium text-stone-500">Source</span>
          <input
            value={source}
            onChange={(event) => {
              setSource(event.target.value);
              if (event.target.value) setUpload(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && canSubmit) void handleAdd();
            }}
            disabled={busy}
            autoFocus
            placeholder="vercel-labs/agent-skills/skills/react-best-practices"
            className="mt-1 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm outline-none focus:border-stone-500 disabled:opacity-50"
          />
          <span className="mt-1 block text-xs text-stone-400">
            GitHub or GitLab: <code>owner/repo</code>, or a link to the skill&rsquo;s folder.
          </span>
        </label>

        <div className="flex items-center gap-3 text-xs text-stone-400">
          <span className="h-px flex-1 bg-stone-200" />
          or
          <span className="h-px flex-1 bg-stone-200" />
        </div>

        <div>
          <input
            ref={fileInputRef}
            type="file"
            accept=".md,.zip,.skill,text/markdown,application/zip"
            className="hidden"
            onChange={(event) => {
              handleFile(event.target.files?.[0]);
              // Reset so re-picking the same file fires onChange again.
              event.target.value = '';
            }}
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-stone-700 hover:bg-stone-100 disabled:opacity-50"
          >
            <UploadSimpleIcon className="h-4 w-4" weight="regular" aria-hidden />
            Upload a SKILL.md or bundle
          </button>
          {upload ? (
            <p className="mt-2 flex items-center gap-2 text-xs text-stone-600">
              <span className="truncate font-medium">{upload.name}</span>
              <button
                type="button"
                onClick={() => setUpload(null)}
                className="text-stone-400 underline hover:text-stone-600"
              >
                remove
              </button>
            </p>
          ) : null}
        </div>

        {error ? (
          <p className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700">
            {error}
          </p>
        ) : null}
      </div>

      <footer className="flex justify-end gap-2 border-t border-stone-200 px-6 py-3">
        <button
          type="button"
          onClick={close}
          disabled={busy}
          className="rounded-lg border border-stone-300 bg-white px-3 py-1.5 text-sm font-medium text-stone-700 hover:bg-stone-100 disabled:opacity-50"
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={() => void handleAdd()}
          disabled={!canSubmit}
          className="rounded-lg bg-stone-900 px-4 py-1.5 text-sm font-medium text-white hover:bg-stone-800 disabled:opacity-50"
        >
          {busy ? 'Adding…' : 'Add skill'}
        </button>
      </footer>
        </>
      )}
    </ModalShell>
  );
}
