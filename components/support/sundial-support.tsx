'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowUpIcon,
  ChatCircleDotsIcon,
  FileIcon,
  PaperclipIcon,
  SpinnerGapIcon,
  XIcon,
} from '@phosphor-icons/react';
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from '@/components/ai-elements/conversation';
import {
  Message,
  MessageAttachments,
  MessageContent,
  MessageResponse,
} from '@/components/ai-elements/message';
import { createBrowserClient } from '@/lib/supabase/browser';
import { formatBytes } from '@/lib/workspace/uploads';
import type { SupportMessage, SupportThreadPayload } from '@/lib/support/types';

const OPEN_POLL_MS = 4_000;
const CLOSED_POLL_MS = 30_000;
const MAX_FILES = 5;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SUPPORT_EMAIL_KEY = 'sundial_support_email';

type Props = {
  workspaceId?: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  panelTarget: Element | null;
  fetchImpl?: typeof fetch;
};

function originUrl() {
  return typeof window === 'undefined' ? '' : `${window.location.origin}${window.location.pathname}`;
}

function supportUrl(workspaceId: string | null | undefined, summary = false) {
  const params = new URLSearchParams();
  if (workspaceId) params.set('workspaceId', workspaceId);
  const currentUrl = originUrl();
  if (currentUrl) params.set('originUrl', currentUrl);
  if (summary) params.set('summary', '1');
  return `/api/support/messages?${params.toString()}`;
}

function AttachmentLink({ message, index }: { message: SupportMessage; index: number }) {
  const attachment = message.attachments[index];
  if (!attachment) return null;
  const body = (
    <>
      <FileIcon className="h-3.5 w-3.5 shrink-0" weight="regular" aria-hidden />
      <span className="max-w-40 truncate">{attachment.name}</span>
      {typeof attachment.size === 'number' ? (
        <span className="shrink-0 text-[10px] opacity-60">{formatBytes(attachment.size)}</span>
      ) : null}
    </>
  );
  const classes =
    'flex max-w-full items-center gap-1.5 rounded-lg border border-stone-200 bg-white px-2.5 py-1.5 text-xs text-stone-600 transition-colors hover:border-stone-300 hover:text-stone-800';
  return attachment.signedUrl ? (
    <a className={classes} href={attachment.signedUrl} target="_blank" rel="noreferrer">
      {body}
    </a>
  ) : (
    <span className={classes}>{body}</span>
  );
}

