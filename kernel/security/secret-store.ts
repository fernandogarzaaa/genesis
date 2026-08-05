// ─── Genesis Security: Encrypted Secret Store ───────────────────────
// Stores secrets (API keys, tokens) encrypted with AES-256-GCM.
// Uses SQLite for persistence, never logs secrets.

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';
import type Database from 'better-sqlite3';

// ── Types ──

export interface SecretEntry {
  name: string;
  createdAt: number;
  updatedAt: number;
  // value is NEVER exposed — only set/get through methods
}

export interface SecretStore {
  getSecret(name: string): string | null;
  setSecret(name: string, value: string): void;
  deleteSecret(name: string): boolean;
  listSecrets(): SecretEntry[];
}

// ── Constants ──

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const SALT_LENGTH = 32;

// Schema for the secrets table
const SECRETS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS secrets (
    name TEXT PRIMARY KEY,
    encrypted_value BLOB NOT NULL,
    iv BLOB NOT NULL,
    auth_tag BLOB NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
    updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
  );
`;

// ── Secret Redaction ──

const REDACTED = '[REDACTED]';

/**
 * Registry of secret values that should be redacted from logs/errors.
 * Each call to setSecret registers the value for redaction.
 * getSecret NEVER returns raw value from this set — only from the store.
 */
const _redactionPatterns: Set<string> = new Set();

export function redactSecrets(text: string): string {
  let result = text;
  for (const secret of _redactionPatterns) {
    // Use split/join for reliable replacement
    result = result.split(secret).join(REDACTED);
  }
  return result;
}

/**
 * Wrap console methods to redact secrets.
 */
export function installSecretRedaction(): void {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const originalError = console.error;

  console.log = (...args: unknown[]) => {
    originalLog(...args.map(a =>
      typeof a === 'string' ? redactSecrets(a) : a
    ));
  };
  console.warn = (...args: unknown[]) => {
    originalWarn(...args.map(a =>
      typeof a === 'string' ? redactSecrets(a) : a
    ));
  };
  console.error = (...args: unknown[]) => {
    originalError(...args.map(a =>
      typeof a === 'string' ? redactSecrets(a) : a
    ));
  };
}

// ── Implementation ──

export class EncryptedSecretStore implements SecretStore {
  private _db: Database.Database;
  private _key: Buffer;
  private _initialized: boolean = false;

  /**
   * @param db — SQLite database instance
   * @param masterKey — Optional master encryption key. If not provided,
   *   derives one from machine info (weaker but works without config).
   */
  constructor(db: Database.Database, masterKey?: string) {
    this._db = db;
    this._key = this._deriveKey(masterKey);
  }

  /** Call once after construction to ensure schema exists. */
  initialize(): void {
    if (this._initialized) return;
    this._db.exec(SECRETS_SCHEMA);
    this._initialized = true;
  }

  // ── SecretStore Interface ──

  getSecret(name: string): string | null {
    this.initialize();
    const row = this._db.prepare(
      'SELECT encrypted_value, iv, auth_tag FROM secrets WHERE name = ?'
    ).get(name) as { encrypted_value: Buffer; iv: Buffer; auth_tag: Buffer } | undefined;

    if (!row) return null;
    return this._decrypt(row.encrypted_value, row.iv, row.auth_tag);
  }

  setSecret(name: string, value: string): void {
    this.initialize();
    const { encrypted, iv, authTag } = this._encrypt(value);
    const now = Date.now();

    // Register for redaction
    _redactionPatterns.add(value);

    this._db.prepare(`
      INSERT INTO secrets (name, encrypted_value, iv, auth_tag, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        encrypted_value = excluded.encrypted_value,
        iv = excluded.iv,
        auth_tag = excluded.auth_tag,
        updated_at = excluded.updated_at
    `).run(name, encrypted, iv, authTag, now, now);
  }

  deleteSecret(name: string): boolean {
    this.initialize();
    const result = this._db.prepare(
      'DELETE FROM secrets WHERE name = ?'
    ).run(name);
    return result.changes > 0;
  }

  listSecrets(): SecretEntry[] {
    this.initialize();
    const rows = this._db.prepare(
      'SELECT name, created_at, updated_at FROM secrets ORDER BY name'
    ).all() as Array<{ name: string; created_at: number; updated_at: number }>;

    return rows.map(r => ({
      name: r.name,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  // ── Crypto ──

  private _deriveKey(masterKey?: string): Buffer {
    // In production, the master key would come from a secure source.
    // For the initial implementation, derive from provided key or hostname.
    const source = masterKey ?? `genesis-${process.env.HOSTNAME ?? process.env.USER ?? 'default'}`;
    const salt = Buffer.concat([
      Buffer.from('genesis-secret-store-v1'),
      Buffer.from(source).subarray(0, 16),
    ]);
    return scryptSync(source, salt, KEY_LENGTH);
  }

  private _encrypt(plaintext: string): { encrypted: Buffer; iv: Buffer; authTag: Buffer } {
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGORITHM, this._key, iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();
    return { encrypted, iv, authTag };
  }

  private _decrypt(encrypted: Buffer, iv: Buffer, authTag: Buffer): string | null {
    try {
      const decipher = createDecipheriv(ALGORITHM, this._key, iv);
      decipher.setAuthTag(authTag);
      return Buffer.concat([
        decipher.update(encrypted),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      return null; // Decryption failed (wrong key, corruption)
    }
  }
}
