'use client';

import Link from 'next/link';
import {
  ArrowRightIcon,
  BrainIcon,
  EyeSlashIcon,
  ShieldCheckIcon,
} from '@phosphor-icons/react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';

const promises = [
  {
    icon: EyeSlashIcon,
    title: 'Never sold',
    body: "We don't sell or rent your personal information.",
  },
  {
    icon: ShieldCheckIcon,
    title: 'Never used for training',
    body: 'Your workspace content is never used to train AI models.',
  },
  {
    icon: BrainIcon,
    title: 'Shared only when needed',
    body: 'When Sunny works, relevant context is sent to the AI model handling your request.',
  },
] as const;

export function OnboardingPrivacyDialog({
  open,
  onContinue,
}: {
  open: boolean;
  onContinue: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onContinue()}>
      <DialogContent
        data-testid="onboarding-privacy-dialog"
        className="gap-0 overflow-hidden border-stone-300 bg-[#f7f5f0] p-0 shadow-[0_28px_90px_-28px_rgba(28,25,23,0.55)] [&>[data-slot=dialog-close]]:text-stone-300 [&>[data-slot=dialog-close]]:hover:bg-white/10 [&>[data-slot=dialog-close]]:hover:text-white [&>[data-slot=dialog-close]]:focus:ring-white/40 sm:max-w-[34rem]"
      >
        <div className="relative overflow-hidden border-b border-stone-300 bg-stone-950 px-6 pb-7 pt-6 text-white sm:px-8">
          <div
            aria-hidden
            className="absolute -right-10 -top-14 h-44 w-44 rounded-full border border-white/10"
          />
          <div
            aria-hidden
            className="absolute -right-3 -top-8 h-28 w-28 rounded-full border border-white/10"
          />
          <div className="relative flex items-start gap-4">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full border border-white/20 bg-white/10">
              <ShieldCheckIcon className="h-5 w-5" weight="fill" aria-hidden />
            </span>
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-stone-400">
                Before you begin
              </div>
              <DialogTitle className="mt-2 font-serif text-[30px] font-medium leading-8 tracking-[-0.02em] text-white">
                Your work stays yours.
              </DialogTitle>
              <DialogDescription className="mt-3 max-w-md text-[13px] leading-5 text-stone-300">
                Sundial uses your content to provide the product and complete the work you ask Sunny to do.
              </DialogDescription>
            </div>
          </div>
        </div>

        <div className="px-6 py-5 sm:px-8">
          <div className="divide-y divide-stone-200 border-y border-stone-200">
            {promises.map(({ icon: Icon, title, body }) => (
              <div key={title} className="grid grid-cols-[1.75rem_1fr] gap-3 py-3.5">
                <span className="mt-0.5 grid h-7 w-7 place-items-center rounded-full bg-stone-200 text-stone-700">
                  <Icon className="h-3.5 w-3.5" weight="bold" aria-hidden />
                </span>
                <div>
                  <div className="text-[12px] font-semibold text-stone-900">{title}</div>
                  <p className="mt-0.5 text-[12px] leading-[1.45] text-stone-600">{body}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="mt-5 flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
            <Link
              href="/privacy"
              target="_blank"
              rel="noreferrer"
              className="text-center text-[12px] font-medium text-stone-500 underline decoration-stone-300 underline-offset-4 transition-colors hover:text-stone-900"
            >
              Read our privacy policy
            </Link>
            <button
              type="button"
              data-testid="onboarding-privacy-continue"
              onClick={onContinue}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-stone-950 px-4 text-[13px] font-semibold text-white transition-colors hover:bg-stone-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-950 focus-visible:ring-offset-2"
            >
              Start using Sundial
              <ArrowRightIcon className="h-3.5 w-3.5" weight="bold" aria-hidden />
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
