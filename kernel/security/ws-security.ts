// ─── Genesis Security: WebSocket Security Middleware ─────────────────
// Rate limiting, origin validation, payload size limits,
// connection limits, and Zod message schema validation.

import { z } from 'zod';
import type { AuditLogger } from './audit-logger.js';

// ── Types ──

export interface WSSecurityConfig {
  /** Maximum message payload size in bytes. Default: 1MB */
  maxPayloadSize: number;
  /** Maximum concurrent connections. Default: 100 */
  maxConnections: number;
  /** Allowed origins (exact match or '*'). Default: localhost */
  allowedOrigins: string[];
  /** Rate limit: max messages per window per client. Default: 60 */
  rateLimitMessages: number;
  /** Rate limit: window in milliseconds. Default: 1000 (1s) */
  rateLimitWindowMs: number;
  /** Enable dev mode (skip auth checks). Default: false */
  devMode: boolean;
  /** TLS configuration (for production). Default: undefined */
  tls?: {
    cert: string;
    key: string;
  };
}

export interface WSSecurityResult {
  allowed: boolean;
  statusCode?: number;
  reason?: string;
}

export const DEFAULT_WS_SECURITY_CONFIG: WSSecurityConfig = {
  maxPayloadSize: 1024 * 1024, // 1MB
  maxConnections: 100,
  allowedOrigins: ['http://localhost:5173', 'http://localhost:3000', 'http://127.0.0.1:5173'],
  rateLimitMessages: 60,
  rateLimitWindowMs: 1000,
  devMode: false,
};

// ── Zod Schemas for Message Validation ──

const payloadSchema = z.record(z.unknown());

export const WSMessageSchemas = {
  subscribe: z.object({
    type: z.literal('subscribe'),
    payload: z.object({
      eventType: z.string().min(1).max(256),
    }),
    id: z.string().optional(),
  }),

  unsubscribe: z.object({
    type: z.literal('unsubscribe'),
    payload: z.object({
      eventType: z.string().min(1).max(256),
    }),
    id: z.string().optional(),
  }),

  'task.submit': z.object({
    type: z.literal('task.submit'),
    payload: z.object({
      goal: z.string().min(1).max(10000),
      context: z.string().max(50000).optional(),
    }),
    id: z.string().optional(),
  }),

  'kernel.snapshot': z.object({
    type: z.literal('kernel.snapshot'),
    payload: payloadSchema.optional().default({}),
    id: z.string().optional(),
  }),

  'proposal.approve': z.object({
    type: z.literal('proposal.approve'),
    payload: z.object({
      proposalId: z.string().min(1).max(128),
    }),
    id: z.string().optional(),
  }),

  'proposal.reject': z.object({
    type: z.literal('proposal.reject'),
    payload: z.object({
      proposalId: z.string().min(1).max(128),
      reason: z.string().max(1000).optional(),
    }),
    id: z.string().optional(),
  }),

  'system.command': z.object({
    type: z.literal('system.command'),
    payload: z.object({
      command: z.enum(['pause', 'resume', 'restart', 'status']),
    }),
    id: z.string().optional(),
  }),

  'audit.query': z.object({
    type: z.literal('audit.query'),
    payload: z.object({
      from: z.number().optional(),
      to: z.number().optional(),
      actor: z.string().optional(),
      action: z.string().optional(),
      limit: z.number().min(1).max(500).optional().default(50),
    }),
    id: z.string().optional(),
  }),

  auth: z.object({
    type: z.literal('auth'),
    payload: z.object({
      token: z.string().min(1).max(1024),
    }),
    id: z.string().optional(),
  }),

  ping: z.object({
    type: z.literal('ping'),
    payload: payloadSchema.optional().default({}),
    id: z.string().optional(),
  }),
} as const;

export type ValidatedMessage = z.infer<typeof WSMessageSchemas[keyof typeof WSMessageSchemas]>;

// ── Rate Limiter (Token Bucket) ──

interface TokenBucket {
  tokens: number;
  lastRefill: number;
}

export class RateLimiter {
  private _buckets: Map<string, TokenBucket> = new Map();
  private _maxTokens: number;
  private _refillRate: number; // tokens per ms

  constructor(maxTokens: number, windowMs: number) {
    this._maxTokens = maxTokens;
    this._refillRate = maxTokens / windowMs;
  }

  allow(key: string): boolean {
    const now = Date.now();
    let bucket = this._buckets.get(key);

    if (!bucket) {
      bucket = { tokens: this._maxTokens, lastRefill: now };
      this._buckets.set(key, bucket);
    }

    // Refill
    const elapsed = now - bucket.lastRefill;
    bucket.tokens = Math.min(
      this._maxTokens,
      bucket.tokens + elapsed * this._refillRate,
    );
    bucket.lastRefill = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }

