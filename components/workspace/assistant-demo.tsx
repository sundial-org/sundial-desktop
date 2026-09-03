'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ArrowCounterClockwiseIcon, PauseIcon, PlayIcon } from '@phosphor-icons/react';

type AssistantDemoSpec = {
  title: string;
  webm: string;
  mp4: string;
  poster: string;
  transcript: string;
};

const ASSISTANT_DEMOS: Record<string, AssistantDemoSpec> = {
  'claim-verification': {
    title: 'See it in action',
    webm: '/assistants/claim-verifier/demo.webm',
    mp4: '/assistants/claim-verifier/demo.mp4',
    poster: '/assistants/claim-verifier/demo-poster.webp',
    transcript:
      'Select a claim, choose Verify, and Claim Verifier adds an inline comment: “Contradicted: the harmonic series diverges; π²/6 is ∑1/n².” Full evidence remains in Open thread.',
  },
};

type PlaybackState = 'idle' | 'playing' | 'paused' | 'ended';

/** A checked-in product recording for an assistant details page. Demo media
 * stays out of the catalog payload and does not load until this component is
 * mounted for a supported assistant. */
export function AssistantDemo({
  assistantSlug,
  className,
}: {
  assistantSlug: string;
  className?: string;
}) {
  const demo = ASSISTANT_DEMOS[assistantSlug];
  return demo ? (
    <PrerecordedAssistantDemo key={assistantSlug} demo={demo} className={className} />
  ) : null;
}

function PrerecordedAssistantDemo({
  demo,
  className,
}: {
  demo: AssistantDemoSpec;
  className?: string;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const autoStartedRef = useRef(false);
  const playAttemptRef = useRef(0);
  const [reducedMotion, setReducedMotion] = useState(
    () =>
      typeof window !== 'undefined' &&
      (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false),
  );
  const [sufficientlyVisible, setSufficientlyVisible] = useState(false);
  const [pageVisible, setPageVisible] = useState(true);
  const [playback, setPlayback] = useState<PlaybackState>('idle');
  const [mediaFailed, setMediaFailed] = useState(false);
  const titleId = useId();
  const transcriptId = useId();

  const play = useCallback(async (restart = false) => {
    const video = videoRef.current;
    if (!video || mediaFailed) return;
    if (restart) video.currentTime = 0;
    const attempt = ++playAttemptRef.current;
    try {
      await video.play();
      if (attempt !== playAttemptRef.current) return;
      setPlayback('playing');
    } catch {
      if (attempt !== playAttemptRef.current) return;
      // Muted autoplay can still be denied by an embedded browser. The
      // poster, transcript, and explicit Play control remain usable.
      setPlayback((current) => (current === 'playing' ? 'paused' : current));
    }
  }, [mediaFailed]);

  const pause = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    playAttemptRef.current += 1;
    video.pause();
    setPlayback((current) => (current === 'playing' ? 'paused' : current));
  }, []);

  useEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!query) return;
    const sync = () => {
      setReducedMotion(query.matches);
      if (query.matches) pause();
    };
    sync();
    query.addEventListener?.('change', sync);
    return () => query.removeEventListener?.('change', sync);
  }, [pause]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        const visible = Boolean(entry && entry.intersectionRatio >= 0.6);
        setSufficientlyVisible(visible);
        if (!visible) pause();
      },
      { threshold: [0.6] },
    );
    observer.observe(video);
    return () => observer.disconnect();
  }, [pause]);

  useEffect(() => {
    const sync = () => {
      const visible = document.visibilityState !== 'hidden';
      setPageVisible(visible);
      if (!visible) pause();
    };
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => document.removeEventListener('visibilitychange', sync);
  }, [pause]);

  useEffect(() => {
    if (
      !sufficientlyVisible ||
      !pageVisible ||
      reducedMotion ||
      mediaFailed ||
      autoStartedRef.current
    ) {
      return;
    }
    autoStartedRef.current = true;
    void play();
  }, [mediaFailed, pageVisible, play, reducedMotion, sufficientlyVisible]);

  useEffect(() => {
    const video = videoRef.current;
    return () => {
      playAttemptRef.current += 1;
      video?.pause();
    };
  }, []);

  const controlLabel =
    playback === 'playing'
      ? 'Pause demo'
      : playback === 'ended'
        ? 'Replay demo'
        : playback === 'paused'
          ? 'Resume demo'
          : 'Play demo';

  return (
    <section
      data-testid="assistant-demo"
      aria-labelledby={titleId}
      className={className}
    >
      <h3 id={titleId} className="mb-2 text-[11px] font-medium uppercase tracking-wide text-stone-400">
        {demo.title}
      </h3>
      <figure>
        <div className="relative aspect-video overflow-hidden rounded-xl border border-stone-200 bg-stone-100 shadow-sm">
          <video
            ref={videoRef}
            muted
            playsInline
            preload="metadata"
            poster={demo.poster}
            aria-hidden="true"
            tabIndex={-1}
            className={`h-full w-full object-cover ${mediaFailed ? 'invisible' : ''}`}
            onEnded={() => {
              playAttemptRef.current += 1;
              setPlayback('ended');
            }}
            onError={() => {
              playAttemptRef.current += 1;
              videoRef.current?.pause();
              setMediaFailed(true);
              setPlayback('idle');
            }}
          >
            <source src={demo.webm} type="video/webm" />
            <source src={demo.mp4} type="video/mp4" />
          </video>

          {mediaFailed ? (
            <>
              {/* The transcript below carries the meaning; this is only the
                  still visual fallback when neither video codec decodes. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={demo.poster}
                alt=""
                aria-hidden
                className="absolute inset-0 h-full w-full object-cover"
              />
              <span
                role="status"
                className="absolute bottom-3 left-3 rounded-full border border-stone-200 bg-white/95 px-2.5 py-1 text-[11px] font-medium text-stone-600 shadow-sm"
              >
                Demo preview unavailable
              </span>
            </>
          ) : (
            <button
              type="button"
              aria-label={controlLabel}
              onClick={() => {
                if (playback === 'playing') {
                  pause();
                } else {
                  void play(playback === 'ended');
                }
              }}
              className="absolute bottom-3 right-3 inline-flex h-8 items-center gap-1.5 rounded-full border border-stone-200 bg-white/95 px-3 text-[11px] font-medium text-stone-700 shadow-sm backdrop-blur transition-colors hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stone-500/30"
            >
              {playback === 'playing' ? (
                <PauseIcon className="h-3.5 w-3.5" weight="fill" aria-hidden />
              ) : playback === 'ended' ? (
                <ArrowCounterClockwiseIcon className="h-3.5 w-3.5" weight="bold" aria-hidden />
              ) : (
                <PlayIcon className="h-3.5 w-3.5" weight="fill" aria-hidden />
              )}
              <span>{controlLabel.replace(' demo', '')}</span>
            </button>
          )}
        </div>
        <figcaption id={transcriptId} className="mt-2 text-[12px] leading-5 text-stone-500">
          {demo.transcript}
        </figcaption>
      </figure>
    </section>
  );
}
