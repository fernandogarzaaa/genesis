// ─── Genesis Security: Audit Logger ──────────────────────────────────
// Immutable security audit trail. Every auth decision, permission check,
// and security-relevant action is logged here.

import type Database from 'better-sqlite3';

// ── Types ──

export type AuditAction =
  | 'auth.login'
  | 'auth.logout'
  | 'auth.token_generated'
  | 'auth.token_revoked'
  | 'auth.failed'
  | 'perm.check'
  | 'perm.denied'
  | 'secret.read'
  | 'secret.write'
  | 'secret.delete'
  | 'ws.connect'
  | 'ws.disconnect'
  | 'ws.rate_limited'
  | 'system.command'
  | 'proposal.approve'
  | 'proposal.reject';

export type AuditOutcome = 'allow' | 'deny' | 'error';

export interface AuditEntry {
  id?: number;
  timestamp: number;
  actor: string;        // Who performed the action (client ID, 'system', etc.)
  action: AuditAction;
  resource: string;     // What was accessed (event type, secret name, etc.)
  outcome: AuditOutcome;
  details: Record<string, unknown>;
  ip?: string;
}

export interface AuditLogger {
  log(entry: AuditEntry): void;
  query(filter: AuditQueryFilter): AuditEntry[];
  getRecent(limit?: number): AuditEntry[];
}

export interface AuditQueryFilter {
  actor?: string;
  action?: AuditAction;
  resource?: string;
  outcome?: AuditOutcome;
  from?: number;
  to?: number;
  limit?: number;
}

// ── Schema ──

const AUDIT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    resource TEXT NOT NULL DEFAULT '',
    outcome TEXT NOT NULL DEFAULT 'allow',
    details TEXT NOT NULL DEFAULT '{}',
    ip TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
  CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log(actor);
  CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
  CREATE INDEX IF NOT EXISTS idx_audit_outcome ON audit_log(outcome);
`;

// ── Implementation ──

export class AuditLoggerImpl implements AuditLogger {
  private _db: Database.Database;
  private _initialized: boolean = false;

  constructor(db: Database.Database) {
    this._db = db;
  }

  private _ensureSchema(): void {
    if (this._initialized) return;
    this._db.exec(AUDIT_SCHEMA);
    this._initialized = true;
  }

  log(entry: AuditEntry): void {
    this._ensureSchema();

    this._db.prepare(`
      INSERT INTO audit_log (timestamp, actor, action, resource, outcome, details, ip)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.timestamp,
      entry.actor,
      entry.action,
      entry.resource,
      entry.outcome,
      JSON.stringify(entry.details),
      entry.ip ?? null,
    );
  }

  query(filter: AuditQueryFilter): AuditEntry[] {
    this._ensureSchema();

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.actor) {
      conditions.push('actor = ?');
      params.push(filter.actor);
    }
    if (filter.action) {
      conditions.push('action = ?');
      params.push(filter.action);
    }
    if (filter.resource) {
      conditions.push('resource = ?');
      params.push(filter.resource);
    }
    if (filter.outcome) {
      conditions.push('outcome = ?');
      params.push(filter.outcome);
    }
    if (filter.from) {
      conditions.push('timestamp >= ?');
      params.push(filter.from);
    }
    if (filter.to) {
      conditions.push('timestamp <= ?');
      params.push(filter.to);
    }

    const where = conditions.length > 0
      ? 'WHERE ' + conditions.join(' AND ')
      : '';
    const limit = filter.limit ?? 100;

    const rows = this._db.prepare(
      `SELECT * FROM audit_log ${where} ORDER BY timestamp DESC LIMIT ?`
    ).all(...params, limit) as Array<Record<string, unknown>>;

    return rows.map(r => this._rowToEntry(r));
  }

  getRecent(limit: number = 50): AuditEntry[] {
    this._ensureSchema();
    const rows = this._db.prepare(
      'SELECT * FROM audit_log ORDER BY timestamp DESC LIMIT ?'
    ).all(limit) as Array<Record<string, unknown>>;

    return rows.map(r => this._rowToEntry(r));
  }

  private _rowToEntry(row: Record<string, unknown>): AuditEntry {
    return {
      id: row.id as number,
      timestamp: row.timestamp as number,
      actor: row.actor as string,
      action: row.action as AuditAction,
      resource: row.resource as string,
      outcome: row.outcome as AuditOutcome,
      details: JSON.parse(row.details as string),
      ip: row.ip as string | undefined,
    };
  }
}
