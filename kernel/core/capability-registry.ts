// ─── Genesis Kernel: Capability Registry ─────────────────────────────
// §5 — The authoritative map of every capability, who provides it,
// and its current health. Provider selection with configurable routing policies.

import { v4 as uuid } from 'uuid';
import type {
  CapabilityDescriptor,
  ProviderDescriptor,
  RoutingPolicy,
} from './kernel-types.js';

interface ProviderScore {
  provider: ProviderDescriptor;
  score: number;
  factors: {
    health: number;
    latency: number;
    cost: number;
    quality: number;
    tier: number;
    recentFailures: number;
  };
}

const ROUTING_WEIGHTS: Record<RoutingPolicy, {
  health: number;
  latency: number;
  cost: number;
  quality: number;
}> = {
  'cost-optimized': { health: 0.3, latency: 0.1, cost: 0.5, quality: 0.1 },
  'quality-optimized': { health: 0.2, latency: 0.1, cost: 0.1, quality: 0.6 },
  'balanced': { health: 0.25, latency: 0.2, cost: 0.25, quality: 0.3 },
  'lowest-latency': { health: 0.2, latency: 0.6, cost: 0.1, quality: 0.1 },
};

export class CapabilityRegistry {
  private _capabilities: Map<string, CapabilityDescriptor> = new Map();
  private _providers: Map<string, ProviderDescriptor[]> = new Map();
  private _healthHistory: Map<string, Array<{ timestamp: number; health: number }>> = new Map();

  // ── Registration ──

  registerCapability(descriptor: CapabilityDescriptor): void {
    if (this._capabilities.has(descriptor.id)) {
      throw new Error(`Capability '${descriptor.id}' is already registered`);
    }
    this._capabilities.set(descriptor.id, descriptor);
    if (!this._providers.has(descriptor.id)) {
      this._providers.set(descriptor.id, []);
    }
  }

  registerProvider(provider: ProviderDescriptor): void {
    const capabilityId = provider.capabilityId;
    if (!this._capabilities.has(capabilityId)) {
      throw new Error(
        `Capability '${capabilityId}' not found. Register the capability first.`
      );
    }

    const providers = this._providers.get(capabilityId) ?? [];
    const existing = providers.findIndex(p => p.id === provider.id);
    if (existing >= 0) {
      providers[existing] = provider; // Update
    } else {
      providers.push(provider);
    }
    this._providers.set(capabilityId, providers);

    // Initialize health history
    if (!this._healthHistory.has(provider.id)) {
      this._healthHistory.set(provider.id, []);
    }
  }

  unregisterProvider(providerId: string): void {
    for (const [capId, providers] of this._providers) {
      const filtered = providers.filter(p => p.id !== providerId);
      this._providers.set(capId, filtered);
    }
    this._healthHistory.delete(providerId);
  }

  // ── Resolution ──

  resolve(
    capabilityId: string,
    constraints?: {
      version?: string;
      minHealth?: number;
      maxLatencyMs?: number;
      policy?: RoutingPolicy;
    },
  ): ProviderDescriptor | null {
    const providers = this._providers.get(capabilityId);
    if (!providers || providers.length === 0) return null;

    const policy = constraints?.policy ?? 'balanced';
    const minHealth = constraints?.minHealth ?? 0.5;
    const maxLatency = constraints?.maxLatencyMs ?? Infinity;

    // Filter by constraints
    const eligible = providers.filter(p => {
      if (p.health < minHealth) return false;
      if (p.metrics.latencyP50Ms > maxLatency) return false;
      if (p.status === 'unhealthy' || p.status === 'stopping') return false;
      return true;
    });

    if (eligible.length === 0) return null;

    if (eligible.length === 1) return eligible[0];

    // Score and rank
    const scored = eligible.map(p => this._scoreProvider(p, policy));
    scored.sort((a, b) => b.score - a.score);

    return scored[0].provider;
  }

