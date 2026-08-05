// ─── Genesis Kernel: In-Memory Vector Store ────────────────────────
// §10.3 — For Dev/Local profiles. Uses cosine similarity.
// Production profiles swap for LanceDB/pgvector/Pinecone.

import { v4 as uuid } from 'uuid';
import type { VectorRecord } from './kernel-types.js';

interface VectorEntry extends VectorRecord {
  _norm: number; // Pre-computed L2 norm for faster cosine similarity
}

export class VectorStore {
  private _collections: Map<string, VectorEntry[]> = new Map();

  // ── CRUD ──

  insert(
    collection: string,
    vectors: Array<{ embedding: number[]; metadata: Record<string, unknown> }>,
  ): string[] {
    if (!this._collections.has(collection)) {
      this._collections.set(collection, []);
    }

    const entries = this._collections.get(collection)!;
    const ids: string[] = [];

    for (const v of vectors) {
      const id = uuid();
      const norm = Math.sqrt(v.embedding.reduce((sum, x) => sum + x * x, 0));
      entries.push({
        id,
        collection,
        embedding: v.embedding,
        metadata: v.metadata,
        _norm: norm,
      });
      ids.push(id);
    }

    return ids;
  }

  search(
    collection: string,
    queryEmbedding: number[],
    topK: number = 10,
    filter?: (metadata: Record<string, unknown>) => boolean,
  ): Array<{ id: string; score: number; metadata: Record<string, unknown> }> {
    const entries = this._collections.get(collection);
    if (!entries || entries.length === 0) return [];

    const queryNorm = Math.sqrt(
      queryEmbedding.reduce((sum, x) => sum + x * x, 0),
    );

    if (queryNorm === 0) return [];

    const scored = entries
      .filter(e => (filter ? filter(e.metadata) : true))
      .map(e => {
        const dotProduct = e.embedding.reduce(
          (sum, val, i) => sum + val * (queryEmbedding[i] ?? 0),
          0,
        );
        const score =
          e._norm > 0 && queryNorm > 0
            ? dotProduct / (e._norm * queryNorm)
            : 0;
        return { id: e.id, score, metadata: e.metadata };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    return scored;
  }

  delete(collection: string, ids: string[]): void {
    const entries = this._collections.get(collection);
    if (!entries) return;

    const idSet = new Set(ids);
    this._collections.set(
      collection,
      entries.filter(e => !idSet.has(e.id)),
    );
  }

  get(collection: string, id: string): VectorEntry | null {
    return (
      this._collections.get(collection)?.find(e => e.id === id) ?? null
    );
  }

  // ── Collection Management ──

  listCollections(): string[] {
    return Array.from(this._collections.keys());
  }

  collectionSize(collection: string): number {
    return this._collections.get(collection)?.length ?? 0;
  }

  dropCollection(collection: string): void {
    this._collections.delete(collection);
  }

  // ── Statistics ──

  stats(): {
    totalVectors: number;
    collections: number;
    avgDimension: number;
    memoryEstimateBytes: number;
  } {
    const collections = this._collections.size;
    let totalVectors = 0;
    let totalDimensions = 0;

    for (const [, entries] of this._collections) {
      totalVectors += entries.length;
      for (const e of entries) {
        totalDimensions += e.embedding.length;
      }
    }

    const avgDimension =
      totalVectors > 0 ? totalDimensions / totalVectors : 0;

    // Rough estimate: 8 bytes per float64 per dimension
    const memoryEstimateBytes =
      totalDimensions * 8 + totalVectors * 200; // metadata overhead

    return {
      totalVectors,
      collections,
      avgDimension: Math.round(avgDimension),
      memoryEstimateBytes,
    };
  }
}
