// ─── Genesis Kernel: Event Bus ──────────────────────────────────────
// §9 — The ONLY communication channel between components.
// No component may communicate through direct function calls, shared memory,
// or side channels. This is non-negotiable.

import { v4 as uuid } from 'uuid';
import type {
  EventEnvelope,
  EventHandler,
  EventSubscription,
  EventPriority,
  CommandEnvelope,
} from './kernel-types.js';

interface DeadLetterEntry {
  originalEvent: EventEnvelope;
  failures: Array<{
    attempt: number;
    timestamp: number;
    handler: string;
    error: { type: string; message: string; stack?: string };
  }>;
  enqueuedAt: number;
  status: 'pending' | 'retrying' | 'resolved' | 'abandoned';
  resolution: null | {
    action: 'retry' | 'skip' | 'fixed';
    operator: 'human' | 'adam';
    timestamp: number;
  };
}

const PRIORITY_NAMES: Record<EventPriority, string> = {
  0: 'CRITICAL',
  1: 'HIGH',
  2: 'NORMAL',
  3: 'LOW',
  4: 'BEST_EFFORT',
};

export class EventBus {
  private _subscriptions: Map<string, EventSubscription[]> = new Map();
  private _wildcardSubscriptions: Array<{
    regex: RegExp;
    subscription: EventSubscription;
  }> = [];
  private _dlq: DeadLetterEntry[] = [];
  private _idempotencyCache: Map<string, { processedAt: number; response?: unknown }> = new Map();
  private _hostId: string;
  private _pendingCommands: Map<string, {
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
    timeout: NodeJS.Timeout;
  }> = new Map();
  private _replayMode = false;

  // Statistics
  private _stats = {
    eventsPublished: 0,
    eventsDelivered: 0,
    eventsFailed: 0,
    dlqSize: 0,
    activeSubscriptions: 0,
    idempotencyCacheSize: 0,
  };

  constructor(hostId: string = 'genesis-node-1') {
    this._hostId = hostId;
  }

  // ── Statistics ──

  get stats() {
    return {
      ...this._stats,
      dlqSize: this._dlq.length,
      activeSubscriptions: this._subscriptions.size,
      idempotencyCacheSize: this._idempotencyCache.size,
    };
  }

  get replayMode(): boolean {
    return this._replayMode;
  }

  // ── Publishing ──

  async publish<T>(
    type: string,
    payload: T,
    options: {
      correlationId?: string;
      causationId?: string;
      traceId?: string;
      priority?: EventPriority;
      version?: string;
      idempotencyKey?: string;
      source?: { component: string; instance: string };
      expiresAt?: number;
    } = {},
  ): Promise<string> {
    const event: EventEnvelope<T> = {
      eventId: uuid(),
      correlationId: options.correlationId ?? uuid(),
      causationId: options.causationId ?? null,
      traceId: options.traceId ?? uuid(),
      type,
      version: options.version ?? '1.0.0',
      timestamp: Date.now(),
      priority: options.priority ?? 2,
      source: {
        component: options.source?.component ?? 'kernel',
        instance: options.source?.instance ?? 'unknown',
        host: this._hostId,
      },
      payload,
      idempotencyKey: options.idempotencyKey,
      expiresAt: options.expiresAt,
      redeliveryCount: 0,
    };

    // Idempotency check
    if (event.idempotencyKey) {
      const cached = this._idempotencyCache.get(event.idempotencyKey);
      if (cached) {
        return event.eventId; // Already processed
      }
      this._idempotencyCache.set(event.idempotencyKey, {
        processedAt: Date.now(),
      });
    }

    this._stats.eventsPublished++;

    // Deliver to matching subscribers
    await this._deliver(event);

    return event.eventId;
  }

