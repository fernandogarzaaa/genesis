// ─── Genesis Security: Authentication Manager ───────────────────────
// Handles API token generation/validation, session tokens,
// client identity tracking, and WebSocket auth handshake.

import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import type { SecretStore } from './secret-store.js';
import type { AuditLogger } from './audit-logger.js';

// ── Types ──

export type AuthRole = 'operator' | 'developer' | 'viewer';

export interface ClientIdentity {
  clientId: string;
  role: AuthRole;
  tokenType: 'api' | 'session';
  authenticatedAt: number;
  expiresAt: number;
  metadata: Record<string, string>;
}

export interface AuthToken {
  token: string;          // The token string (only returned on creation)
  hash: string;           // SHA-256 hash stored in the secret store
  clientId: string;
  role: AuthRole;
  createdAt: number;
  expiresAt: number;
  description: string;
}

export interface SessionToken {
  token: string;
  clientId: string;
  role: AuthRole;
  createdAt: number;
  expiresAt: number;
}

export interface AuthenticationManager {
  /** Generate a new API token (persistent, stored). */
  generateApiToken(role: AuthRole, description: string, ttlMs?: number): AuthToken;

  /** Revoke an API token by its hash. */
  revokeApiToken(clientId: string): boolean;

  /** List all known API tokens (without secret values). */
  listApiTokens(): Omit<AuthToken, 'token'>[];

  /** Create a short-lived session token from an API token. */
  createSession(apiToken: string): SessionToken | null;

  /** Validate a session token and return the client identity. */
  validateSession(token: string): ClientIdentity | null;

  /** Validate an API token directly. */
  validateApiToken(token: string): ClientIdentity | null;

  /** Check if a given token is valid (API or session). */
  authenticate(token: string): ClientIdentity | null;

  /** DEV MODE: create a fake local identity. */
  devIdentity(): ClientIdentity;
}

// ── Constants ──

const TOKEN_PREFIX = 'gn_';
const SESSION_PREFIX = 'gns_';
const TOKEN_BYTES = 32;
const DEFAULT_API_TOKEN_TTL = 90 * 24 * 60 * 60 * 1000; // 90 days
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours

// Secret store keys
const API_TOKEN_PREFIX_KS = 'auth:api_token:';

// ── Implementation ──

export class AuthenticationManagerImpl implements AuthenticationManager {
  private _secretStore: SecretStore;
  private _auditLogger: AuditLogger;
  private _devMode: boolean;
  private _activeSessions: Map<string, ClientIdentity> = new Map();

  constructor(
    secretStore: SecretStore,
    auditLogger: AuditLogger,
    devMode: boolean = false,
  ) {
    this._secretStore = secretStore;
    this._auditLogger = auditLogger;
    this._devMode = devMode;
  }

  // ── API Tokens ──

  generateApiToken(role: AuthRole, description: string, ttlMs?: number): AuthToken {
    const token = TOKEN_PREFIX + randomBytes(TOKEN_BYTES).toString('base64url');
    const hash = this._hashToken(token);
    const clientId = `client-${randomBytes(8).toString('hex')}`;
    const now = Date.now();
    const expiresAt = now + (ttlMs ?? DEFAULT_API_TOKEN_TTL);

    const tokenRecord: Omit<AuthToken, 'token'> = {
      hash,
      clientId,
      role,
      createdAt: now,
      expiresAt,
      description,
    };

    // Store hashed token in secret store
    this._secretStore.setSecret(
      API_TOKEN_PREFIX_KS + clientId,
      JSON.stringify(tokenRecord),
    );

    this._auditLogger.log({
      timestamp: now,
      actor: 'system',
      action: 'auth.token_generated',
      resource: clientId,
      outcome: 'allow',
      details: { role, description, expiresAt },
    });

    return { ...tokenRecord, token };
  }