    return false;
  }

  /** Clean up stale buckets */
  cleanup(maxAgeMs: number = 60_000): void {
    const now = Date.now();
    for (const [key, bucket] of this._buckets) {
      if (now - bucket.lastRefill > maxAgeMs) {
        this._buckets.delete(key);
      }
    }
  }
}

// ── WSSecurityManager ──

export class WSSecurityManager {
  private _config: WSSecurityConfig;
  private _rateLimiter: RateLimiter;
  private _auditLogger: AuditLogger;
  private _connectionCount: number = 0;

  constructor(
    auditLogger: AuditLogger,
    config: Partial<WSSecurityConfig> = {},
  ) {
    this._config = { ...DEFAULT_WS_SECURITY_CONFIG, ...config };
    this._rateLimiter = new RateLimiter(
      this._config.rateLimitMessages,
      this._config.rateLimitWindowMs,
    );
    this._auditLogger = auditLogger;
  }

  get config(): Readonly<WSSecurityConfig> {
    return this._config;
  }

  // ── Connection Validation ──

  checkConnection(origin: string, clientIp: string): WSSecurityResult {
    // Dev mode: allow everything
    if (this._config.devMode) return { allowed: true };

    // Connection limit
    if (this._connectionCount >= this._config.maxConnections) {
      return {
        allowed: false,
        statusCode: 503,
        reason: `Max connections (${this._config.maxConnections}) reached`,
      };
    }

    // Origin validation (skip if no origin or on localhost in dev)
    if (origin && this._config.allowedOrigins.length > 0) {
      const allowed = this._config.allowedOrigins.some(o =>
        o === '*' || o === origin ||
        (o.endsWith(':*') && origin.startsWith(o.replace(':*', ':')))
      );
      if (!allowed) {
        this._auditLogger.log({
          timestamp: Date.now(),
          actor: 'unknown',
          action: 'ws.connect',
          resource: 'websocket',
          outcome: 'deny',
          details: { reason: 'origin_not_allowed', origin },
          ip: clientIp,
        });
        return {
          allowed: false,
          statusCode: 403,
          reason: `Origin not allowed: ${origin}`,
        };
      }
    }

    this._connectionCount++;
    return { allowed: true };
  }

  onDisconnect(): void {
    this._connectionCount = Math.max(0, this._connectionCount - 1);
  }

  // ── Message Validation ──

  checkRateLimit(clientId: string): WSSecurityResult {
    if (this._config.devMode) return { allowed: true };

    if (!this._rateLimiter.allow(clientId)) {
      this._auditLogger.log({
        timestamp: Date.now(),
        actor: clientId,
        action: 'ws.rate_limited',
        resource: 'websocket',
        outcome: 'deny',
        details: {
          limit: this._config.rateLimitMessages,
          windowMs: this._config.rateLimitWindowMs,
        },
      });
      return {
        allowed: false,
        statusCode: 429,
        reason: 'Rate limit exceeded',
      };
    }

    return { allowed: true };
  }

  validatePayload(rawData: string): WSSecurityResult & { parsed?: unknown } {
    // Size check
    const byteLength = Buffer.byteLength(rawData, 'utf8');
    if (byteLength > this._config.maxPayloadSize) {
      return {
        allowed: false,
        reason: `Payload too large: ${byteLength} bytes (max: ${this._config.maxPayloadSize})`,
      };
    }

    // JSON parse
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawData);
    } catch {
      return {
        allowed: false,
        reason: 'Invalid JSON',
      };
    }

    return { allowed: true, parsed };
  }

  validateMessageSchema(parsed: unknown): WSSecurityResult {
    if (this._config.devMode) return { allowed: true };

    if (typeof parsed !== 'object' || parsed === null) {
      return { allowed: false, reason: 'Message must be an object' };
    }

    const msg = parsed as Record<string, unknown>;

    if (typeof msg.type !== 'string') {
      return { allowed: false, reason: 'Message must have a "type" field' };
    }

    // Look up schema
    const schema = WSMessageSchemas[msg.type as keyof typeof WSMessageSchemas];
    if (!schema) {
      // Allow unknown types through (they'll be rejected by the message handler)
      return { allowed: true };
    }

    const result = schema.safeParse(parsed);
    if (!result.success) {
      const errors = result.error.errors.map(e =>
        `${e.path.join('.')}: ${e.message}`
      ).join('; ');
      return { allowed: false, reason: `Schema validation failed: ${errors}` };
    }

    return { allowed: true };
  }
}
