'use client';

/**
 * The desktop home's first-run state: three job-to-be-done cards above the
 * regular home (which keeps its action row, search and template section). Shown
 * once, on a machine with nothing to open, and never again after a dismissal or
 * a first project.
 */

import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { ArrowRightIcon, SparkleIcon, XIcon } from '@phosphor-icons/react';
import { SunnyAnimation } from '@/components/sunny-animation';
import { getLaunchParam } from '@/lib/local/sidecar';
import {
  clearOnboardingDone,
  markOnboardingDone,
  readOnboardingDone,
  shouldMarkOnboarded,
  shouldShowOnboarding,
} from '@/lib/local/onboarding';

/** The three doors, the same ones the action row below offers. */
export type OnboardingActions = {
  /** Expand the template section the home already renders, collapsed. */
  onTemplate: () => void;
  onOpenFolder: () => void;
  onBlank: () => void;
  ready: boolean;
};

type Job = {
  id: string;
  art: 'files' | 'book' | 'dig';
  title: string;
  body: string;
  cta: string;
  run: (actions: OnboardingActions) => void;
};

const JOBS: Job[] = [
  {
    id: 'polish',
    art: 'files',
    title: 'Polish a draft you already have',
    body: 'Open the folder your notes and drafts live in. Ask Agent to tighten the argument or finish a section, then keep or undo each edit.',
    cta: 'Open a folder',
    run: (a) => a.onOpenFolder(),
  },
  {
    id: 'maintain',
    art: 'book',
    title: 'Start a doc the Agent keeps up to date',
    body: 'A paper, a literature review, a running set of notes. Add sources as you go and Agent folds them into the document.',
    cta: 'Choose a template',
    run: (a) => a.onTemplate(),
  },
  {
    id: 'blank',
    art: 'dig',
    title: 'Write something from scratch',
    body: 'An empty project and a chat. Describe the report you need, Agent writes the first version and you take it from there.',
    cta: 'Start blank',
    run: (a) => a.onBlank(),
  },
];

/** Decides whether this home is a first run, and remembers the answer. */
export function useFirstRunOnboarding({ resolved, itemCount }: { resolved: boolean; itemCount: number }) {
  // Starts "done" so a returning home never flashes the cards before the flag
  // is read (localStorage is only reachable after mount).
  const [done, setDone] = useState(true);
  useLayoutEffect(() => {
    if (getLaunchParam('onboardingReset')) clearOnboardingDone();
    setDone(readOnboardingDone());
  }, []);
  useEffect(() => {
    if (!shouldMarkOnboarded({ resolved, done, itemCount })) return;
    markOnboardingDone();
    setDone(true);
  }, [resolved, done, itemCount]);
  const dismiss = useCallback(() => {
    markOnboardingDone();
    setDone(true);
  }, []);
  return { show: shouldShowOnboarding({ resolved, done, itemCount }), dismiss };
}

export function GuidedOnboarding({
  actions,
  onDismiss,
}: {
  actions: OnboardingActions;
  onDismiss: () => void;
}) {
  return (
    <section className="relative flex flex-col gap-5" data-testid="onboarding-guided-empty">
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        data-testid="onboarding-dismiss"
        className="absolute right-0 top-0 rounded-lg p-1 text-stone-400 transition-colors hover:bg-stone-100 hover:text-stone-600"
      >
        <XIcon className="h-4 w-4" aria-hidden />
      </button>
      <div className="flex items-center gap-2">
        <SparkleIcon className="h-4 w-4 text-stone-400" weight="fill" aria-hidden />
        <h2 className="text-base font-semibold text-stone-900">What do you want to get done?</h2>
      </div>
      <div className="grid gap-3 lg:grid-cols-3">
        {JOBS.map((job) => (
          <button
            key={job.id}
            type="button"
            disabled={!actions.ready}
            data-testid={`onboarding-job-${job.id}`}
            onClick={() => job.run(actions)}
            className="group flex flex-col items-start rounded-2xl border border-stone-200 bg-white p-5 text-left shadow-sm transition-colors hover:border-stone-300 hover:bg-stone-100/60 disabled:opacity-50"
          >
            <SunnyAnimation name={job.art} className="h-16 object-contain object-left" />
            <h3 className="mt-2 text-[15px] font-semibold text-stone-900">{job.title}</h3>
            <p className="mt-1.5 flex-1 text-sm leading-snug text-stone-500">{job.body}</p>
            <span className="mt-4 inline-flex items-center gap-1.5 rounded-lg border border-stone-200 bg-stone-50 px-3 py-1.5 text-[13px] font-medium text-stone-700 transition-colors group-hover:border-stone-300 group-hover:bg-white">
              {job.cta}
              <ArrowRightIcon className="h-3.5 w-3.5" aria-hidden />
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