export function SundialSupport({ workspaceId, open, onOpenChange, panelTarget, fetchImpl = fetch }: Props) {
  const [payload, setPayload] = useState<SupportThreadPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const loadInFlight = useRef<Promise<void> | null>(null);
  const loadInFlightIsSummary = useRef<boolean | null>(null);
  const optimisticIdsRef = useRef(new Set<string>());
  const payloadRef = useRef(payload);
  const openRef = useRef(open);
  const lastMarkedReadRef = useRef(0);
  payloadRef.current = payload;
  openRef.current = open;

  useEffect(() => {
    try {
      setContactEmail(window.localStorage.getItem(SUPPORT_EMAIL_KEY) ?? '');
    } catch {
      // Storage can be unavailable in private browsing; the field still works.
    }
  }, []);

  useEffect(() => {
    if (!payload?.contactEmail) return;
    setContactEmail(payload.contactEmail);
    try {
      window.localStorage.setItem(SUPPORT_EMAIL_KEY, payload.contactEmail);
    } catch {
      // Best-effort convenience only.
    }
  }, [payload?.contactEmail]);

  useEffect(() => {
    lastMarkedReadRef.current = 0;
  }, [payload?.threadId]);

  const load = useCallback(
    async (summary = false) => {
      if (loadInFlight.current) {
        const active = loadInFlight.current;
        // Opening support while the closed-state summary is still loading
        // must not leave an empty transcript until the next 4s poll.
        if (!summary && loadInFlightIsSummary.current) {
          await active;
          return load(false);
        }
        return active;
      }
      const request = (async () => {
        if (!summary) setLoading((value) => value || !payloadRef.current);
        try {
          const response = await fetchImpl(supportUrl(workspaceId, summary), {
            credentials: 'include',
            cache: 'no-store',
          });
          const body = (await response.json().catch(() => null)) as
            | (SupportThreadPayload & { error?: string })
            | null;
          if (!response.ok || !body) throw new Error(body?.error ?? 'Could not load Sundial Support.');
          setPayload((current) => {
            if (summary && current && current.threadId === body.threadId) {
              return { ...current, unreadCount: body.unreadCount, lastSequence: body.lastSequence, threadId: body.threadId };
            }
            if (!current || optimisticIdsRef.current.size === 0) return body;
            // A GET that started before POST can resolve after the optimistic
            // row was painted. Preserve those local rows until POST returns,
            // otherwise the message visibly disappears and then reappears.
            const optimistic = current.messages.filter(
              (message) =>
                optimisticIdsRef.current.has(message.id) &&
                !body.messages.some((serverMessage) => serverMessage.id === message.id),
            );
            return optimistic.length
              ? {
                  ...body,
                  messages: [...body.messages, ...optimistic].sort((a, b) => a.sequence - b.sequence),
                  lastSequence: Math.max(body.lastSequence, ...optimistic.map((message) => message.sequence)),
                }
              : body;
          });
          setError(null);
          if (
            !summary &&
            openRef.current &&
            body.lastSequence > lastMarkedReadRef.current
          ) {
            lastMarkedReadRef.current = body.lastSequence;
            void fetchImpl('/api/support/messages', {
              method: 'PATCH',
              credentials: 'include',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ lastReadSequence: body.lastSequence }),
            });
            setPayload((current) => (current ? { ...current, unreadCount: 0 } : current));
          }
        } catch (nextError) {
          if (!summary) setError(nextError instanceof Error ? nextError.message : 'Could not load Sundial Support.');
        } finally {
          if (!summary) setLoading(false);
          loadInFlight.current = null;
          loadInFlightIsSummary.current = null;
        }
      })();
      loadInFlight.current = request;
      loadInFlightIsSummary.current = summary;
      return request;
    },
    [fetchImpl, workspaceId],
  );

  useEffect(() => {
    void load(!open);
    const timer = window.setInterval(() => void load(!open), open ? OPEN_POLL_MS : CLOSED_POLL_MS);
    return () => window.clearInterval(timer);
  }, [load, open]);

  useEffect(() => {
    if (!open || !payload?.threadId) return;
    const supabase = createBrowserClient();
    if (!supabase) return;
    const channel = supabase
      .channel(`support:${payload.threadId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'support_messages',
          filter: `thread_id=eq.${payload.threadId}`,
        },
        () => void load(false),
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [load, open, payload?.threadId]);

  useEffect(() => {
    if (open) window.setTimeout(() => textareaRef.current?.focus(), 100);
  }, [open]);

  const fileError = useMemo(() => {
    if (files.length > MAX_FILES) return 'Attach up to 5 files.';
    if (files.some((file) => file.size > MAX_FILE_BYTES)) return 'Each file must be 10 MB or smaller.';
    if (files.reduce((sum, file) => sum + file.size, 0) > MAX_TOTAL_BYTES) return 'Attachments must total 20 MB or less.';
    return null;
  }, [files]);

  const addFiles = (incoming: File[]) => {
    setFiles((current) => [...current, ...incoming].slice(0, MAX_FILES));
    if (inputRef.current) inputRef.current.value = '';
  };

  const send = async () => {
    const content = draft.trim();
    if (sending || fileError || (!content && files.length === 0)) return;
    const email = payload?.contactEmail || contactEmail.trim();
    if (!EMAIL_RE.test(email)) {
      setError('Add a valid email so support can notify you about the reply.');
      return;
    }
    const clientId = crypto.randomUUID();
    const optimistic: SupportMessage = {
      id: clientId,
      threadId: payload?.threadId ?? '',
      sequence: (payload?.lastSequence ?? 0) + 1,
      role: 'user',
      content,
      attachments: files.map((file) => ({
        path: '',
        name: file.name,
        mime: file.type || null,
        size: file.size,
      })),
      createdAt: new Date().toISOString(),
      responseStatus: 'pending',
    };
    const previousDraft = draft;
    const previousFiles = files;
    optimisticIdsRef.current.add(clientId);
    setDraft('');
    setFiles([]);
    setSending(true);
    setError(null);
    setPayload((current) =>
      current
        ? {
            ...current,
            messages: [...current.messages.filter((message) => message.id !== clientId), optimistic],
            lastSequence: optimistic.sequence,
          }
        : current,
    );
    try {
      const form = new FormData();
      form.set('content', content);
      form.set('clientId', clientId);
      form.set('originUrl', originUrl());
      form.set('contactEmail', email);
      if (workspaceId) form.set('workspaceId', workspaceId);
      previousFiles.forEach((file) => form.append('files', file));
      const response = await fetchImpl('/api/support/messages', {
        method: 'POST',
        credentials: 'include',
        body: form,
      });
      const body = (await response.json().catch(() => null)) as { message?: SupportMessage; error?: string } | null;
      if (!response.ok || !body?.message) throw new Error(body?.error ?? 'Could not send your message.');
      setPayload((current) => {
        optimisticIdsRef.current.delete(clientId);
        return current
          ? {
              ...current,
              messages: [...current.messages.filter((message) => message.id !== clientId), body.message!].sort(
                (a, b) => a.sequence - b.sequence,
              ),
              lastSequence: Math.max(current.lastSequence, body.message!.sequence),
            }
          : {
              threadId: body.message!.threadId,
              messages: [body.message!],
              unreadCount: 0,
              lastSequence: body.message!.sequence,
              contactEmail: email,
            };
      });
      window.setTimeout(() => void load(false), 700);
    } catch (nextError) {
      optimisticIdsRef.current.delete(clientId);
      setPayload((current) =>
        current ? { ...current, messages: current.messages.filter((message) => message.id !== clientId) } : current,
      );
      setDraft(previousDraft);
      setFiles(previousFiles);
      setError(nextError instanceof Error ? nextError.message : 'Could not send your message.');
    } finally {
      setSending(false);
    }
  };

  const waiting = payload?.messages.some(
    (message) => message.role === 'user' && message.responseStatus && message.responseStatus !== 'answered',
  );

  return (
    <>
      <button
        type="button"
        onClick={() => onOpenChange(true)}
        data-testid="sundial-support-button"
        aria-pressed={open}
        className="group flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-xs text-stone-500 transition-colors hover:bg-stone-100 hover:text-stone-700 max-sm:hidden"
      >
        <span className="truncate font-medium">Sundial Support</span>
        <span className="relative flex h-5 w-5 shrink-0 items-center justify-center text-stone-700">
          <ChatCircleDotsIcon className="h-4 w-4" weight="regular" aria-hidden />
          {payload?.unreadCount ? (
            <span className="absolute -right-1 -top-1 flex h-3.5 min-w-3.5 animate-pulse items-center justify-center rounded-full bg-stone-800 px-0.5 text-[8px] font-semibold text-white motion-reduce:animate-none">
              {Math.min(payload.unreadCount, 9)}
            </span>
          ) : null}
        </span>
      </button>

      {open && panelTarget
        ? createPortal(
          <section
            data-testid="sundial-support-panel"
            aria-label="Sundial Support"
            className="flex min-h-0 flex-1 flex-col bg-stone-50"
          >
          <header className="flex shrink-0 items-center justify-between gap-3 border-b border-stone-200 bg-white px-4 py-3">
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold text-stone-900">Sundial Support</h2>
              <p className="mt-0.5 truncate text-[11px] text-stone-500">Product help · replies may be AI-assisted</p>
            </div>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              aria-label="Close Sundial Support"
              className="flex h-7 w-7 shrink-0 items-center justify-center rounded text-stone-400 hover:bg-stone-100 hover:text-stone-700"
            >
              <XIcon className="h-4 w-4" weight="bold" aria-hidden />
            </button>
          </header>

          <Conversation className="min-h-0 bg-stone-50">
            <ConversationContent className="gap-5 px-5 py-6">
              {loading && !payload ? (
                <div className="flex min-h-64 items-center justify-center text-stone-400">
                  <SpinnerGapIcon className="h-5 w-5 animate-spin" aria-label="Loading support chat" />
                </div>
              ) : payload?.messages.length ? (
                payload.messages.map((message) => (
                  <Message key={message.id} from={message.role === 'assistant' ? 'assistant' : 'user'}>
                    {message.role === 'assistant' ? (
                      <div className="mb-0.5 flex items-center gap-2 text-[11px] font-medium text-stone-400">
                        <span className="flex h-5 w-5 items-center justify-center text-stone-600">
                          <ChatCircleDotsIcon className="h-3.5 w-3.5" weight="regular" aria-hidden />
                        </span>
                        Sundial Support
                      </div>
                    ) : null}
                    {message.content ? (
                      <MessageContent>
                        {message.role === 'assistant' ? (
                          <MessageResponse>{message.content}</MessageResponse>
                        ) : (
                          <span className="whitespace-pre-wrap">{message.content}</span>
                        )}
                      </MessageContent>
                    ) : null}
                    {message.attachments.length ? (
                      <MessageAttachments className={message.role === 'assistant' ? 'ml-0' : undefined}>
                        {message.attachments.map((_, index) => (
                          <AttachmentLink key={`${message.id}:${index}`} message={message} index={index} />
                        ))}
                      </MessageAttachments>
                    ) : null}
                  </Message>
                ))
              ) : (
                <ConversationEmptyState className="min-h-80" title="How can we help?" description="Ask about Sundial, report a bug, or share feedback. This conversation stays with your account.">
                  <div className="mx-auto flex max-w-xs flex-col items-center gap-3 text-center">
                    <span className="flex h-12 w-12 items-center justify-center rounded-xl border border-stone-200 bg-white text-stone-700">
                      <ChatCircleDotsIcon className="h-6 w-6" weight="regular" aria-hidden />
                    </span>
                    <div>
                      <h3 className="text-sm font-semibold text-stone-800">How can we help?</h3>
                      <p className="mt-1 text-sm leading-relaxed text-stone-500">
                        Ask about Sundial, report a bug, or share feedback. This conversation stays with your account.
                      </p>
                    </div>
                  </div>
                </ConversationEmptyState>
              )}
              {waiting ? (
                <div className="flex items-center gap-2 text-xs text-stone-400" data-testid="support-replying">
                  <SpinnerGapIcon className="h-3.5 w-3.5 animate-spin" aria-hidden />
                  Sundial Support is replying
                </div>
              ) : null}
            </ConversationContent>
            <ConversationScrollButton />
          </Conversation>

          <div className="shrink-0 border-t border-stone-200 bg-white p-3">
            {!payload?.contactEmail ? (
              <label className="mb-2 block">
                <span className="sr-only">Email for support replies</span>
                <input
                  type="email"
                  value={contactEmail}
                  onChange={(event) => setContactEmail(event.target.value.slice(0, 320))}
                  placeholder="Email for reply notifications"
                  aria-label="Email for support replies"
                  autoComplete="email"
                  className="h-9 w-full rounded-lg border border-stone-200 bg-stone-50 px-3 text-sm text-stone-800 outline-none placeholder:text-stone-400 focus:border-stone-300 focus:ring-2 focus:ring-stone-100"
                />
              </label>
            ) : null}
            {files.length ? (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {files.map((file, index) => (
                  <span key={`${file.name}:${file.lastModified}:${index}`} className="flex max-w-full items-center gap-1.5 rounded-md bg-stone-100 px-2 py-1 text-xs text-stone-600">
                    <FileIcon className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    <span className="max-w-44 truncate">{file.name}</span>
                    <button type="button" onClick={() => setFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))} aria-label={`Remove ${file.name}`} className="rounded text-stone-400 hover:text-stone-700">
                      <XIcon className="h-3 w-3" weight="bold" aria-hidden />
                    </button>
                  </span>
                ))}
              </div>
            ) : null}
            {error || fileError ? <p className="mb-2 text-xs text-rose-600">{fileError ?? error}</p> : null}
            <div className="flex items-end gap-2 rounded-xl border border-stone-200 bg-stone-50 p-2 focus-within:border-stone-300 focus-within:ring-2 focus-within:ring-stone-100">
              <input ref={inputRef} type="file" multiple className="hidden" onChange={(event) => addFiles(Array.from(event.target.files ?? []))} />
              <button type="button" onClick={() => inputRef.current?.click()} aria-label="Attach files" className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-stone-400 hover:bg-stone-200/70 hover:text-stone-600">
                <PaperclipIcon className="h-4 w-4" weight="bold" aria-hidden />
              </button>
              <textarea
                ref={textareaRef}
                value={draft}
                onChange={(event) => setDraft(event.target.value.slice(0, 8_000))}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    void send();
                  }
                }}
                rows={1}
                placeholder="Message Sundial Support"
                aria-label="Message Sundial Support"
                className="max-h-32 min-h-8 flex-1 resize-none bg-transparent px-1 py-1.5 text-sm leading-5 text-stone-800 outline-none placeholder:text-stone-400"
              />
              <button
                type="button"
                onClick={() => void send()}
                disabled={sending || Boolean(fileError) || (!draft.trim() && files.length === 0)}
                aria-label="Send support message"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-stone-900 text-white transition-colors hover:bg-stone-700 disabled:bg-stone-200 disabled:text-stone-400"
              >
                {sending ? <SpinnerGapIcon className="h-4 w-4 animate-spin" aria-hidden /> : <ArrowUpIcon className="h-4 w-4" weight="bold" aria-hidden />}
              </button>
            </div>
            <p className="mt-1.5 px-1 text-[10px] text-stone-400">Enter to send · Shift+Enter for a new line</p>
          </div>
          </section>,
          panelTarget,
        )
        : null}
    </>
  );
}
