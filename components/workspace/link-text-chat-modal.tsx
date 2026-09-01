'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import qrcode from 'qrcode-generator';
import { SignInButton, SignUpButton } from '@/lib/auth/optional-auth';
import { CheckCircleIcon, ChatTextIcon, CircleNotchIcon, XIcon } from '@phosphor-icons/react';
import { ModalShell } from '@/components/modal-shell';

type LinkTextStatus = {
  sunnyPhoneNumber: string;
  sunnyPhoneNumberE164: string;
  hasPhone: boolean;
  hasLinqChat: boolean;
  phoneNumber: string | null;
  linkedHere: boolean;
  linkedElsewhere: boolean;
  currentlyLinkedChatId: string | null;
  currentlyLinkedLabel: string | null;
  // Set when the line this chat was linked through is no longer delivering
  // (Linq reputation flagged) — the user must re-link to the current number.
  retiredNumber: string | null;
};

type LinkTextChatModalProps = {
  open: boolean;
  chatId: string | null;
  chatLabel?: string | null;
  onClose: () => void;
};

const POLL_INTERVAL_MS = 4000;

export function LinkTextChatModal({ open, chatId, chatLabel, onClose }: LinkTextChatModalProps) {
  const [status, setStatus] = useState<LinkTextStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<'link' | 'unlink' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsAuth, setNeedsAuth] = useState(false);
  const [justLinked, setJustLinked] = useState(false);
  // One-tap link code: texting it from the phone is what proves ownership,
  // so no phone number is ever typed here and no Clerk phone is required.
  const [linkCode, setLinkCode] = useState<{ code: string; smsBody: string; expiresAt: number } | null>(null);

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

  const requestLinkCode = useCallback(async () => {
    if (!chatId) return;
    try {
      const res = await fetch('/api/workspace/chats/link-text/code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chatId }),
      });
      if (res.status === 401) {
        setNeedsAuth(true);
        return;
      }
      if (!res.ok) throw new Error(`Could not create a link code (${res.status})`);
      const payload = (await res.json()) as { code: string; smsBody: string; expiresAt?: string };
      const expiresAt = payload.expiresAt ? Date.parse(payload.expiresAt) : Date.now() + 15 * 60_000;
      setLinkCode({ code: payload.code, smsBody: payload.smsBody, expiresAt });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not create a link code');
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
    // A retired line still has hasLinqChat/linkedHere set, but we ARE waiting
    // for a text (the relink) — keep polling until it lands.
    if (!needsAuth && !status?.retiredNumber && (status?.hasLinqChat || status?.linkedHere)) return;
    // Polling is how the "waiting for your text" state resolves: the inbound
    // claim happens server-side, so nothing tells this tab but a refetch.
    const id = window.setInterval(() => {
      void loadStatus();
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [open, chatId, needsAuth, status?.hasLinqChat, status?.linkedHere, status?.retiredNumber, loadStatus]);

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
          linkedHere: payload.linkedHere ?? prev?.linkedHere ?? false,
          linkedElsewhere: payload.linkedElsewhere ?? prev?.linkedElsewhere ?? false,
          currentlyLinkedChatId: payload.currentlyLinkedChatId ?? prev?.currentlyLinkedChatId ?? null,
          currentlyLinkedLabel: payload.currentlyLinkedLabel ?? prev?.currentlyLinkedLabel ?? null,
          retiredNumber: payload.retiredNumber ?? prev?.retiredNumber ?? null,
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
  const linkedHere = Boolean(status?.linkedHere) && !status?.retiredNumber;
  // A retired line's linq_chat_id is dead, so "move my texts here" would act
  // on a chat that can never deliver — only a fresh text can rebind it.
  const lineRetired = Boolean(status?.retiredNumber);
  const canLink = Boolean(status?.hasLinqChat) && !linkedHere && !lineRetired && !busy;
  // Needs the phone to text us: never linked, linked elsewhere with nothing
  // usable here, or bound to a line that stopped delivering.
  const needsFirstText = Boolean(
    status && (lineRetired || (!linkedHere && (!status.hasPhone || !status.hasLinqChat)))
  );
  const messageHref = `sms:${sunnyE164}${linkCode ? `&body=${encodeURIComponent(linkCode.smsBody)}` : ''}`;

  // Mint the code as soon as we know the user needs to text — it's what the
  // QR and the deep link carry — and re-mint before it expires, since this
  // panel is frequently left open longer than the code's TTL.
  useEffect(() => {
    if (!open || !chatId || needsAuth || !needsFirstText) return;
    if (!linkCode) {
      void requestLinkCode();
      return;
    }
    const msLeft = linkCode.expiresAt - Date.now() - 30_000;
    if (msLeft <= 0) {
      void requestLinkCode();
      return;
    }
    const id = window.setTimeout(() => void requestLinkCode(), msLeft);
    return () => window.clearTimeout(id);
  }, [open, chatId, needsAuth, needsFirstText, linkCode, requestLinkCode]);

  useEffect(() => {
    if (!open) setLinkCode(null);
  }, [open]);

  const qrRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open || !needsFirstText || !linkCode || !qrRef.current) return;
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
  }, [open, needsFirstText, linkCode, messageHref]);

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
              Texts you send Sunny will show up in this chat.
            </p>
            <p data-testid="link-text-alpha-note" className="mt-1.5 text-[11px] text-stone-400">
              Alpha: Sunny&rsquo;s number can change. This panel always shows the current one.
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

        {!needsAuth && status?.retiredNumber ? (
          <div
            data-testid="link-text-retired-number"
            className="mb-3 rounded-xl border border-stone-200 bg-white px-4 py-3 text-sm text-stone-700"
          >
            <div className="font-medium text-stone-800">That number stopped working</div>
            <p className="mt-1 text-stone-600">
              <span className="font-mono">{status.retiredNumber}</span> is no longer delivering
              messages. Reconnect below to use{' '}
              <span className="font-mono text-stone-900">{sunnyDisplay}</span> instead. Your chat
              history stays.
            </p>
          </div>
        ) : null}

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
              Your texts are routed through your account. Sign in or create one to continue.
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
                {justLinked ? 'Connected. Texts to Sundial Agent will appear here.' : 'Texts from your phone land in this chat.'}
              </div>
              {status.phoneNumber ? (
                <div className="mt-0.5 text-xs text-emerald-700/80">
                  From <span className="font-mono">{status.phoneNumber}</span> →{' '}
                  <span className="font-mono">{sunnyDisplay}</span>
                </div>
              ) : null}
              <div className="mt-1.5 text-xs text-emerald-700/80">
                Text <span className="font-mono">/chats</span> to see every chat in all your
                workspaces, <span className="font-mono">/go &lt;name&gt;</span> to switch, and{' '}
                <span className="font-mono">/inbox on</span> to get messages from all workspaces
                here. <span className="font-mono">/help</span> lists everything.
              </div>
            </div>
          </div>
        ) : null}

        {!needsAuth && status && needsFirstText ? (
          <div className="rounded-xl border border-stone-200 bg-stone-50 px-4 py-4 text-sm text-stone-700">
            <div className="flex items-center gap-2 font-medium text-stone-800">
              <ChatTextIcon className="h-4 w-4" weight="regular" aria-hidden />
              Text this code to connect
            </div>
            <div className="mt-3 flex items-start gap-4">
              <div
                ref={qrRef}
                aria-label={`QR code that opens iMessage to ${sunnyDisplay}`}
                data-testid="link-text-qr"
                className="shrink-0 rounded-lg border border-stone-200 bg-white p-1.5"
                style={{ width: 128, height: 128 }}
              />
              <div className="min-w-0 flex-1 text-stone-600">
                <p>
                  Scan the QR or tap the button. It opens Messages with the code filled in, ready
                  to send to <span className="font-mono text-stone-900">{sunnyDisplay}</span>. Send
                  it and this chat is connected to your phone.
                </p>
                <div
                  data-testid="link-text-code"
                  className="mt-2 font-mono text-base tracking-[0.2em] text-stone-900"
                >
                  {linkCode?.code ?? '……'}
                </div>
                <a
                  href={messageHref}
                  data-testid="link-text-open-messages"
                  className={`mt-3 inline-flex items-center justify-center rounded-lg px-3 py-1.5 text-xs font-medium text-white transition-colors ${
                    linkCode ? 'bg-stone-900 hover:bg-stone-800' : 'pointer-events-none bg-stone-300'
                  }`}
                >
                  Open Messages
                </a>
              </div>
            </div>
            <p className="mt-3 flex items-center gap-1.5 text-[11px] text-stone-400">
              <CircleNotchIcon className="h-3 w-3 animate-spin" weight="bold" aria-hidden />
              Waiting for your text…
            </p>
          </div>
        ) : null}

        {!needsAuth && status && !linkedHere && !lineRetired && status.hasLinqChat ? (
          <div className="space-y-3">
            <div className="rounded-xl border border-stone-200 bg-stone-50 px-4 py-4 text-sm text-stone-700">
              {status.linkedElsewhere ? (
                <div className="text-stone-600">
                  Your phone is connected to{' '}
                  <span className="font-medium text-stone-800">
                    {status.currentlyLinkedLabel ?? 'another chat'}
                  </span>
                  . Move it here and texts from{' '}
                  <span className="font-mono text-stone-900">{status.phoneNumber}</span> will land
                  in this chat instead.
                </div>
              ) : (
                <div className="text-stone-600">
                  Your phone{' '}
                  <span className="font-medium text-stone-800">isn&rsquo;t connected to a chat yet</span>.
                  Connect it and texts from{' '}
                  <span className="font-mono text-stone-900">{status.phoneNumber}</span> will land
                  here.
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
