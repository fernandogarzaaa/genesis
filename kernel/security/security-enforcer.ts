// ─── Genesis Security: Security Enforcer ─────────────────────────────
// Coordinates all security components: secret store, auth, permissions,
// audit logging, and WebSocket security.
// The kernel's single entry point for all security concerns.

import type Database from 'better-sqlite3';
import { EncryptedSecretStore, installSecretRedaction, type SecretStore } from './secret-store.js';
import { AuthenticationManagerImpl, type AuthenticationManager } from './auth-manager.js';
import { PermissionManagerImpl, type PermissionManager } from './permission-manager.js';
import { AuditLoggerImpl, type AuditLogger } from './audit-logger.js';
import { WSSecurityManager, type WSSecurityConfig } from './ws-security.js';

// ── Types ──

export interface SecurityConfig {
  /** Master key for secret encryption. If not set, derives from machine info. */
  masterKey?: string;
  /** Enable dev mode: bypass all auth checks. Default: false */
  devMode: boolean;
  /** WebSocket security configuration */
  ws?: Partial<WSSecurityConfig>;
}

export const DEFAULT_SECURITY_CONFIG: SecurityConfig = {
  devMode: process.env.GENESIS_DEV_MODE === 'true',
};

// ── Re-exports ──

export type { SecretStore, SecretEntry } from './secret-store.js';
export type {
  AuthenticationManager,
  ClientIdentity,
  AuthToken,
  SessionToken,
  AuthRole,
} from './auth-manager.js';
export type {
  PermissionManager,
  Permission,
  PermissionCheck,
} from './permission-manager.js';
export type {
  AuditLogger,
  AuditEntry,
  AuditAction,
  AuditOutcome,
  AuditQueryFilter,
} from './audit-logger.js';
export type {
  WSSecurityConfig,
  WSSecurityResult,
  ValidatedMessage,
} from './ws-security.js';
export { MESSAGE_PERMISSIONS } from './permission-manager.js';
export { redactSecrets } from './secret-store.js';

// ── Security Enforcer ──

export class SecurityEnforcer {
  readonly secretStore: SecretStore;
  readonly auth: AuthenticationManager;
  readonly permissions: PermissionManager;
  readonly auditLogger: AuditLogger;
  readonly ws: WSSecurityManager;
  readonly devMode: boolean;

  constructor(db: Database.Database, config: Partial<SecurityConfig> = {}) {
    const mergedConfig: SecurityConfig = { ...DEFAULT_SECURITY_CONFIG, ...config };
    this.devMode = mergedConfig.devMode;

    // Initialize components
    const encryptedStore = new EncryptedSecretStore(db, mergedConfig.masterKey);
    encryptedStore.initialize();

    this.secretStore = encryptedStore;
    this.auditLogger = new AuditLoggerImpl(db);
    this.auth = new AuthenticationManagerImpl(this.secretStore, this.auditLogger, this.devMode);
    this.permissions = new PermissionManagerImpl(this.auditLogger);
    this.ws = new WSSecurityManager(this.auditLogger, {
      ...mergedConfig.ws,
      devMode: this.devMode,
    });

    // Install secret redaction for console output
    installSecretRedaction();

    // Load secrets from env into secret store
    this._seedFromEnvironment();
  }

  /**
   * Generate an initial API token for the Command Center.
   * Call this during kernel boot to create a token for the frontend.
   */
  bootstrapOperatorToken(): string {
    const existing = this.auth.listApiTokens();
    if (existing.length > 0) {
      // Return first operator token if one exists
      const opToken = existing.find(t => t.role === 'operator');
      if (opToken) {
        console.log('[Security] Existing operator token found');
        return ''; // Can't recover the raw token — operator must create new one
      }
    }

    const token = this.auth.generateApiToken('operator', 'Bootstrap operator token');

    console.log('[Security] ──────────────────────────────────────────');
    console.log(`[Security] OPERATOR TOKEN (save this):`);
    console.log(`[Security]   ${token.token}`);
    console.log(`[Security]   Role: ${token.role}`);
    console.log(`[Security]   Client: ${token.clientId}`);
    console.log(`[Security]   Expires: ${new Date(token.expiresAt).toISOString()}`);
    console.log('[Security] ──────────────────────────────────────────');

    return token.token;
  }

  /**
   * Seed the secret store from environment variables.
   * Migrates process.env secrets to the encrypted store.
   */
  private _seedFromEnvironment(): void {
    const envSecrets: Array<[string, string]> = [];

    const openaiKey = process.env.OPENAI_API_KEY;
    if (openaiKey) {
      envSecrets.push(['OPENAI_API_KEY', openaiKey]);
      delete process.env.OPENAI_API_KEY; // Remove from env
    }

    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (anthropicKey) {
      envSecrets.push(['ANTHROPIC_API_KEY', anthropicKey]);
      delete process.env.ANTHROPIC_API_KEY;
    }

    for (const [name, value] of envSecrets) {
      this.secretStore.setSecret(name, value);
      console.log(`[Security] Seeded secret: ${name}`);
    }
  }
}