  async sendCommand<T, R>(
    type: string,
    payload: T,
    options: {
      correlationId?: string;
      traceId?: string;
      timeoutMs?: number;
      priority?: EventPriority;
      source?: { component: string; instance: string };
    } = {},
  ): Promise<R> {
    const timeoutMs = options.timeoutMs ?? 30000;
    const responseChannel = `response:${uuid()}`;

    const command: CommandEnvelope<T> = {
      eventId: uuid(),
      correlationId: options.correlationId ?? uuid(),
      causationId: null,
      traceId: options.traceId ?? uuid(),
      type,
      version: '1.0.0',
      timestamp: Date.now(),
      priority: options.priority ?? 2,
      source: {
        component: options.source?.component ?? 'kernel',
        instance: options.source?.instance ?? 'unknown',
        host: this._hostId,
      },
      payload,
      responseChannel,
      timeoutMs,
      redeliveryCount: 0,
    };

    return new Promise<R>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this._pendingCommands.delete(responseChannel);
        reject(new Error(`Command '${type}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this._pendingCommands.set(responseChannel, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timeout,
      });

      this._deliver(command).catch(reject);
    });
  }

  respondToCommand(responseChannel: string, result: unknown): void {
    const pending = this._pendingCommands.get(responseChannel);
    if (pending) {
      clearTimeout(pending.timeout);
      this._pendingCommands.delete(responseChannel);
      pending.resolve(result);
    }
  }

  // ── Subscribing ──

  subscribe(
    pattern: string,
    handler: EventHandler,
    options: {
      priority?: number;
      replayCapable?: boolean;
    } = {},
  ): string {
    const subscriptionId = uuid();
    const subscription: EventSubscription = {
      id: subscriptionId,
      pattern,
      handler,
      priority: options.priority ?? 10,
      replayCapable: options.replayCapable ?? true,
    };

    if (pattern.includes('*') || pattern.includes('#')) {
      // Wildcard subscription
      const regex = new RegExp(
        '^' +
        pattern
          .replace(/\./g, '\\.')
          .replace(/\*/g, '[^.]+')
          .replace(/#/g, '.*') +
        '$'
      );
      this._wildcardSubscriptions.push({ regex, subscription });
    } else {
      // Exact match subscription
      const existing = this._subscriptions.get(pattern) ?? [];
      existing.push(subscription);
      existing.sort((a, b) => a.priority - b.priority);
      this._subscriptions.set(pattern, existing);
    }

    return subscriptionId;
  }

  unsubscribe(subscriptionId: string): void {
    // Remove from exact matches
    for (const [pattern, subs] of this._subscriptions) {
      const filtered = subs.filter(s => s.id !== subscriptionId);
      if (filtered.length === 0) {
        this._subscriptions.delete(pattern);
      } else {
        this._subscriptions.set(pattern, filtered);
      }
    }

    // Remove from wildcards
    this._wildcardSubscriptions = this._wildcardSubscriptions.filter(
      w => w.subscription.id !== subscriptionId
    );
  }

  // ── Dead Letter Queue ──

  get dlq(): ReadonlyArray<DeadLetterEntry> {
    return this._dlq;
  }

  dlqResolve(
    eventId: string,
    action: 'retry' | 'skip' | 'fixed',
    operator: 'human' | 'adam' = 'human',
  ): void {
    const entry = this._dlq.find(e => e.originalEvent.eventId === eventId);
    if (entry) {
      entry.status = action === 'retry' ? 'retrying' : 'resolved';
      entry.resolution = { action, operator, timestamp: Date.now() };

      if (action === 'retry') {
        // Remove from DLQ and re-deliver
        this._dlq = this._dlq.filter(e => e.originalEvent.eventId !== eventId);
        this._deliver(entry.originalEvent);
      }
    }
  }

  // ── Cleanup ──

  cleanIdempotencyCache(maxAgeMs: number = 24 * 60 * 60 * 1000): number {
    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;
    for (const [key, value] of this._idempotencyCache) {
      if (value.processedAt < cutoff) {
        this._idempotencyCache.delete(key);
        removed++;
      }
    }
    return removed;
  }

  // ── Private Methods ──

  private async _deliver(event: EventEnvelope): Promise<void> {
    const matchedSubscriptions: EventSubscription[] = [];

    // Exact matches
    const exact = this._subscriptions.get(event.type);
    if (exact) {
      matchedSubscriptions.push(...exact);
    }

    // Wildcard matches
    for (const { regex, subscription } of this._wildcardSubscriptions) {
      if (regex.test(event.type)) {
        matchedSubscriptions.push(subscription);
      }
    }

    if (matchedSubscriptions.length === 0) {
      // No subscribers — log at debug level in production
      return;
    }

    // Sort by priority
    matchedSubscriptions.sort((a, b) => a.priority - b.priority);

    // Deliver to each subscriber
    const maxRetries = 3;
    for (const sub of matchedSubscriptions) {
      let attempts = 0;
      let delivered = false;

      while (attempts < maxRetries && !delivered) {
        try {
          await sub.handler(event);
          this._stats.eventsDelivered++;
          delivered = true;
        } catch (error) {
          attempts++;
          const err = error instanceof Error ? error : new Error(String(error));

          if (attempts >= maxRetries) {
            this._stats.eventsFailed++;
            // Move to DLQ
            this._dlq.push({
              originalEvent: { ...event, redeliveryCount: attempts },
              failures: Array.from({ length: maxRetries }, (_, i) => ({
                attempt: i + 1,
                timestamp: Date.now(),
                handler: sub.id,
                error: {
                  type: err.constructor.name,
                  message: err.message,
                  stack: err.stack,
                },
              })),
              enqueuedAt: Date.now(),
              status: 'pending',
              resolution: null,
            });
          } else {
            // Exponential backoff
            await new Promise(r => setTimeout(r, Math.pow(2, attempts) * 100));
          }
        }
      }
    }
  }
}
