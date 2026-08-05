// ─── Genesis Kernel: SQLite Storage Engine ──────────────────────────
// §10 — Single SQLite database for Tiers 1, 2, and 3 (Local/Dev profile).
// The "Two-Backend Default": SQLite + LanceDB (in-memory vector for now).

import Database from 'better-sqlite3';
import type {
  EventStoreRecord,
  EventEnvelope,
  StateDocument,
  TimeSeriesPoint,
} from './kernel-types.js';
import { EventBus } from '../events/event-bus.js';

export class StorageEngine {
  private _db: Database.Database;
  private _eventBus: EventBus | null = null;

  constructor(dbPath: string = ':memory:') {
    this._db = new Database(dbPath);
    this._db.pragma('journal_mode = WAL');
    this._db.pragma('foreign_keys = ON');
    this._initializeSchema();
  }

  setEventBus(bus: EventBus): void {
    this._eventBus = bus;
  }

  get db(): Database.Database {
    return this._db;
  }

  // ── Schema ──

  private _initializeSchema(): void {
    this._db.exec(`
      -- Tier 1: Immutable Event Log
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        stream TEXT NOT NULL,
        event_type TEXT NOT NULL,
        event_id TEXT UNIQUE NOT NULL,
        correlation_id TEXT NOT NULL,
        causation_id TEXT,
        trace_id TEXT NOT NULL,
        version TEXT NOT NULL DEFAULT '1.0.0',
        timestamp INTEGER NOT NULL,
        priority INTEGER NOT NULL DEFAULT 2,
        source_component TEXT NOT NULL,
        source_instance TEXT NOT NULL,
        source_host TEXT NOT NULL DEFAULT 'genesis-node-1',
        payload TEXT NOT NULL,  -- JSON
        idempotency_key TEXT,
        expires_at INTEGER,
        redelivery_count INTEGER DEFAULT 0,
        stored_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );

      CREATE INDEX IF NOT EXISTS idx_events_stream ON events(stream, sequence);
      CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type);
      CREATE INDEX IF NOT EXISTS idx_events_correlation ON events(correlation_id);
      CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_events_idempotency ON events(idempotency_key)
        WHERE idempotency_key IS NOT NULL;

      -- Tier 2: Mutable State with Versioning
      CREATE TABLE IF NOT EXISTS state (
        collection TEXT NOT NULL,
        key TEXT NOT NULL,
        data TEXT NOT NULL,  -- JSON
        version INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        PRIMARY KEY (collection, key)
      );

      CREATE TABLE IF NOT EXISTS state_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        collection TEXT NOT NULL,
        key TEXT NOT NULL,
        data TEXT NOT NULL,
        version INTEGER NOT NULL,
        changed_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );

      CREATE INDEX IF NOT EXISTS idx_state_history_lookup
        ON state_history(collection, key, version);

      -- Tier 3: Time-Series Observability
      CREATE TABLE IF NOT EXISTS timeseries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        metric_name TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '{}',  -- JSON
        value REAL NOT NULL,
        timestamp INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_timeseries_lookup
        ON timeseries(metric_name, timestamp);

      CREATE TABLE IF NOT EXISTS blobs (
        key TEXT PRIMARY KEY,
        data BLOB,
        metadata TEXT DEFAULT '{}',
        size_bytes INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
      );

      -- Idempotency tracking (for command deduplication)
      CREATE TABLE IF NOT EXISTS idempotency (
        key TEXT PRIMARY KEY,
        response TEXT,
        processed_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        expires_at INTEGER
      );
    `);
  }

  // ── Tier 1: Event Store ──

