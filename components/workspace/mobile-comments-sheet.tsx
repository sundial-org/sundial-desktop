'use client';

import { useEffect, useRef, useState } from 'react';
import { XIcon } from '@phosphor-icons/react';
import type { DocCommentThread, DraftDocCommentSelection } from '@/lib/workspace/doc-comments';
import { clipCommentQuote } from '@/lib/workspace/doc-comments';

/**
 * The phone surface for comments: a bottom sheet over the document. The
 * desktop lane positions cards beside their anchors, which has no analog on a
 * small screen — here threads are a plain list with reply and resolve, plus
 * the composer whenever a draft selection exists (selection-bubble Comment,
 * PDF-selection Comment). Opened by the same state the desktop lane uses
 * (selecting a thread, starting a draft), closed with the grab bar or X.
 */
export function MobileCommentsSheet({
  open,
  threads,
  activeThreadId,
  draftSelection,
  draftBody,
  busyAction,
  canComment,
  onCreate,
  onCancelDraft,
  onReply,
  onResolve,
  onSelectThread,
  onClose,
}: {
  open: boolean;
  threads: DocCommentThread[];
  activeThreadId: string | null;
  draftSelection: DraftDocCommentSelection | null;
  draftBody: string;
  busyAction: string | null;
  canComment: boolean;
  onCreate: (body: string) => void;
  onCancelDraft: () => void;
  onReply: (threadId: string, body: string) => void;
  onResolve: (threadId: string, action: 'resolve' | 'reopen') => void;
  onSelectThread: (threadId: string | null) => void;
  onClose: () => void;
}) {
  const [composerText, setComposerText] = useState('');
  const [replyText, setReplyText] = useState<Record<string, string>>({});
  const activeCardRef = useRef<HTMLDivElement | null>(null);
  // Seed the composer with a restored draft body (a failed create hands the
  // typed text back); reset when the draft goes away.
  useEffect(() => {
    setComposerText(draftBody);
  }, [draftBody, draftSelection]);
  useEffect(() => {
    if (open && activeThreadId) {
      activeCardRef.current?.scrollIntoView?.({ block: 'nearest' });
    }
  }, [open, activeThreadId]);
  if (!open) return null;

  return (
    <div
      data-testid="mobile-comments-sheet"
      className="fixed inset-x-0 bottom-0 z-[70] flex max-h-[70vh] flex-col rounded-t-2xl border-t border-stone-200 bg-white shadow-[0_-8px_32px_-12px_rgba(28,25,23,0.35)]"
    >
      <div className="flex items-center justify-between border-b border-stone-100 px-4 py-2.5">
        <div className="text-sm font-medium text-stone-800">
          Comments{threads.length > 0 ? ` (${threads.length})` : ''}
        </div>
        <button
          type="button"
          data-testid="mobile-comments-close"
          onClick={onClose}
          aria-label="Close comments"
          className="rounded p-1.5 text-stone-500 hover:bg-stone-100"
        >
          <XIcon className="h-4 w-4" weight="bold" aria-hidden />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {draftSelection && canComment ? (
          <div data-testid="mobile-comment-composer" className="mb-4 rounded-xl border border-amber-200 bg-amber-50/50 p-3">
            <div className="mb-2 border-l-2 border-amber-300 pl-2 text-xs italic text-stone-500">
              {clipCommentQuote(draftSelection.quote, 120)}
            </div>
            <textarea
              value={composerText}
              onChange={(event) => setComposerText(event.target.value)}
              placeholder="Comment…"
              rows={2}
              className="w-full resize-none rounded-lg border border-stone-200 bg-white px-2.5 py-1.5 text-sm text-stone-800 outline-none focus:border-stone-400"
            />
            <div className="mt-2 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={onCancelDraft}
                className="rounded px-2 py-1 text-xs text-stone-500 hover:bg-stone-100"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="mobile-comment-submit"
                onClick={() => {
                  if (composerText.trim()) onCreate(composerText);
                }}
                disabled={!composerText.trim() || busyAction === 'create'}
                className="rounded border border-amber-300 bg-white px-2.5 py-1 text-xs font-medium text-amber-800 hover:bg-amber-50 disabled:opacity-40"
              >
                Comment
              </button>
            </div>
          </div>
        ) : null}
        {threads.length === 0 && !draftSelection ? (
          <div className="py-6 text-center text-sm text-stone-400">No comments yet.</div>
        ) : null}
        {threads.map((thread) => {
          const active = thread.id === activeThreadId;
          return (
            <div
              key={thread.clientKey ?? thread.id}
              ref={active ? activeCardRef : undefined}
              data-testid={`mobile-comment-thread-${thread.id}`}
              onClick={() => onSelectThread(thread.id)}
              className={`mb-3 rounded-xl border p-3 ${
                active ? 'border-amber-300 bg-amber-50/40' : 'border-stone-200'
              }`}
            >
              <div className="mb-1 border-l-2 border-stone-200 pl-2 text-xs italic text-stone-500">
                {clipCommentQuote(thread.quote, 100)}
              </div>
              {thread.messages.map((message) => (
                <div key={message.id} className="mt-1.5 text-sm text-stone-800">
                  <span className="font-medium">{message.author.name ?? 'Someone'}</span>{' '}
                  <span className="text-stone-700">{message.body}</span>
                </div>
              ))}
              {active && canComment ? (
                <div className="mt-2 flex items-center gap-2">
                  <input
                    value={replyText[thread.id] ?? ''}
                    onChange={(event) =>
                      setReplyText((prev) => ({ ...prev, [thread.id]: event.target.value }))
                    }
                    placeholder="Reply…"
                    className="min-w-0 flex-1 rounded-lg border border-stone-200 px-2.5 py-1.5 text-sm outline-none focus:border-stone-400"
                  />
                  <button
                    type="button"
                    data-testid={`mobile-comment-reply-${thread.id}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      const body = (replyText[thread.id] ?? '').trim();
                      if (!body) return;
                      onReply(thread.id, body);
                      setReplyText((prev) => ({ ...prev, [thread.id]: '' }));
                    }}
                    className="rounded px-2 py-1 text-xs font-medium text-stone-700 hover:bg-stone-100"
                  >
                    Reply
                  </button>
                  <button
                    type="button"
                    data-testid={`mobile-comment-resolve-${thread.id}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      onResolve(thread.id, thread.status === 'resolved' ? 'reopen' : 'resolve');
                    }}
                    className="rounded px-2 py-1 text-xs text-stone-500 hover:bg-stone-100"
                  >
                    {thread.status === 'resolved' ? 'Reopen' : 'Resolve'}
                  </button>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
