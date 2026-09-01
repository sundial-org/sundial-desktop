export interface ServerTimingEntry {
  name: string;
  durationMs: number;
  description?: string;
}

const TOKEN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

function cleanDescription(value: string) {
  return value.replace(/["\\\r\n]/g, ' ').trim();
}

/**
 * Collects named server spans and serializes the standard `Server-Timing`
 * response header. Keep one collector per request; `time` preserves errors.
 */
export class ServerTiming {
  readonly entries: ServerTimingEntry[] = [];

  async time<T>(name: string, operation: () => Promise<T>, description?: string): Promise<T> {
    const startedAt = performance.now();
    try {
      return await operation();
    } finally {
      this.add(name, performance.now() - startedAt, description);
    }
  }

  timeSync<T>(name: string, operation: () => T, description?: string): T {
    const startedAt = performance.now();
    try {
      return operation();
    } finally {
      this.add(name, performance.now() - startedAt, description);
    }
  }

  add(name: string, durationMs: number, description?: string) {
    if (!TOKEN.test(name)) throw new Error(`Invalid Server-Timing metric name: ${name}`);
    this.entries.push({
      name,
      durationMs: Math.max(0, durationMs),
      ...(description ? { description: cleanDescription(description) } : {}),
    });
  }

  headerValue() {
    return this.entries
      .map(({ name, durationMs, description }) =>
        `${name};dur=${durationMs.toFixed(1)}${description ? `;desc="${description}"` : ''}`,
      )
      .join(', ');
  }

  apply(headers: Headers) {
    const value = this.headerValue();
    if (value) headers.set('Server-Timing', value);
  }
}