  appendEvents(
    stream: string,
    events: EventEnvelope[],
  ): number[] {
    const insert = this._db.prepare(`
      INSERT INTO events (
        stream, event_type, event_id, correlation_id, causation_id,
        trace_id, version, timestamp, priority, source_component,
        source_instance, source_host, payload, idempotency_key,
        expires_at, redelivery_count
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const sequences: number[] = [];

    const tx = this._db.transaction(() => {
      for (const event of events) {
        const result = insert.run(
          stream,
          event.type,
          event.eventId,
          event.correlationId,
          event.causationId,
          event.traceId,
          event.version,
          event.timestamp,
          event.priority,
          event.source.component,
          event.source.instance,
          event.source.host,
          JSON.stringify(event.payload),
          event.idempotencyKey ?? null,
          event.expiresAt ?? null,
          event.redeliveryCount,
        );
        sequences.push(Number(result.lastInsertRowid));
      }
    });

    tx();

    // Emit if bus is available
    if (this._eventBus) {
      for (const event of events) {
        this._eventBus.publish(event.type, event.payload, {
          correlationId: event.correlationId,
          traceId: event.traceId,
          source: event.source,
        });
      }
    }

    return sequences;
  }

  readEvents(
    stream: string,
    fromSequence?: number,
    toSequence?: number,
  ): EventStoreRecord[] {
    let query = 'SELECT * FROM events WHERE stream = ?';
    const params: unknown[] = [stream];

    if (fromSequence !== undefined) {
      query += ' AND sequence >= ?';
      params.push(fromSequence);
    }
    if (toSequence !== undefined) {
      query += ' AND sequence <= ?';
      params.push(toSequence);
    }
    query += ' ORDER BY sequence ASC LIMIT 1000';

    const rows = this._db.prepare(query).all(...params) as Array<Record<string, unknown>>;
    return rows.map(row => this._rowToEventRecord(row));
  }

  readEventsByTimeRange(fromTs: number, toTs: number): EventStoreRecord[] {
    const rows = this._db.prepare(
      'SELECT * FROM events WHERE timestamp BETWEEN ? AND ? ORDER BY timestamp ASC LIMIT 1000'
    ).all(fromTs, toTs) as Array<Record<string, unknown>>;

    return rows.map(row => this._rowToEventRecord(row));
  }

  readEventsByType(eventType: string, limit = 100): EventStoreRecord[] {
    const rows = this._db.prepare(
      'SELECT * FROM events WHERE event_type = ? ORDER BY timestamp DESC LIMIT ?'
    ).all(eventType, limit) as Array<Record<string, unknown>>;

    return rows.map(row => this._rowToEventRecord(row));
  }

  getLatestSequence(stream: string): number {
    const row = this._db.prepare(
      'SELECT MAX(sequence) as seq FROM events WHERE stream = ?'
    ).get(stream) as { seq: number | null };

    return row?.seq ?? 0;
  }

  getEventCount(stream?: string): number {
    if (stream) {
      const row = this._db.prepare(
        'SELECT COUNT(*) as cnt FROM events WHERE stream = ?'
      ).get(stream) as { cnt: number };
      return row.cnt;
    }
    const row = this._db.prepare(
      'SELECT COUNT(*) as cnt FROM events'
    ).get() as { cnt: number };
    return row.cnt;
  }

  private _rowToEventRecord(row: Record<string, unknown>): EventStoreRecord {
    return {
      sequence: row.sequence as number,
      stream: row.stream as string,
      event: {
        eventId: row.event_id as string,
        correlationId: row.correlation_id as string,
        causationId: row.causation_id as string | null,
        traceId: row.trace_id as string,
        type: row.event_type as string,
        version: row.version as string,
        timestamp: row.timestamp as number,
        priority: row.priority as 0 | 1 | 2 | 3 | 4,
        source: {
          component: row.source_component as string,
          instance: row.source_instance as string,
          host: row.source_host as string,
        },
        payload: JSON.parse(row.payload as string),
        idempotencyKey: row.idempotency_key as string | undefined,
        expiresAt: row.expires_at as number | undefined,
        redeliveryCount: row.redelivery_count as number,
      },
      storedAt: row.stored_at as number,
    };
  }

  // ── Tier 2: State Store ──

  getState<T>(collection: string, key: string): (StateDocument & { data: T }) | null {
    const row = this._db.prepare(
      'SELECT * FROM state WHERE collection = ? AND key = ?'
    ).get(collection, key) as Record<string, unknown> | undefined;

    if (!row) return null;

    return {
      collection: row.collection as string,
      key: row.key as string,
      data: JSON.parse(row.data as string) as T,
      version: row.version as number,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }

  setState<T>(
    collection: string,
    key: string,
    data: T,
    expectedVersion?: number,
  ): number {
    const tx = this._db.transaction(() => {
      const existing = this._db.prepare(
        'SELECT version FROM state WHERE collection = ? AND key = ?'
      ).get(collection, key) as { version: number } | undefined;

      if (existing) {
        if (expectedVersion !== undefined && existing.version !== expectedVersion) {
          throw new Error(
            `Version conflict: expected ${expectedVersion}, got ${existing.version}`
          );
        }

        const newVersion = existing.version + 1;
        const now = Date.now();

        // Save history
        this._db.prepare(
          'INSERT INTO state_history (collection, key, data, version, changed_at) SELECT collection, key, data, version, ? FROM state WHERE collection = ? AND key = ?'
        ).run(now, collection, key);

        // Update
        this._db.prepare(
          'UPDATE state SET data = ?, version = ?, updated_at = ? WHERE collection = ? AND key = ?'
        ).run(JSON.stringify(data), newVersion, now, collection, key);

        return newVersion;
      } else {
        const now = Date.now();
        this._db.prepare(
          'INSERT INTO state (collection, key, data, version, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?)'
        ).run(collection, key, JSON.stringify(data), now, now);

        // Emit config change for audit
        if (this._eventBus) {
          this._eventBus.publish('state.created', {
            collection,
            key,
            version: 1,
          });
        }

        return 1;
      }
    });

    return tx();
  }

  deleteState(collection: string, key: string): void {
    this._db.prepare(
      'DELETE FROM state WHERE collection = ? AND key = ?'
    ).run(collection, key);
  }

  queryState<T>(
    collection: string,
    filter?: (doc: StateDocument & { data: T }) => boolean,
  ): Array<StateDocument & { data: T }> {
    const rows = this._db.prepare(
      'SELECT * FROM state WHERE collection = ?'
    ).all(collection) as Array<Record<string, unknown>>;

    const docs = rows.map(row => ({
      collection: row.collection as string,
      key: row.key as string,
      data: JSON.parse(row.data as string) as T,
      version: row.version as number,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    }));

    return filter ? docs.filter(filter) : docs;
  }

  getVersionHistory(
    collection: string,
    key: string,
  ): Array<{ data: unknown; version: number; changedAt: number }> {
    const rows = this._db.prepare(
      'SELECT data, version, changed_at FROM state_history WHERE collection = ? AND key = ? ORDER BY version DESC'
    ).all(collection, key) as Array<Record<string, unknown>>;

    return rows.map(row => ({
      data: JSON.parse(row.data as string),
      version: row.version as number,
      changedAt: row.changed_at as number,
    }));
  }

  // ── Tier 3: Time-Series ──

  writeMetric(
    metricName: string,
    value: number,
    tags: Record<string, string> = {},
    timestamp?: number,
  ): void {
    this._db.prepare(
      'INSERT INTO timeseries (metric_name, tags, value, timestamp) VALUES (?, ?, ?, ?)'
    ).run(metricName, JSON.stringify(tags), value, timestamp ?? Date.now());
  }

  queryMetrics(
    metricName: string,
    from: number,
    to: number,
    aggregation?: 'avg' | 'sum' | 'min' | 'max' | 'count',
  ): Array<{ timestamp: number; value: number }> {
    if (aggregation) {
      const fn = aggregation.toUpperCase();
      const row = this._db.prepare(
        `SELECT ${fn}(value) as value FROM timeseries WHERE metric_name = ? AND timestamp BETWEEN ? AND ?`
      ).get(metricName, from, to) as { value: number | null };
      return row?.value != null ? [{ timestamp: from, value: row.value }] : [];
    }

    const rows = this._db.prepare(
      'SELECT timestamp, value FROM timeseries WHERE metric_name = ? AND timestamp BETWEEN ? AND ? ORDER BY timestamp ASC LIMIT 1000'
    ).all(metricName, from, to) as Array<{ timestamp: number; value: number }>;

    return rows;
  }

  compactMetrics(beforeTimestamp: number): void {
    this._db.prepare(
      'DELETE FROM timeseries WHERE timestamp < ?'
    ).run(beforeTimestamp);
  }

  // ── Blob Store ──

  putBlob(key: string, data: Buffer, metadata: Record<string, unknown> = {}): void {
    this._db.prepare(
      'INSERT OR REPLACE INTO blobs (key, data, metadata, size_bytes) VALUES (?, ?, ?, ?)'
    ).run(key, data, JSON.stringify(metadata), data.length);
  }

  getBlob(key: string): { data: Buffer; metadata: Record<string, unknown> } | null {
    const row = this._db.prepare(
      'SELECT data, metadata FROM blobs WHERE key = ?'
    ).get(key) as { data: Buffer; metadata: string } | undefined;

    if (!row) return null;
    return { data: row.data, metadata: JSON.parse(row.metadata) };
  }

  deleteBlob(key: string): void {
    this._db.prepare('DELETE FROM blobs WHERE key = ?').run(key);
  }

  // ── Housekeeping ──

  cleanIdempotency(maxAgeMs: number = 24 * 60 * 60 * 1000): number {
    const cutoff = Date.now() - maxAgeMs;
    const result = this._db.prepare(
      'DELETE FROM idempotency WHERE processed_at < ?'
    ).run(cutoff);
    return result.changes;
  }

  vacuum(): void {
    this._db.pragma('optimize');
  }

  close(): void {
    this._db.close();
  }
}
