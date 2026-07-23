'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowSquareOutIcon, GitCommitIcon } from '@phosphor-icons/react';
import { Spinner } from '@/components/ui/spinner';

// Renders a single commit's metadata + parsed unified diff. We parse the
// raw `git show --patch` output ourselves (instead of leaning on
// react-diff-view or similar) to stay in-bundle and match the visual
// language of the existing history modal.

type CommitMeta = {
  sha: string;
  author_name: string;
  author_email: string;
  authored_at: string;
  subject: string;
};

type Response = {
  commit: CommitMeta | null;
  patch: string;
  via?: string;
  viaLogin?: string | null;
  isRequesterToken?: boolean;
  error?: string;
};

type Hunk = {
  oldStart: number;
  newStart: number;
  lines: { kind: 'context' | 'add' | 'remove'; text: string }[];
};

type FilePatch = {
  oldPath: string;
  newPath: string;
  status: 'modified' | 'added' | 'removed' | 'renamed';
  hunks: Hunk[];
};

function parseUnifiedDiff(raw: string): FilePatch[] {
  if (!raw) return [];
  const lines = raw.split('\n');
  const files: FilePatch[] = [];
  let current: FilePatch | null = null;
  let currentHunk: Hunk | null = null;
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      current = {
        oldPath: match?.[1] ?? '',
        newPath: match?.[2] ?? '',
        status: 'modified',
        hunks: [],
      };
      currentHunk = null;
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('new file mode')) current.status = 'added';
    else if (line.startsWith('deleted file mode')) current.status = 'removed';
    else if (line.startsWith('rename from') || line.startsWith('rename to')) current.status = 'renamed';
    else if (line.startsWith('@@ ')) {
      const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      currentHunk = {
        oldStart: Number(match?.[1] ?? 0),
        newStart: Number(match?.[2] ?? 0),
        lines: [],
      };
      current.hunks.push(currentHunk);
    } else if (currentHunk) {
      if (line.startsWith('+++') || line.startsWith('---')) continue;
      if (line.startsWith('+')) currentHunk.lines.push({ kind: 'add', text: line.slice(1) });
      else if (line.startsWith('-')) currentHunk.lines.push({ kind: 'remove', text: line.slice(1) });
      else currentHunk.lines.push({ kind: 'context', text: line.startsWith(' ') ? line.slice(1) : line });
    }
  }
  return files;
}

export function CommitDiffViewer({
  projectId,
  repositoryId,
  sha,
  repoUrl,
}: {
  projectId: string;
  repositoryId: string;
  sha: string;
  repoUrl: string | null;
}) {
  const [data, setData] = useState<Response | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!repositoryId || !sha) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetch(
      `/api/workspace/linked-repos/${repositoryId}/commits/${sha}?projectId=${encodeURIComponent(projectId)}`,
      { signal: controller.signal, credentials: 'include' },
    )
      .then(async (response) => {
        const body = (await response.json().catch(() => null)) as Response | null;
        if (!response.ok) throw new Error(body?.error ?? `Failed (${response.status})`);
        setData(body);
      })
      .catch((caught) => {
        if (!controller.signal.aborted) {
          setError(caught instanceof Error ? caught.message : 'Failed to load commit');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [projectId, repositoryId, sha]);

  const files = useMemo(() => parseUnifiedDiff(data?.patch ?? ''), [data?.patch]);
  const upstreamLink = useMemo(() => {
    if (!repoUrl) return null;
    const cleaned = repoUrl.replace(/\.git$/, '');
    if (cleaned.includes('github.com')) return `${cleaned}/commit/${sha}`;
    return null;
  }, [repoUrl, sha]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-white">
      <header className="border-b border-stone-200 px-6 py-4">
        {loading ? (
          <Spinner label="Loading commit…" />
        ) : error || !data?.commit ? (
          <p className="text-sm text-rose-600">{error ?? 'Commit not found.'}</p>
        ) : (
          <>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="flex items-center gap-2 text-base font-semibold text-stone-900">
                  <GitCommitIcon className="h-4 w-4 text-stone-400" weight="regular" aria-hidden />
                  <span className="truncate">{data.commit.subject}</span>
                </h2>
                <p className="mt-1 text-xs text-stone-500">
                  {data.commit.author_name} &lt;{data.commit.author_email}&gt; ·{' '}
                  {new Date(data.commit.authored_at).toLocaleString()}
                </p>
                <p className="mt-1 font-mono text-[10px] text-stone-400">{data.commit.sha}</p>
              </div>
              {upstreamLink ? (
                <a
                  href={upstreamLink}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 rounded-lg border border-stone-200 bg-white px-2 py-1 text-[11px] text-stone-600 hover:bg-stone-50"
                >
                  Open on GitHub
                  <ArrowSquareOutIcon className="h-3 w-3" weight="bold" aria-hidden />
                </a>
              ) : null}
            </div>
            {data.via && data.isRequesterToken === false ? (
              <p className="mt-3 inline-block rounded-md border border-stone-200 bg-stone-50 px-2 py-1 text-[10px] text-stone-500">
                Showing via{' '}
                <span className="font-medium text-stone-700">
                  {data.viaLogin ? `@${data.viaLogin}` : 'the linker'}
                </span>
              </p>
            ) : null}
          </>
        )}
      </header>

      <div className="flex-1 overflow-auto px-6 py-6">
        {loading || error || !data ? null : files.length === 0 ? (
          <p className="text-sm text-stone-400">No changes in this commit.</p>
        ) : (
          <div className="space-y-6">
            {files.map((file) => (
              <article key={`${file.oldPath}->${file.newPath}`} className="overflow-hidden rounded-xl border border-stone-200">
                <header className="flex items-center justify-between gap-2 border-b border-stone-200 bg-stone-50 px-4 py-2">
                  <span className="truncate text-xs font-medium text-stone-700">
                    {file.status === 'renamed'
                      ? `${file.oldPath} → ${file.newPath}`
                      : file.newPath || file.oldPath}
                  </span>
                  <span className="rounded bg-white px-2 py-0.5 text-[10px] uppercase tracking-wide text-stone-500">
                    {file.status}
                  </span>
                </header>
                <div className="font-mono text-[11.5px] leading-5">
                  {file.hunks.map((hunk, hunkIdx) => (
                    <div key={hunkIdx}>
                      <div className="bg-stone-100 px-4 py-1 text-[10px] text-stone-500">
                        @@ -{hunk.oldStart} +{hunk.newStart} @@
                      </div>
                      {hunk.lines.map((line, idx) => (
                        <pre
                          key={idx}
                          className={`whitespace-pre-wrap break-words px-4 py-0.5 ${
                            line.kind === 'add'
                              ? 'bg-emerald-50 text-emerald-900'
                              : line.kind === 'remove'
                                ? 'bg-rose-50 text-rose-900'
                                : 'text-stone-700'
                          }`}
                        >
                          {line.kind === 'add' ? '+ ' : line.kind === 'remove' ? '- ' : '  '}
                          {line.text}
                        </pre>
                      ))}
                    </div>
                  ))}
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
