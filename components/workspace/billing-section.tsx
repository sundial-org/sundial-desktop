'use client';
import { useState } from 'react';
import { useCreditSummary } from '@/lib/credits/use-credit-summary';
import {
  microsToUsd,
  microsToCredits,
  PLAN_PLUS_MICROS,
  PLAN_PRO_MICROS,
} from '@/lib/credits/constants';
import { Spinner } from '@/components/ui/spinner';

type PaidPlan = 'plus20' | 'pro100';

// Prices shown net of the always-applied 40% .edu discount (EDU40); `was` is the
// list price. Credits/mo derive from the grant constants so they track the unit.
const PLANS: { key: PaidPlan; name: string; price: string; was: string; credits: number; blurb: string }[] = [
  { key: 'plus20', name: 'Plus', price: '$12', was: '$20', credits: microsToCredits(PLAN_PLUS_MICROS), blurb: 'steady drafting, analysis, and Sunny on call' },
  { key: 'pro100', name: 'Max', price: '$60', was: '$100', credits: microsToCredits(PLAN_PRO_MICROS), blurb: 'for heavy seasons — top up anytime' },
];

const TOPUPS = [5, 20, 50];

export function BillingSection() {
  const { summary, loading, ready, refresh } = useCreditSummary();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  async function post(url: string, body?: unknown): Promise<Record<string, unknown> | null> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new Error((data.error as string) || `Request failed (${res.status})`);
    return data;
  }

  async function run(tag: string, fn: () => Promise<void>) {
    setError('');
    setBusy(tag);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(null);
    }
  }

  // Return to the workspace the user is in after Stripe checkout (not the app root).
  const returnPath = typeof window !== 'undefined' ? window.location.pathname : undefined;

  const subscribe = (plan: PaidPlan) =>
    run(`sub:${plan}`, async () => {
      const data = await post('/api/stripe/checkout', { kind: 'subscription', plan, returnPath });
      if (data?.checkoutUrl) window.location.href = data.checkoutUrl as string;
    });

  const topUp = (amountUsd: number) =>
    run(`topup:${amountUsd}`, async () => {
      const data = await post('/api/stripe/checkout', { kind: 'topup', amountUsd, returnPath });
      if (data?.checkoutUrl) window.location.href = data.checkoutUrl as string;
    });

  const manage = () =>
    run('portal', async () => {
      const data = await post('/api/stripe/portal');
      if (data?.url) window.location.href = data.url as string;
    });

  if (loading && !ready) {
    return <div className="p-4 text-[13px]"><Spinner label="Loading billing…" /></div>;
  }
  if (!summary) {
    return <div className="p-4 text-[13px] text-stone-500">Sign in to manage billing.</div>;
  }

  const plan = summary.plan;
  const onPaidPlan = plan === 'plus20' || plan === 'pro100';
  const low = summary.balanceMicros <= 0;

  return (
    <div className="space-y-6 p-1">
      {/* Balance */}
      <div className="rounded-2xl border border-stone-200 bg-stone-50 p-4">
        <div className="text-[11px] font-medium uppercase tracking-[0.12em] text-stone-400">
          AI credits
        </div>
        <div className={`mt-1 text-2xl font-semibold ${low ? 'text-red-600' : 'text-stone-700'}`}>
          {summary.credits.toLocaleString()}{' '}
          <span className="text-sm font-normal text-stone-400">
            (≈ ${microsToUsd(summary.balanceMicros).toFixed(2)})
          </span>
        </div>
        <div className="mt-1 text-[12px] text-stone-500">
          {plan === 'free' ? 'Free plan' : `${plan === 'plus20' ? 'Plus' : 'Max'} plan`}
          {summary.subscriptionStatus !== 'inactive' ? ` · ${summary.subscriptionStatus}` : ''}
          {summary.meteredOverflowEnabled ? ' · pay-as-you-go on' : ''}
        </div>
      </div>

      {!summary.stripeConfigured && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-700">
          Billing isn’t configured in this environment yet. Your free credits still work.
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
          {error}
        </div>
      )}

      {/* Plans */}
      <div>
        <div className="mb-2 text-[13px] font-medium text-stone-700">Subscriptions</div>
        <div className="grid grid-cols-2 gap-3">
          {PLANS.map((p) => {
            const current = plan === p.key;
            return (
              <div
                key={p.key}
                className={`rounded-xl border p-3 ${
                  current ? 'border-orange bg-orange/5' : 'border-stone-200'
                }`}
              >
                <div className="flex items-baseline justify-between">
                  <span className="text-[14px] font-semibold text-stone-800">{p.name}</span>
                  <span className="text-[13px] text-stone-700">
                    <span className="font-semibold">{p.price}</span>
                    <span className="text-stone-400 line-through ml-1">{p.was}</span>
                    <span className="text-stone-400">/mo</span>
                  </span>
                </div>
                <div className="mt-1 text-[12px] text-stone-500">
                  {p.credits.toLocaleString()} credits / mo · {p.blurb}
                </div>
                <button
                  type="button"
                  disabled={
                    current || !summary.stripeConfigured || busy === `sub:${p.key}` || busy === 'portal'
                  }
                  // Already subscribed → switch plans via the billing portal
                  // (Stripe prorates there); avoids creating a 2nd subscription.
                  onClick={() => (onPaidPlan ? manage() : subscribe(p.key))}
                  className="mt-3 w-full rounded-lg bg-orange px-3 py-1.5 text-[12px] font-medium text-white transition-colors hover:bg-orange-deep disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {current
                    ? 'Current plan'
                    : busy === `sub:${p.key}` || (onPaidPlan && busy === 'portal')
                      ? '…'
                      : onPaidPlan
                        ? 'Switch in portal'
                        : 'Upgrade'}
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Top-ups */}
      <div>
        <div className="mb-2 text-[13px] font-medium text-stone-700">Buy credits (one-time)</div>
        <div className="flex gap-2">
          {TOPUPS.map((amt) => (
            <button
              key={amt}
              type="button"
              disabled={!summary.stripeConfigured || busy === `topup:${amt}`}
              onClick={() => topUp(amt)}
              className="flex-1 rounded-lg border border-stone-200 px-3 py-1.5 text-[12px] font-medium text-stone-700 transition-colors hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {busy === `topup:${amt}` ? '…' : `$${amt}`}
            </button>
          ))}
        </div>
      </div>

      {onPaidPlan && summary.stripeConfigured && (
        <button
          type="button"
          onClick={manage}
          disabled={busy === 'portal'}
          className="text-[12px] font-medium text-stone-500 underline-offset-2 hover:underline disabled:opacity-40"
        >
          {busy === 'portal' ? 'Opening…' : 'Manage billing & payment method'}
        </button>
      )}

      <button
        type="button"
        onClick={refresh}
        className="block text-[11px] text-stone-400 hover:text-stone-600"
      >
        Refresh
      </button>
    </div>
  );
}