  resolveAll(
    capabilityId: string,
    constraints?: {
      minHealth?: number;
      policy?: RoutingPolicy;
    },
  ): ProviderDescriptor[] {
    const providers = this._providers.get(capabilityId);
    if (!providers) return [];

    const minHealth = constraints?.minHealth ?? 0;
    const eligible = providers.filter(p => p.health >= minHealth);

    const policy = constraints?.policy ?? 'balanced';
    const scored = eligible.map(p => this._scoreProvider(p, policy));
    scored.sort((a, b) => b.score - a.score);

    return scored.map(s => s.provider);
  }

  // ── Health ──

  getHealth(capabilityId: string): {
    overall: number;
    providers: Array<{ id: string; health: number; status: string }>;
    degraded: boolean;
  } {
    const providers = this._providers.get(capabilityId) ?? [];
    if (providers.length === 0) {
      return { overall: 0, providers: [], degraded: true };
    }

    const providerHealths = providers.map(p => ({
      id: p.id,
      health: p.health,
      status: p.status,
    }));

    // Weighted by tier: T1 = 1.0, T2 = 0.8, T3 = 0.6
    const tierWeight = (tier: number) => ({ 1: 1.0, 2: 0.8, 3: 0.6 }[tier] ?? 0.5);
    const totalWeight = providers.reduce((sum, p) => sum + tierWeight(p.tier), 0);
    const weightedHealth = providers.reduce(
      (sum, p) => sum + p.health * tierWeight(p.tier),
      0,
    );

    const overall = totalWeight > 0 ? weightedHealth / totalWeight : 0;

    return {
      overall,
      providers: providerHealths,
      degraded: overall < 0.8,
    };
  }

  updateHealth(
    providerId: string,
    health: number,
    status?: ProviderDescriptor['status'],
  ): void {
    for (const [, providers] of this._providers) {
      const provider = providers.find(p => p.id === providerId);
      if (provider) {
        provider.health = Math.max(0, Math.min(1, health));
        if (status) provider.status = status;

        // Record history (keep last 100 samples)
        const history = this._healthHistory.get(providerId) ?? [];
        history.push({ timestamp: Date.now(), health });
        if (history.length > 100) history.shift();
        this._healthHistory.set(providerId, history);
        break;
      }
    }
  }

  failover(
    capabilityId: string,
    failedProviderId: string,
  ): ProviderDescriptor | null {
    const failed = this._getProviderById(capabilityId, failedProviderId);
    if (failed) {
      failed.status = 'unhealthy';
      failed.health = Math.max(0, failed.health - 0.3);
      failed.recentFailures++;
    }

    // Find next best
    return this.resolve(capabilityId);
  }

  // ── Listing ──

  listCapabilities(): CapabilityDescriptor[] {
    return Array.from(this._capabilities.values());
  }

  listProviders(): ProviderDescriptor[] {
    const all: ProviderDescriptor[] = [];
    for (const [, providers] of this._providers) {
      all.push(...providers);
    }
    return all;
  }

  // ── Private ──

  private _getProviderById(
    capabilityId: string,
    providerId: string,
  ): ProviderDescriptor | undefined {
    return this._providers.get(capabilityId)?.find(p => p.id === providerId);
  }

  private _scoreProvider(
    provider: ProviderDescriptor,
    policy: RoutingPolicy,
  ): ProviderScore {
    const w = ROUTING_WEIGHTS[policy];

    // Normalize latency: 0-5000ms → 1-0
    const latencyNorm = Math.max(0, 1 - provider.metrics.latencyP50Ms / 5000);

    // Normalize cost: assume max $0.10 per unit → 1-0
    const costNorm = Math.max(0, 1 - provider.metrics.costPerUnit / 0.10);

    // Tier bonus
    const tierBonus = { 1: 1.0, 2: 0.95, 3: 0.85 }[provider.tier] ?? 0.8;

    const score =
      provider.health * w.health +
      latencyNorm * w.latency +
      costNorm * w.cost +
      provider.metrics.qualityScore * w.quality +
      tierBonus * 0.05 -
      provider.recentFailures * 0.1;

    return {
      provider,
      score: Math.max(0, Math.min(1, score)),
      factors: {
        health: provider.health,
        latency: latencyNorm,
        cost: costNorm,
        quality: provider.metrics.qualityScore,
        tier: tierBonus,
        recentFailures: provider.recentFailures,
      },
    };
  }
}
