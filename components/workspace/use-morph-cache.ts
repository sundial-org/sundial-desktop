'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useApiFetch } from '@/lib/workspace/api-fetch-context';
import {
  createMorphStreamParser,
  type MorphRequestVariant,
} from '@/lib/workspace/ai-morph';

/* ── Morph variant cache ──────────────────────────────────────────────
 *  Shared by the Prism and length-resize popups. Keyed streaming cache over
 *  POST /api/workspace/morph: `request()` skips keys already cached or in
 *  flight, so callers prefetch aggressively (every neighbor of the knob)
 *  and the dial feels instant once a wave lands. Deltas are flushed on a
 *  short timer — per-token setState across 8 concurrent variants would
 *  jank the drag interaction it exists to serve.
 * ─────────────────────────────────────────────────────────────────── */

export type MorphEntry = {
  status: 'streaming' | 'done' | 'error';
  text: string;
  message?: string;
};

export type MorphCaptureText = {
  text: string;
  contextBefore: string;
  contextAfter: string;
};

export function useMorphCache({
  projectId,
  filePath,
  capture,
}: {
  projectId: string | null;
  filePath: string | null;
  capture: MorphCaptureText | null;
}) {
  const apiFetch = useApiFetch();
  const cacheRef = useRef<Map<string, MorphEntry>>(new Map());
  const inflightRef = useRef<Set<string>>(new Set());
  const abortersRef = useRef<Set<AbortController>>(new Set());
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [, setVersion] = useState(0);
  // Gate-level failure (sign-in / credits / rate limit) — the popup renders
  // this instead of per-variant errors.
  const [fatalError, setFatalError] = useState<string | null>(null);

  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current === null) {
      flushTimerRef.current = setTimeout(() => {
        flushTimerRef.current = null;
        bump();
      }, 60);
    }
  }, [bump]);

  const reset = useCallback(() => {
    for (const controller of abortersRef.current) controller.abort();
    abortersRef.current.clear();
    cacheRef.current = new Map();
    inflightRef.current = new Set();
    setFatalError(null);
    bump();
  }, [bump]);

  // Unmount aborts every stream (popup closed mid-drag).
  useEffect(
    () => () => {
      for (const controller of abortersRef.current) controller.abort();
      if (flushTimerRef.current !== null) clearTimeout(flushTimerRef.current);
    },
    [],
  );

  const request = useCallback(
    (variants: MorphRequestVariant[]) => {
      if (!projectId || !capture) return;
      const fresh = variants.filter(
        (variant) =>
          !inflightRef.current.has(variant.key) &&
          cacheRef.current.get(variant.key)?.status !== 'done' &&
          cacheRef.current.get(variant.key)?.status !== 'streaming',
      );
      if (fresh.length === 0) return;
      for (const variant of fresh) {
        inflightRef.current.add(variant.key);
        // Visible immediately as a loading cell (before the start event).
        cacheRef.current.set(variant.key, { status: 'streaming', text: '' });
      }
      bump();

      const controller = new AbortController();
      abortersRef.current.add(controller);
      const parser = createMorphStreamParser((event) => {
        if (event.type === 'delta') {
          const entry = cacheRef.current.get(event.key);
          if (entry?.status === 'streaming') {
            entry.text += event.text;
            scheduleFlush();
          }
        } else if (event.type === 'variant-done') {
          const entry = cacheRef.current.get(event.key);
          if (entry) {
            cacheRef.current.set(event.key, { status: 'done', text: entry.text });
            inflightRef.current.delete(event.key);
            bump();
          }
        } else if (event.type === 'variant-error') {
          cacheRef.current.set(event.key, { status: 'error', text: '', message: event.message });
          inflightRef.current.delete(event.key);
          bump();
        } else if (event.type === 'error') {
          setFatalError(event.message);
        }
      });

      const failAll = (message: string) => {
        for (const variant of fresh) {
          if (cacheRef.current.get(variant.key)?.status === 'streaming') {
            cacheRef.current.set(variant.key, { status: 'error', text: '', message });
          }
          inflightRef.current.delete(variant.key);
        }
        bump();
      };

      void (async () => {
        const response = await apiFetch('/api/workspace/morph', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            projectId,
            filePath,
            text: capture.text,
            contextBefore: capture.contextBefore,
            contextAfter: capture.contextAfter,
            variants: fresh,
          }),
        });
        if (!response.ok || !response.body) {
          const reason = await response
            .json()
            .then((data: { error?: string }) => data?.error)
            .catch(() => null);
          const friendly =
            reason === 'signin_required'
              ? 'Sign in to use AI edits.'
              : reason === 'out_of_credits'
                ? 'Out of credits.'
                : reason === 'selection_too_long'
                  ? 'Selection is too long. Pick a shorter passage.'
                  : reason === 'too_many_morphs'
                    ? 'Too many variations in flight. Give them a moment.'
                    : 'AI edits are unavailable right now.';
          // Gate errors kill the whole popup; a transient 429 only fails
          // this wave (the next knob move retries it).
          if (reason !== 'too_many_morphs') setFatalError(friendly);
          failAll(friendly);
          return;
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          parser.feed(decoder.decode(value, { stream: true }));
        }
        parser.flush();
        // Clean EOF mid-protocol: whatever is still streaming failed.
        failAll('stream ended early');
      })()
        .catch(() => {
          if (!controller.signal.aborted) failAll('connection lost');
        })
        .finally(() => {
          abortersRef.current.delete(controller);
        });
    },
    [apiFetch, bump, capture, filePath, projectId, scheduleFlush],
  );

  const get = useCallback((key: string): MorphEntry | null => cacheRef.current.get(key) ?? null, []);

  return { request, get, reset, fatalError };
}
