'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { SignInButton } from '@/lib/auth/optional-auth';
import { useHybridAuth } from '@/lib/auth/use-auth-ready';
import {
  EyeIcon as PhEyeIcon,
  EyeSlashIcon,
  PlusIcon,
  XIcon,
  KeyIcon,
  ArrowsClockwiseIcon,
  TrashIcon,
  LockSimpleIcon,
} from '@phosphor-icons/react';
import { Spinner } from '@/components/ui/spinner';
import { SunnyMascot } from '@/components/workspace/sunny-mascot';

export type WorkspaceSecret = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  lastRotatedAt: string;
};

type CreateRow = { id: string; name: string; value: string };

const newRowId = (): string =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `row-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;

const emptyCreateRow = (): CreateRow => ({ id: newRowId(), name: '', value: '' });

// Parse `.env`-style text into rows. Tolerates comments, `export ` prefixes,
// surrounding single/double quotes, and trims whitespace. Returns at most one
// row per non-empty non-comment line; lines without `=` are skipped.
const parseEnvText = (input: string): Array<{ name: string; value: string }> => {
  const rows: Array<{ name: string; value: string }> = [];
  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    let name = line.slice(0, eq).trim();
    if (name.startsWith('export ')) name = name.slice('export '.length).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (!name) continue;
    rows.push({ name: name.toUpperCase(), value });
  }
  return rows;
};

type WorkspaceSecretsManagerProps = {
  canWrite: boolean;
  loadUrl: string;
  actionUrl?: string;
  requestBodyBase?: Record<string, unknown>;
  initialSecrets?: WorkspaceSecret[];
  allowReveal?: boolean;
  title?: string;
  intro?: ReactNode;
  hint?: ReactNode;
  // Pad the header's right edge so the action button clears an external close
  // button overlaid at the panel's top-right (the settings modal).
  reserveCloseSpace?: boolean;
  footerNote?: ReactNode;
  emptyStateLabel?: string;
  addButtonLabel?: string;
};

const sortSecrets = (secrets: WorkspaceSecret[]) =>
  [...secrets].sort((a, b) => a.name.localeCompare(b.name));

const formatSecretTime = (value: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'recently';
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};

const formatShortDate = (value: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

const hasOwn = (record: Record<string, string>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(record, key);

const errorMessage = (error: unknown, fallback: string): string =>
  error instanceof Error ? error.message : fallback;

function EyeIcon({ hidden, className }: { hidden: boolean; className?: string }) {
  if (hidden) {
    return <EyeSlashIcon className={`w-3.5 h-3.5 ${className ?? ''}`} weight="regular" />;
  }
  return <PhEyeIcon className={`w-3.5 h-3.5 ${className ?? ''}`} weight="regular" />;
}

export function WorkspaceSecretsManager({
  canWrite,
  loadUrl,
  actionUrl,
  requestBodyBase,
  initialSecrets = [],
  allowReveal = true,
  title,
  intro,
  hint,
  reserveCloseSpace = false,
  footerNote,
  emptyStateLabel = 'No secrets yet.',
  addButtonLabel = 'Add secret',
}: WorkspaceSecretsManagerProps) {
  // Secrets are bound to the Clerk user that owns the workspace, so anon
  // visitors (even owners of an anon-owned workspace) can't add them yet —
  // the API rejects them and the cipher would have no identity to attach to.
  // Surface a clear "sign in" CTA instead of a broken form. Hooks are
  // called unconditionally above the return below to satisfy rules-of-hooks.
  // Hybrid (Clerk OR sd_ desktop credentials) — the secrets API accepts sd_
  // bearers, so a signed-in desktop user must not see the sign-in CTA.
  const { signedIn: isSignedIn, ready: userLoaded } = useHybridAuth();

  const [secrets, setSecrets] = useState<WorkspaceSecret[]>(sortSecrets(initialSecrets));
  const [secretsLoading, setSecretsLoading] = useState(initialSecrets.length === 0);
  const [secretsError, setSecretsError] = useState('');
  const [secretsNotice, setSecretsNotice] = useState('');
  const [showCreateSecret, setShowCreateSecret] = useState(false);
  const [createRows, setCreateRows] = useState<CreateRow[]>([emptyCreateRow()]);
  const [revealCreateRows, setRevealCreateRows] = useState<Record<string, boolean>>({});
  const [revealedSecretValues, setRevealedSecretValues] = useState<Record<string, string>>({});
  const [revealingSecretName, setRevealingSecretName] = useState<string | null>(null);
  const [editingSecretName, setEditingSecretName] = useState<string | null>(null);
  const [editingSecretValue, setEditingSecretValue] = useState('');
  const [pendingSecretAction, setPendingSecretAction] = useState<string | null>(null);
  const [actionsLocked, setActionsLocked] = useState(false);
  // The create form renders after the (possibly long) secrets list, so when the
  // header CTA opens it we pull it into view + focus it — otherwise it can open
  // below the fold and look like nothing happened.
  const createFormRef = useRef<HTMLDivElement>(null);

  const requestUrl = actionUrl ?? loadUrl;
  const writeEnabled = canWrite && !actionsLocked;

  useEffect(() => {
    let cancelled = false;

    const loadSecrets = async () => {
      if (!loadUrl) return;
      setSecretsLoading(true);
      setSecretsError('');
      try {
        const res = await fetch(loadUrl);
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) {
          if (res.status === 410) {
            setActionsLocked(true);
          }
          setSecretsError(
            typeof data.error === 'string' ? data.error : 'Failed to load workspace secrets.'
          );
          return;
        }
        const nextSecrets = Array.isArray(data.secrets) ? (data.secrets as WorkspaceSecret[]) : [];
        setSecrets(sortSecrets(nextSecrets));
      } catch (error) {
        if (!cancelled) {
          setSecretsError(errorMessage(error, 'Failed to load workspace secrets.'));
        }
      } finally {
        if (!cancelled) {
          setSecretsLoading(false);
        }
      }
    };

    void loadSecrets();
    return () => {
      cancelled = true;
    };
  }, [loadUrl]);

  useEffect(() => {
    if (!secretsNotice) return;
    const timeout = window.setTimeout(() => setSecretsNotice(''), 2500);
    return () => window.clearTimeout(timeout);
  }, [secretsNotice]);

  useEffect(() => {
    if (!showCreateSecret) return;
    const node = createFormRef.current;
    if (!node) return;
    node.scrollIntoView({ block: 'nearest' });
    node.querySelector('input')?.focus();
  }, [showCreateSecret]);

  const upsertSecret = (secret: WorkspaceSecret) => {
    setSecrets((prev) => {
      const next = prev.filter((item) => item.name !== secret.name);
      next.push(secret);
      return sortSecrets(next);
    });
  };

  const resetEditingSecret = () => {
    setEditingSecretName(null);
    setEditingSecretValue('');
  };

  const requestSecretsApi = async (
    method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    body: Record<string, unknown>,
    fallbackError: string
  ): Promise<Record<string, unknown> | null> => {
    try {
      const res = await fetch(requestUrl, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...(requestBodyBase ?? {}), ...body }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (res.status === 410) {
          setActionsLocked(true);
        }
        setSecretsError(typeof data.error === 'string' ? data.error : fallbackError);
        return null;
      }
      return typeof data === 'object' && data !== null ? (data as Record<string, unknown>) : {};
    } catch (error) {
      setSecretsError(errorMessage(error, fallbackError));
      return null;
    }
  };

  const hideSecretValue = (name: string) => {
    setRevealedSecretValues((prev) => {
      if (!hasOwn(prev, name)) return prev;
      const next = { ...prev };
      delete next[name];
      return next;
    });
  };

  const handleToggleRevealSecret = async (name: string) => {
    if (!allowReveal || !writeEnabled) return;

    if (hasOwn(revealedSecretValues, name)) {
      hideSecretValue(name);
      return;
    }

    setRevealingSecretName(name);
    setSecretsError('');
    try {
      const data = await requestSecretsApi('PUT', { name }, `Failed to reveal secret ${name}.`);
      if (!data) return;
      const revealedValue = data.value;
      if (typeof revealedValue === 'string') {
        setRevealedSecretValues((prev) => ({ ...prev, [name]: revealedValue }));
      } else {
        setSecretsError(`Failed to reveal secret ${name}.`);
      }
    } finally {
      setRevealingSecretName((prev) => (prev === name ? null : prev));
    }
  };

  const resetCreateForm = () => {
    setCreateRows([emptyCreateRow()]);
    setRevealCreateRows({});
    setShowCreateSecret(false);
    setSecretsError('');
  };

  // Typing/pasting `KEY=value` (single line) or a multi-line `.env` blob into
  // the Key field expands into one row per parsed entry, replacing the row the
  // user pasted into. Anything else is treated as a normal uppercase key edit.
  const updateRowName = (id: string, raw: string) => {
    if (raw.includes('=') || raw.includes('\n')) {
      const parsed = parseEnvText(raw);
      if (parsed.length > 0) {
        setCreateRows((prev) =>
          prev.flatMap((row) =>
            row.id === id ? parsed.map((p) => ({ id: newRowId(), name: p.name, value: p.value })) : [row]
          )
        );
        return;
      }
    }
    setCreateRows((prev) => prev.map((r) => (r.id === id ? { ...r, name: raw.toUpperCase() } : r)));
  };

  const updateRowValue = (id: string, value: string) => {
    setCreateRows((prev) => prev.map((r) => (r.id === id ? { ...r, value } : r)));
  };

  const removeRow = (id: string) => {
    setCreateRows((prev) => (prev.length <= 1 ? prev : prev.filter((r) => r.id !== id)));
    setRevealCreateRows((prev) => {
      if (!Object.prototype.hasOwnProperty.call(prev, id)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const handleCreateSecrets = async () => {
    if (!writeEnabled) return;
    const candidates = createRows
      .map((r) => ({ id: r.id, name: r.name.trim(), value: r.value, original: r }))
      .filter((r) => r.name || r.value.trim());
    if (candidates.length === 0 || !candidates.some((r) => r.name && r.value.trim())) {
      setSecretsError('Add a secret name and value.');
      return;
    }
    if (candidates.some((r) => !r.name || !r.value.trim())) {
      setSecretsError('Every row needs both a name and a value.');
      return;
    }

    setPendingSecretAction('create');
    setSecretsError('');

    let savedCount = 0;
    const remaining: CreateRow[] = [];
    for (let i = 0; i < candidates.length; i += 1) {
      const candidate = candidates[i];
      const data = await requestSecretsApi(
        'POST',
        { name: candidate.name, value: candidate.value },
        `Failed to save ${candidate.name}.`
      );
      if (!data) {
        remaining.push(candidate.original);
        for (let j = i + 1; j < candidates.length; j += 1) remaining.push(candidates[j].original);
        break;
      }
      if (data.secret) upsertSecret(data.secret as WorkspaceSecret);
      savedCount += 1;
    }

    setPendingSecretAction(null);

    if (remaining.length === 0) {
      resetCreateForm();
      setSecretsNotice(savedCount === 1 ? 'Secret added.' : `${savedCount} secrets added.`);
    } else {
      setCreateRows(remaining);
      if (savedCount > 0) setSecretsNotice(`${savedCount} saved.`);
    }
  };

  const handleRotateSecret = async (name: string) => {
    if (!writeEnabled) return;
    if (!editingSecretValue.trim()) {
      setSecretsError('Enter a new value to rotate this secret.');
      return;
    }
    setPendingSecretAction(`rotate:${name}`);
    setSecretsError('');
    try {
      const data = await requestSecretsApi(
        'PATCH',
        { name, value: editingSecretValue },
        'Failed to rotate secret.'
      );
      if (!data) return;
      if (data.secret) upsertSecret(data.secret as WorkspaceSecret);
      hideSecretValue(name);
      resetEditingSecret();
      setSecretsNotice(`Secret ${name} rotated.`);
    } finally {
      setPendingSecretAction(null);
    }
  };

  const handleDeleteSecret = async (name: string) => {
    if (!writeEnabled) return;
    const confirmed = window.confirm(`Delete secret ${name}?`);
    if (!confirmed) return;

    setPendingSecretAction(`delete:${name}`);
    setSecretsError('');
    try {
      const data = await requestSecretsApi('DELETE', { name }, 'Failed to delete secret.');
      if (!data) return;
      setSecrets((prev) => prev.filter((secret) => secret.name !== name));
      if (editingSecretName === name) {
        resetEditingSecret();
      }
      hideSecretValue(name);
      setSecretsNotice(`Secret ${name} deleted.`);
    } finally {
      setPendingSecretAction(null);
    }
  };

  if (userLoaded && !isSignedIn) {
    return (
      <div className="p-6 flex flex-col overflow-auto flex-1">
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-stone-200 bg-stone-50 px-6 py-10 text-center">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-white text-orange shadow-sm">
            <LockSimpleIcon className="h-5 w-5" weight="regular" aria-hidden />
          </span>
          <p className="text-sm text-stone-600">Sign in to add and manage workspace secrets.</p>
          <SignInButton mode="modal">
            <button
              type="button"
              className="rounded-lg bg-orange px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-orange-deep"
            >
              Sign in
            </button>
          </SignInButton>
        </div>
      </div>
    );
  }

  const showHeaderAddButton = writeEnabled && !showCreateSecret;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {title || intro || showHeaderAddButton ? (
        <div className={`flex shrink-0 items-start justify-between gap-3 pb-4 pl-6 pt-5 ${reserveCloseSpace ? 'pr-14' : 'pr-6'}`}>
          <div className="min-w-0">
            {title ? <div className="text-[15px] font-medium text-stone-800">{title}</div> : null}
            {intro ? <div className="mt-0.5 text-[13px] leading-relaxed text-stone-400">{intro}</div> : null}
          </div>
          {showHeaderAddButton ? (
            <button
              type="button"
              onClick={() => {
                setCreateRows([emptyCreateRow()]);
                setRevealCreateRows({});
                setShowCreateSecret(true);
                resetEditingSecret();
                setSecretsError('');
              }}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-orange px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-orange-deep"
            >
              <PlusIcon className="h-3.5 w-3.5" weight="bold" />
              {addButtonLabel}
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-auto px-6 pb-5">
        {hint ? (
          <div className="mb-4 rounded-xl border border-stone-200 bg-stone-50 px-3 py-2 text-[11px] text-stone-600">
            {hint}
          </div>
        ) : null}

        {secretsError ? <p className="mb-2 text-[11px] text-rose-600">{secretsError}</p> : null}
        {secretsNotice ? <p className="mb-2 text-[11px] text-emerald-600">{secretsNotice}</p> : null}

        {secretsLoading && secrets.length === 0 ? (
          <Spinner label="Loading secrets…" size={13} className="text-[11px]" />
        ) : secrets.length === 0 ? (
          <div className="flex flex-col items-center rounded-2xl border border-dashed border-stone-200 bg-stone-50 px-3 py-9 text-center">
            <span className="text-[15px] font-medium text-stone-600">{emptyStateLabel}</span>
            <span className="mt-1 text-[13px] text-stone-400">Sundial Agent will keep them safe.</span>
            <SunnyMascot variant="laptop" className="mt-3 h-44 w-56" />
          </div>
        ) : (
          <div className="border-b border-stone-200">
            {secrets.map((secret) => {
              const actionRotate = `rotate:${secret.name}`;
              const actionDelete = `delete:${secret.name}`;
              const isEditing = editingSecretName === secret.name;
              const isRevealed = hasOwn(revealedSecretValues, secret.name);
              const isRevealLoading = revealingSecretName === secret.name;

              return (
                <div
                  key={secret.id}
                  className="group/sec border-t border-stone-200 transition-colors hover:bg-stone-50 focus-within:bg-stone-50"
                >
                  <div className="flex items-center gap-3 px-1 py-3">
                    <span className="shrink-0 text-orange">
                      <KeyIcon className="h-4 w-4" weight="regular" aria-hidden />
                    </span>
                    <div className="min-w-0 flex-1 flex items-center gap-2.5">
                      <span
                        title={secret.name}
                        className="min-w-0 truncate rounded-md bg-stone-100 px-2 py-0.5 font-mono text-[12.5px] font-medium text-stone-700"
                      >
                        {secret.name}
                      </span>
                      {allowReveal ? (
                        isRevealLoading ? (
                          <span className="text-[11px] text-stone-400">Revealing…</span>
                        ) : isRevealed ? (
                          <code className="min-w-0 select-all break-all font-mono text-[11.5px] text-stone-700">
                            {revealedSecretValues[secret.name]}
                          </code>
                          ) : (
                            <span className="font-mono text-[11.5px] tracking-wider text-stone-300">
                              {'\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022'}
                            </span>
                          )
                      ) : null}
                    </div>

                    <span
                      className="shrink-0 text-[11px] text-stone-400 whitespace-nowrap"
                      title={`Created ${formatSecretTime(secret.createdAt)} · Rotated ${formatSecretTime(secret.lastRotatedAt)}`}
                    >
                      {formatShortDate(secret.createdAt)}
                    </span>

                    {writeEnabled ? (
                      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover/sec:opacity-100 group-focus-within/sec:opacity-100 [@media(hover:none)]:opacity-100">
                        {allowReveal ? (
                          <button
                            type="button"
                            onClick={() => void handleToggleRevealSecret(secret.name)}
                            disabled={isRevealLoading}
                            aria-label={isRevealed ? `Hide ${secret.name}` : `Reveal ${secret.name}`}
                            className="flex h-7 w-7 items-center justify-center rounded-lg text-stone-400 transition-colors hover:bg-white hover:text-stone-600 disabled:opacity-50"
                          >
                            <EyeIcon hidden={!isRevealed} />
                          </button>
                        ) : null}
                        <button
                          type="button"
                          onClick={() => {
                            if (isEditing) {
                              resetEditingSecret();
                              return;
                            }
                            setEditingSecretName(secret.name);
                            setEditingSecretValue('');
                            setSecretsError('');
                          }}
                          aria-label={isEditing ? `Cancel rotating ${secret.name}` : `Rotate ${secret.name}`}
                          className={`flex h-7 w-7 items-center justify-center rounded-lg transition-colors hover:bg-white ${isEditing ? 'text-orange' : 'text-stone-400 hover:text-stone-600'}`}
                        >
                          {isEditing ? (
                            <XIcon className="h-3.5 w-3.5" weight="bold" />
                          ) : (
                            <ArrowsClockwiseIcon className="h-3.5 w-3.5" />
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDeleteSecret(secret.name)}
                          disabled={pendingSecretAction === actionDelete}
                          aria-label={`Delete ${secret.name}`}
                          className="flex h-7 w-7 items-center justify-center rounded-lg text-stone-400 transition-colors hover:bg-white hover:text-rose-600 disabled:opacity-50"
                        >
                          <TrashIcon className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ) : null}
                  </div>

                  {isEditing && writeEnabled ? (
                    <div className="flex items-center gap-1.5 pb-3 pl-8 pr-1">
                      <input
                        type="password"
                        value={editingSecretValue}
                        onChange={(e) => setEditingSecretValue(e.target.value)}
                        placeholder="New secret value"
                        autoFocus
                        className="flex-1 rounded-lg border border-stone-200 bg-white px-2.5 py-1.5 text-xs text-stone-700 placeholder:text-stone-400 focus:border-orange focus:outline-none focus:ring-2 focus:ring-orange/20"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            void handleRotateSecret(secret.name);
                          }
                        }}
                      />
                      <button
                        type="button"
                        onClick={() => void handleRotateSecret(secret.name)}
                        disabled={!editingSecretValue.trim() || pendingSecretAction === actionRotate}
                        className="rounded-lg bg-orange px-3 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-orange-deep disabled:opacity-50"
                      >
                        {pendingSecretAction === actionRotate ? 'Saving…' : 'Save'}
                      </button>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}

        {showCreateSecret && writeEnabled ? (
          <div ref={createFormRef} className="mt-3 rounded-2xl border border-stone-200 bg-stone-50 p-3 space-y-2">
            {createRows.map((row) => {
              const isRevealed = revealCreateRows[row.id] === true;
              const canRemove = createRows.length > 1;
              return (
                <div key={row.id} className="flex items-start gap-1.5">
                  <div className="flex-1 min-w-0 space-y-1.5">
                    <input
                      type="text"
                      value={row.name}
                      onChange={(e) => updateRowName(row.id, e.target.value)}
                      placeholder="SECRET_NAME"
                      className="w-full rounded-lg border border-stone-200 bg-white px-2.5 py-1.5 font-mono text-xs text-stone-700 placeholder:font-sans placeholder:text-stone-400 focus:border-orange focus:outline-none focus:ring-2 focus:ring-orange/20"
                    />
                    <div className="relative">
                      <input
                        type={isRevealed ? 'text' : 'password'}
                        value={row.value}
                        onChange={(e) => updateRowValue(row.id, e.target.value)}
                        placeholder="Secret value"
                        className="w-full rounded-lg border border-stone-200 bg-white px-2.5 py-1.5 pr-8 text-xs text-stone-700 placeholder:text-stone-400 focus:border-orange focus:outline-none focus:ring-2 focus:ring-orange/20"
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            void handleCreateSecrets();
                          }
                        }}
                      />
                      <button
                        type="button"
                        aria-label={isRevealed ? 'Hide value' : 'Reveal value'}
                        onClick={() =>
                          setRevealCreateRows((prev) => ({ ...prev, [row.id]: !isRevealed }))
                        }
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 text-stone-400 transition-colors hover:text-stone-600"
                      >
                        <EyeIcon hidden={!isRevealed} />
                      </button>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeRow(row.id)}
                    disabled={!canRemove}
                    aria-label="Remove row"
                    className="shrink-0 p-1 text-stone-300 transition-colors hover:text-rose-500 disabled:opacity-0"
                  >
                    <XIcon className="h-3 w-3" weight="bold" />
                  </button>
                </div>
              );
            })}

            <div className="flex items-center justify-between gap-1.5 pt-0.5">
              <button
                type="button"
                onClick={() => setCreateRows((prev) => [...prev, emptyCreateRow()])}
                className="inline-flex items-center gap-1 text-[11px] text-stone-500 transition-colors hover:text-orange-deep"
              >
                <PlusIcon className="h-3 w-3" weight="bold" />
                Add another
              </button>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={resetCreateForm}
                  className="rounded-lg px-2.5 py-1.5 text-[11px] text-stone-400 transition-colors hover:text-stone-600"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={() => void handleCreateSecrets()}
                  disabled={
                    pendingSecretAction === 'create' ||
                    !createRows.some((r) => r.name.trim() && r.value.trim())
                  }
                  className="rounded-lg bg-orange px-3 py-1.5 text-[11px] font-medium text-white transition-colors hover:bg-orange-deep disabled:opacity-50"
                >
                  {pendingSecretAction === 'create' ? 'Saving…' : addButtonLabel}
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </div>

      {footerNote ? (
        <div className="flex shrink-0 items-center gap-2 border-t border-stone-200 px-6 py-3.5 text-[13px] text-stone-500">
          <LockSimpleIcon className="h-4 w-4 shrink-0 text-orange" weight="regular" aria-hidden />
          {footerNote}
        </div>
      ) : null}
    </div>
  );
}