  revokeApiToken(clientId: string): boolean {
    const deleted = this._secretStore.deleteSecret(API_TOKEN_PREFIX_KS + clientId);

    if (deleted) {
      this._auditLogger.log({
        timestamp: Date.now(),
        actor: 'system',
        action: 'auth.token_revoked',
        resource: clientId,
        outcome: 'allow',
        details: {},
      });
    }

    return deleted;
  }

  listApiTokens(): Omit<AuthToken, 'token'>[] {
    const entries = this._secretStore.listSecrets();
    const tokens: Omit<AuthToken, 'token'>[] = [];

    for (const entry of entries) {
      if (entry.name.startsWith(API_TOKEN_PREFIX_KS)) {
        const raw = this._secretStore.getSecret(entry.name);
        if (raw) {
          try {
            const parsed = JSON.parse(raw);
            tokens.push({
              hash: parsed.hash,
              clientId: parsed.clientId,
              role: parsed.role,
              createdAt: parsed.createdAt,
              expiresAt: parsed.expiresAt,
              description: parsed.description,
            });
          } catch { /* skip corrupt entries */ }
        }
      }
    }

    return tokens;
  }

  // ── Sessions ──

  createSession(apiToken: string): SessionToken | null {
    // First find which client this token belongs to
    const identity = this.validateApiToken(apiToken);
    if (!identity) {
      this._auditLogger.log({
        timestamp: Date.now(),
        actor: 'unknown',
        action: 'auth.failed',
        resource: 'session',
        outcome: 'deny',
        details: { reason: 'invalid_api_token' },
      });
      return null;
    }

    const sessionToken = SESSION_PREFIX + randomBytes(TOKEN_BYTES).toString('base64url');
    const now = Date.now();

    const sessionIdentity: ClientIdentity = {
      clientId: identity.clientId,
      role: identity.role,
      tokenType: 'session',
      authenticatedAt: now,
      expiresAt: now + SESSION_TTL,
      metadata: {},
    };

    this._activeSessions.set(sessionToken, sessionIdentity);

    this._auditLogger.log({
      timestamp: now,
      actor: identity.clientId,
      action: 'auth.login',
      resource: 'session',
      outcome: 'allow',
      details: { role: identity.role },
    });

    return {
      token: sessionToken,
      clientId: identity.clientId,
      role: identity.role,
      createdAt: now,
      expiresAt: sessionIdentity.expiresAt,
    };
  }

  validateSession(token: string): ClientIdentity | null {
    const identity = this._activeSessions.get(token);
    if (!identity) return null;
    if (Date.now() > identity.expiresAt) {
      this._activeSessions.delete(token);
      return null;
    }
    return identity;
  }

  // ── Core Authentication ──

  validateApiToken(token: string): ClientIdentity | null {
    if (!token.startsWith(TOKEN_PREFIX)) return null;

    const tokenHash = this._hashToken(token);
    const entries = this._secretStore.listSecrets();

    for (const entry of entries) {
      if (entry.name.startsWith(API_TOKEN_PREFIX_KS)) {
        const raw = this._secretStore.getSecret(entry.name);
        if (!raw) continue;
        try {
          const parsed = JSON.parse(raw);
          if (parsed.hash === tokenHash) {
            if (Date.now() > parsed.expiresAt) return null;
            return {
              clientId: parsed.clientId,
              role: parsed.role as AuthRole,
              tokenType: 'api',
              authenticatedAt: Date.now(),
              expiresAt: parsed.expiresAt,
              metadata: {},
            };
          }
        } catch { /* skip */ }
      }
    }

    return null;
  }

  authenticate(token: string): ClientIdentity | null {
    // Try session first (faster, in-memory)
    if (token.startsWith(SESSION_PREFIX)) {
      return this.validateSession(token);
    }

    // Then try API token
    return this.validateApiToken(token);
  }

  devIdentity(): ClientIdentity {
    return {
      clientId: 'dev-client',
      role: 'operator',
      tokenType: 'session',
      authenticatedAt: Date.now(),
      expiresAt: Date.now() + 365 * 24 * 60 * 60 * 1000, // 1 year
      metadata: { devMode: 'true' },
    };
  }

  // ── Helpers ──

  private _hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
