'use client';

import { useEffect, useRef, useState } from 'react';
import type { createBrowserClient } from '@/lib/supabase/browser';

// A bulk write (git clone mirrors thousands of doc_edits rows) fires one
// realtime event per row. Re-keying per event made every consumer refetch
// thousands of times in a burst — throttle to one bump per window, with a
// trailing bump so the final state is always picked up.
const BUMP_THROTTLE_MS = 1000;

/**
 * Subscribes to `doc_edits` INSERTs for the given workspace and returns a
 * counter that increments on every event. Pass it into `useFilePendingTurns`
 * (or anything else that needs to refetch turn-edit summaries) so live
 * collaborator/agent writes light up the editor without a reload.
 *
 * Also bumps the counter on visibility/focus changes and supabase channel
 * (re)subscription — Supabase Realtime doesn't replay events missed while
 * the browser tab was throttled or the socket was disconnected, so we
 * trigger a manual refetch as a safety net the first time we know the page
 * is "live" again.
 *
 * The supabase publication for `doc_edits` is enabled in migration
 * `20260514150000_doc_edits_realtime_publication.sql`.
 */
export function useDocEditsRealtimeKey(
  supabaseClient: ReturnType<typeof createBrowserClient> | null,
  workspaceId: string | null,
): number {
  const [key, setKey] = useState(0);
  const lastBumpAtRef = useRef(0);
  const bumpTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const bumpThrottled = () => {
    const elapsed = Date.now() - lastBumpAtRef.current;
    if (elapsed >= BUMP_THROTTLE_MS) {
      lastBumpAtRef.current = Date.now();
      setKey((current) => current + 1);
      return;
    }
    if (bumpTimerRef.current) return;
    bumpTimerRef.current = setTimeout(() => {
      bumpTimerRef.current = null;
      lastBumpAtRef.current = Date.now();
      setKey((current) => current + 1);
    }, BUMP_THROTTLE_MS - elapsed);
  };

  useEffect(
    () => () => {
      if (bumpTimerRef.current) clearTimeout(bumpTimerRef.current);
    },
    [],
  );

  // Postgres-change subscription — primary path.
  useEffect(() => {
    if (!supabaseClient || !workspaceId) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- generated types miss realtime overloads for doc_edits
    const channel = supabaseClient.channel(`workspace-doc-edits-${workspaceId}`) as any;
    channel.on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'doc_edits',
        filter: `workspace_id=eq.${workspaceId}`,
      },
      bumpThrottled,
    );
    // Bash/sandbox paths may INSERT doc_edits without `assistant_message_id`
    // and backfill it via UPDATE at end-of-turn. INSERT-only realtime would
    // miss that signal, leaving the inline overlay stale until some other
    // nudge (e.g. chat metadata) arrives.
    channel.on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'doc_edits',
        filter: `workspace_id=eq.${workspaceId}`,
      },
      bumpThrottled,
    );
    // Fire one nudge when the subscription first goes live AND on every
    // reconnect — covers the case where the socket reconnects after a
    // backgrounded tab and would otherwise miss the burst of inserts that
    // landed while it was offline.
    channel.subscribe((status: string) => {
      if (status === 'SUBSCRIBED') setKey((current) => current + 1);
    });
    return () => {
      supabaseClient.removeChannel(channel);
    };
  }, [supabaseClient, workspaceId]);

  // Visibility + focus revalidation — the standard SWR-style safety net.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        setKey((current) => current + 1);
      }
    };
    const onFocus = () => setKey((current) => current + 1);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onFocus);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onFocus);
    };
  }, []);

  return key;
}
