'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import qrcode from 'qrcode-generator';
import { SignInButton, SignUpButton, useClerk } from '@/lib/auth/optional-auth';
import { CheckCircleIcon, ChatTextIcon, CircleNotchIcon, XIcon } from '@phosphor-icons/react';
import { ModalShell } from '@/components/modal-shell';

type LinkTextStatus = {
  sunnyPhoneNumber: string;
  sunnyPhoneNumberE164: string;
  hasPhone: boolean;
  hasLinqChat: boolean;
  phoneNumber: string | null;
  clerkPhoneNumbers: string[];
  hasClerkPhone: boolean;
  linkedHere: boolean;
  linkedElsewhere: boolean;
  currentlyLinkedChatId: string | null;
  currentlyLinkedLabel: string | null;
};

function formatPhoneList(numbers: string[]): string {
  if (numbers.length === 0) return '';
  if (numbers.length === 1) return numbers[0];
  if (numbers.length === 2) return `${numbers[0]} or ${numbers[1]}`;
  return `${numbers.slice(0, -1).join(', ')}, or ${numbers[numbers.length - 1]}`;
}

type LinkTextChatModalProps = {
  open: boolean;
  chatId: string | null;
  chatLabel?: string | null;
  onClose: () => void;
};

const POLL_INTERVAL_MS = 4000;

