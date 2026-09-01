import { createGateway } from '@ai-sdk/gateway';
import { Agent, fetch as undiciFetch } from 'undici';

/* Node's default fetch dispatcher funnels warm same-origin requests through
 * a single keep-alive connection, so "concurrent" model streams serialize:
 * four parallel rewrites became one-at-a-time (~5s) the moment a warm
 * connection existed. A dedicated agent with its own connection pool keeps
 * them genuinely parallel (~0.8s for all four, measured). Every route that
 * fires concurrent gateway calls must use this provider. */
const dispatcher = new Agent({ connections: 16, pipelining: 0 });

const parallelFetch: typeof fetch = (input, init) =>
  undiciFetch(input as Parameters<typeof undiciFetch>[0], {
    ...(init as Parameters<typeof undiciFetch>[1]),
    dispatcher,
  }) as unknown as ReturnType<typeof fetch>;

export const gateway = createGateway({ fetch: parallelFetch });
