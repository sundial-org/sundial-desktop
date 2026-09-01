'use client';
import { useCreditSummary } from '@/lib/credits/use-credit-summary';
import { LOW_BALANCE_MICROS } from '@/lib/credits/constants';

// Sidebar-footer indicator. Stays hidden unless the signed-in user's credit
// balance is low — no chrome for the common (healthy-balance / anon) case.
export function CreditBalancePill({ onOpenBilling, enabled = true }: { onOpenBilling?: () => void; enabled?: boolean }) {
  const { summary, ready } = useCreditSummary(enabled);
  if (!ready || !summary) return null; // anon (401) or not yet loaded
  if (summary.balanceMicros > LOW_BALANCE_MICROS) return null;

  const depleted = summary.balanceMicros <= 0;
  return (
    <button
      type="button"
      onClick={onOpenBilling}
      title={depleted ? 'Out of AI credits' : 'Low on AI credits'}
      className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors ${
        depleted
          ? 'bg-red-100 text-red-700 hover:bg-red-200'
          : 'bg-amber-100 text-amber-700 hover:bg-amber-200'
      }`}
    >
      {depleted ? 'Out of credits' : `${summary.credits} credits left`}
    </button>
  );
}