export function LinkTextChatModal({ open, chatId, chatLabel, onClose }: LinkTextChatModalProps) {
  const { openUserProfile } = useClerk();
  const [status, setStatus] = useState<LinkTextStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<'link' | 'unlink' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsAuth, setNeedsAuth] = useState(false);
  const [justLinked, setJustLinked] = useState(false);

  const loadStatus = useCallback(async () => {
    if (!chatId) return;
    try {
      const res = await fetch(`/api/workspace/chats/link-text?chatId=${encodeURIComponent(chatId)}`);
      if (res.status === 401) {
        setNeedsAuth(true);
        return;
      }
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload?.error ?? `Status check failed (${res.status})`);
      }
      setNeedsAuth(false);
      const payload = (await res.json()) as LinkTextStatus;
      setStatus(payload);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to check link status');
    }
  }, [chatId]);

  useEffect(() => {
    if (!open || !chatId) return;
    setError(null);
    setNeedsAuth(false);
    setJustLinked(false);
    setStatus(null);
    setLoading(true);
    void loadStatus().finally(() => setLoading(false));
  }, [open, chatId, loadStatus]);

  useEffect(() => {
    if (!open || !chatId) return;
    if (!needsAuth && (status?.hasLinqChat || status?.linkedHere)) return;
    const id = window.setInterval(() => {
      void loadStatus();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [open, chatId, needsAuth, status?.hasLinqChat, status?.linkedHere, loadStatus]);

  const linkNow = useCallback(async () => {
    if (!chatId) return;
    setError(null);
    setBusy('link');
    try {
      const res = await fetch('/api/workspace/chats/link-text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId }),
      });
      const payload = (await res.json().catch(() => ({}))) as Partial<LinkTextStatus> & {
        error?: string;
        message?: string;
        linked?: boolean;
      };
      if (!res.ok) {
        setStatus((prev) => ({
          sunnyPhoneNumber: payload.sunnyPhoneNumber ?? prev?.sunnyPhoneNumber ?? '+1 (646) 261-7916',
          sunnyPhoneNumberE164: payload.sunnyPhoneNumberE164 ?? prev?.sunnyPhoneNumberE164 ?? '+16462617916',
          hasPhone: payload.hasPhone ?? prev?.hasPhone ?? false,
          hasLinqChat: payload.hasLinqChat ?? prev?.hasLinqChat ?? false,
          phoneNumber: payload.phoneNumber ?? prev?.phoneNumber ?? null,
          clerkPhoneNumbers: payload.clerkPhoneNumbers ?? prev?.clerkPhoneNumbers ?? [],
          hasClerkPhone: payload.hasClerkPhone ?? prev?.hasClerkPhone ?? false,
          linkedHere: payload.linkedHere ?? prev?.linkedHere ?? false,
          linkedElsewhere: payload.linkedElsewhere ?? prev?.linkedElsewhere ?? false,
          currentlyLinkedChatId: payload.currentlyLinkedChatId ?? prev?.currentlyLinkedChatId ?? null,
          currentlyLinkedLabel: payload.currentlyLinkedLabel ?? prev?.currentlyLinkedLabel ?? null,
        }));
        throw new Error(payload?.message ?? payload?.error ?? `Failed to link (${res.status})`);
      }
      setStatus(payload as LinkTextStatus);
      setJustLinked(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to link iMessage');
    } finally {
      setBusy(null);
    }
  }, [chatId]);

  const unlink = useCallback(async () => {
    if (!chatId) return;
    setError(null);
    setBusy('unlink');
    try {
      const res = await fetch('/api/workspace/chats/link-text', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload?.error ?? `Failed to unlink (${res.status})`);
      }
      const payload = (await res.json()) as LinkTextStatus;
      setStatus(payload);
      setJustLinked(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Failed to unlink iMessage');
    } finally {
      setBusy(null);
    }
  }, [chatId]);

  const sunnyDisplay = status?.sunnyPhoneNumber ?? '+1 (646) 261-7916';
  const sunnyE164 = status?.sunnyPhoneNumberE164 ?? '+16462617916';
  const messageHref = `sms:${sunnyE164}&body=hi`;
  const linkedHere = Boolean(status?.linkedHere);
  const canLink = Boolean(status?.hasLinqChat) && !linkedHere && !busy;
  const needsFirstText = Boolean(status && !linkedHere && (!status.hasPhone || !status.hasLinqChat));

  const qrRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open || !needsFirstText || !qrRef.current) return;
    const qr = qrcode(0, 'M');
    qr.addData(messageHref);
    qr.make();
    qrRef.current.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 1, scalable: true });
    const svg = qrRef.current.querySelector('svg');
    if (svg) {
      svg.setAttribute('width', '128');
      svg.setAttribute('height', '128');
      svg.style.borderRadius = '8px';
    }
  }, [open, needsFirstText, messageHref]);

  return (
    <ModalShell
      open={open}
      onClose={onClose}
      ariaLabel="Link text to chat"
      overlayClassName="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4"
      panelClassName="w-full max-w-md rounded-2xl border border-stone-200 bg-white shadow-xl"
    >
      <div className="px-5 pt-5 pb-5">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[11px] font-medium uppercase tracking-[0.16em] text-stone-400">
              Connect by text
            </div>
            <h2 className="mt-2 truncate text-base font-semibold text-stone-800">
              {chatLabel ? `Text ${chatLabel} from your phone` : 'Text this chat from your phone'}
            </h2>
            <p className="mt-1 text-xs text-stone-500">
              When connected, texting Sunny from your phone lands in this chat.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1 text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-600"
          >
            <XIcon className="h-5 w-5" weight="bold" aria-hidden />
          </button>
        </div>

        {needsAuth ? (
          <div
            data-testid="link-text-needs-auth"
            className="rounded-xl border border-stone-200 bg-stone-50 px-4 py-4 text-sm text-stone-700"
          >
            <div className="flex items-center gap-2 font-medium text-stone-800">
              <ChatTextIcon className="h-4 w-4" weight="regular" aria-hidden />
              Sign in to text Sunny from your phone
            </div>
            <p className="mt-2 text-stone-600">
              Texts are tied to your Sundial account so we can route them back to the right chats.
              Sign in or create an account to continue.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <SignInButton mode="modal">
                <button
                  type="button"
                  className="inline-flex items-center justify-center rounded-lg bg-stone-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-stone-800"
                >
                  Sign in
                </button>
              </SignInButton>
              <SignUpButton mode="modal">
                <button
                  type="button"
                  className="inline-flex items-center justify-center rounded-lg border border-stone-200 px-3 py-1.5 text-xs font-medium text-stone-700 transition-colors hover:bg-stone-100"
                >
                  Create account
                </button>
              </SignUpButton>
            </div>
          </div>
        ) : null}

        {!needsAuth && loading && !status ? (
          <div className="rounded-xl border border-stone-200 bg-stone-50 px-3 py-6 text-center text-sm text-stone-500">
            Checking link status…
          </div>
        ) : null}

        {!needsAuth && status && linkedHere ? (
          <div
            data-testid="link-text-status-linked"
            className="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-3 text-sm text-emerald-800"
          >
            <CheckCircleIcon className="mt-0.5 h-4 w-4 shrink-0" weight="fill" aria-hidden />
            <div className="min-w-0">
              <div className="font-medium">
                {justLinked ? 'Connected. Texts to Sunny will appear here.' : 'Texts from your phone land in this chat.'}
              </div>
              {status.phoneNumber ? (
                <div className="mt-0.5 text-xs text-emerald-700/80">
                  From <span className="font-mono">{status.phoneNumber}</span> →{' '}
                  <span className="font-mono">{sunnyDisplay}</span>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}

        {!needsAuth && status && needsFirstText && !status.hasClerkPhone ? (
          <div className="rounded-xl border border-stone-200 bg-stone-50 px-4 py-4 text-sm text-stone-700">
            <div className="flex items-center gap-2 font-medium text-stone-800">
              <ChatTextIcon className="h-4 w-4" weight="regular" aria-hidden />
              Add your phone first
            </div>
            <p className="mt-2 text-stone-600">
              We match inbound texts against the phone number on your Sundial account. Add a phone
              to your account, then text{' '}
              <span className="font-mono text-stone-900">{sunnyDisplay}</span> from it to finish
              connecting.
            </p>
            <button
              type="button"
              onClick={() => openUserProfile()}
              className="mt-3 inline-flex items-center justify-center rounded-lg bg-stone-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-stone-800"
            >
              Add phone to account
            </button>
          </div>
        ) : null}

        {!needsAuth && status && needsFirstText && status.hasClerkPhone ? (
          <div className="rounded-xl border border-stone-200 bg-stone-50 px-4 py-4 text-sm text-stone-700">
            <div className="flex items-center gap-2 font-medium text-stone-800">
              <ChatTextIcon className="h-4 w-4" weight="regular" aria-hidden />
              {status.hasPhone ? 'Send one more text to Sunny' : 'Text Sunny first'}
            </div>
            <div className="mt-3 flex items-start gap-4">
              <div
                ref={qrRef}
                aria-label={`QR code that opens iMessage to ${sunnyDisplay}`}
                className="shrink-0 rounded-lg border border-stone-200 bg-white p-1.5"
              />
              <div className="min-w-0 flex-1 text-stone-600">
                <p>
                  Text <span className="font-mono text-stone-900">{sunnyDisplay}</span> from{' '}
                  <span className="font-mono text-stone-900">
                    {formatPhoneList(status.clerkPhoneNumbers)}
                  </span>
                  . We match against the phone on your Sundial account, so any text from{' '}
                  {status.clerkPhoneNumbers.length > 1 ? 'one of those numbers' : 'that number'}{' '}
                  lands on your account automatically.
                </p>
                <a
                  href={messageHref}
                  className="mt-3 inline-flex items-center justify-center rounded-lg bg-stone-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-stone-800"
                >
                  Open iMessage
                </a>
              </div>
            </div>
            <p className="mt-3 text-[11px] text-stone-400">
              Texting from a different number will spin up a separate account — use a number on{' '}
              <button
                type="button"
                onClick={() => openUserProfile()}
                className="underline underline-offset-2 hover:text-stone-600"
              >
                your account
              </button>
              .
            </p>
          </div>
        ) : null}

        {!needsAuth && status && !linkedHere && status.hasLinqChat ? (
          <div className="space-y-3">
            <div className="rounded-xl border border-stone-200 bg-stone-50 px-4 py-4 text-sm text-stone-700">
              {status.linkedElsewhere ? (
                <div className="text-stone-600">
                  Your phone currently texts into{' '}
                  <span className="font-medium text-stone-800">
                    {status.currentlyLinkedLabel ?? 'another chat'}
                  </span>
                  . Moving it here means texts from{' '}
                  <span className="font-mono text-stone-900">{status.phoneNumber}</span> will land in
                  this chat instead.
                </div>
              ) : (
                <div className="text-stone-600">
                  Your iMessage thread with Sunny is{' '}
                  <span className="font-medium text-stone-800">not connected anywhere yet</span>.
                  Connecting will route texts from{' '}
                  <span className="font-mono text-stone-900">{status.phoneNumber}</span> into this
                  chat.
                </div>
              )}
            </div>
            <button
              type="button"
              data-testid="link-text-link-button"
              onClick={() => void linkNow()}
              disabled={!canLink}
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-stone-900 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-stone-800 disabled:cursor-not-allowed disabled:bg-stone-300"
            >
              {busy === 'link' ? (
                <CircleNotchIcon size={16} weight="bold" className="animate-spin" aria-hidden />
              ) : null}
              {busy === 'link'
                ? status.linkedElsewhere
                  ? 'Moving…'
                  : 'Connecting…'
                : status.linkedElsewhere
                  ? 'Move my texts here'
                  : 'Connect this chat to my phone'}
            </button>
          </div>
        ) : null}

        {!needsAuth && status && linkedHere ? (
          <div className="mt-4 flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => void unlink()}
              disabled={busy === 'unlink'}
              className="text-xs font-medium text-stone-500 underline-offset-4 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy === 'unlink' ? 'Disconnecting…' : 'Disconnect'}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-stone-800"
            >
              Done
            </button>
          </div>
        ) : null}

        {error ? (
          <div
            data-testid="link-text-error"
            className="mt-3 rounded-lg border border-orange-200 bg-orange-50 px-3 py-2 text-xs text-orange-700"
          >
            {error}
          </div>
        ) : null}
      </div>
    </ModalShell>
  );
}
