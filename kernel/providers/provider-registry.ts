// ─── Genesis Kernel: Provider Registry & Model Router ───────────────
// Aggregates all AI providers, routes requests based on policy.

import type {
  TextGenerationProvider,
  TextGenerationRequest,
  TextGenerationResponse,
  RoutingPolicy,
} from '../core/kernel-types.js';
import { CapabilityRegistry } from '../core/capability-registry.js';

export interface ModelRoutingDecision {
  provider: string;
  model: string;
  policy: RoutingPolicy;
  attempts: Array<{
    provider: string;
    model: string;
    latencyMs: number;
    success: boolean;
    error?: string;
  }>;
  finalProvider: string;
}

export class ProviderRegistry {
  private _providers: Map<string, TextGenerationProvider> = new Map();
  private _capabilityRegistry: CapabilityRegistry;
  private _defaultPolicy: RoutingPolicy = 'balanced';

  constructor(capabilityRegistry: CapabilityRegistry) {
    this._capabilityRegistry = capabilityRegistry;
  }

  // ── Provider Management ──

  registerProvider(provider: TextGenerationProvider): void {
    this._providers.set(provider.providerId, provider);
  }

  unregisterProvider(providerId: string): void {
    this._providers.delete(providerId);
  }

  getProvider(providerId: string): TextGenerationProvider | undefined {
    return this._providers.get(providerId);
  }

  listProviders(): TextGenerationProvider[] {
    return Array.from(this._providers.values());
  }

  // ── Model Routing ──

  setDefaultPolicy(policy: RoutingPolicy): void {
    this._defaultPolicy = policy;
  }

  async generate(
    request: TextGenerationRequest,
    options?: {
      preferredProvider?: string;
      policy?: RoutingPolicy;
    },
  ): Promise<{ response: TextGenerationResponse; routing: ModelRoutingDecision }> {
    const policy = options?.policy ?? this._defaultPolicy;
    const routing: ModelRoutingDecision = {
      provider: '',
      model: request.model || 'default',
      policy,
      attempts: [],
      finalProvider: '',
    };

    // Build ordered list of providers to try
    const providers = this._orderedProviders(options?.preferredProvider, policy);

    let lastError: Error | null = null;

    for (const provider of providers) {
      const startTime = Date.now();
      try {
        const response = await provider.generate(request);
        const latencyMs = Date.now() - startTime;

        routing.attempts.push({
          provider: provider.providerId,
          model: request.model || 'default',
          latencyMs,
          success: true,
        });
        routing.finalProvider = provider.providerId;

        // Update health metrics
        this._capabilityRegistry.updateHealth(provider.providerId, 1.0);

        return { response, routing };
      } catch (error) {
        const latencyMs = Date.now() - startTime;
        const err = error instanceof Error ? error : new Error(String(error));

        routing.attempts.push({
          provider: provider.providerId,
          model: request.model || 'default',
          latencyMs,
          success: false,
          error: err.message,
        });

        lastError = err;

        // Update degraded health
        this._capabilityRegistry.updateHealth(provider.providerId, 0.7, 'degraded');
      }
    }

    // All providers failed
    const errMsg = lastError?.message ?? 'All providers failed';
    throw new Error(`Model routing failed after ${routing.attempts.length} attempts: ${errMsg}`);
  }

  // ── Health ──

  async checkAllHealth(): Promise<
    Array<{ providerId: string; healthy: boolean; error?: string }>
  > {
    const results: Array<{ providerId: string; healthy: boolean; error?: string }> = [];

    for (const provider of this._providers.values()) {
      try {
        const healthy = await provider.healthCheck();
        results.push({ providerId: provider.providerId, healthy });
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        results.push({
          providerId: provider.providerId,
          healthy: false,
          error: err.message,
        });
      }
    }

    return results;
  }

  // ── Private ──

  private _orderedProviders(
    preferredId: string | undefined,
    policy: RoutingPolicy,
  ): TextGenerationProvider[] {
    const all = Array.from(this._providers.values());
    if (all.length === 0) return [];

    // If preferred provider specified, try it first
    if (preferredId) {
      const preferred = all.find(p => p.providerId === preferredId);
      const rest = all.filter(p => p.providerId !== preferredId);
      return preferred ? [preferred, ...rest] : all;
    }

    // Sort by cost (for cost-optimized) or quality assumption
    if (policy === 'cost-optimized') {
      // Anthropic tends to be cheaper at scale, then OpenAI mini models
      return all.sort((a, b) => {
        const aIsAnthropic = a.providerId.includes('anthropic') ? 0 : 1;
        const bIsAnthropic = b.providerId.includes('anthropic') ? 0 : 1;
        return aIsAnthropic - bIsAnthropic;
      });
    }

    // Default: balanced — just use as-is
    return all;
  }
}
