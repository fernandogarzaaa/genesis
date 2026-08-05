// ─── Genesis Kernel: Internal Types ───────────────────────────────────
// These extend the frontend types with kernel-internal concerns

import type { v4 as uuid } from 'uuid';

// ── Lifecycle ──
export type KernelState =
  | 'uninitialized'
  | 'booting'
  | 'initializing'
  | 'running'
  | 'degraded'
  | 'paused'
  | 'stopping'
  | 'stopped'
  | 'destroyed';

export interface LifecycleTransition {
  from: KernelState;
  to: KernelState;
  timestamp: number;
  reason: string;
}

// ── Capability Registry ──
export interface CapabilityDescriptor {
  id: string;
  version: string;
  interface: string; // TypeScript interface name
  description: string;
  sla: {
    latencyP50Ms: number;
    latencyP99Ms: number;
    availability: number;
  };
  tags: string[];
  deprecated: boolean;
  replaces: string[];
}

export interface ProviderDescriptor {
  id: string;
  capabilityId: string;
  version: string;
  tier: 1 | 2 | 3; // Trust tier
  health: number; // 0-1
  status: 'healthy' | 'degraded' | 'unhealthy' | 'starting' | 'stopping';
  metrics: {
    latencyP50Ms: number;
    latencyP99Ms: number;
    availability: number;
    qualityScore: number;
    costPerUnit: number;
  };
  recentFailures: number;
}

export type RoutingPolicy =
  | 'cost-optimized'
  | 'quality-optimized'
  | 'balanced'
  | 'lowest-latency';

// ── Event System ──
export type EventPriority = 0 | 1 | 2 | 3 | 4; // CRITICAL → BEST_EFFORT

export interface EventEnvelope<T = unknown> {
  eventId: string;
  correlationId: string;
  causationId: string | null;
  traceId: string;
  type: string;
  version: string;
  timestamp: number;
  priority: EventPriority;
  source: {
    component: string;
    instance: string;
    host: string;
  };
  payload: T;
  idempotencyKey?: string;
  expiresAt?: number;
  redeliveryCount: number;
}

export interface CommandEnvelope<T = unknown> extends EventEnvelope<T> {
  responseChannel: string;
  timeoutMs: number;
}

export type EventHandler<T = unknown> = (
  event: EventEnvelope<T>
) => Promise<void> | void;

export interface EventSubscription {
  id: string;
  pattern: string; // e.g., 'cog.*' or 'cog.execution.completed'
  handler: EventHandler;
  priority: number;
  replayCapable: boolean;
}

// ── Storage ──
export interface EventStoreRecord {
  sequence: number;
  stream: string;
  event: EventEnvelope;
  storedAt: number;
}

export interface StateDocument {
  collection: string;
  key: string;
  data: unknown;
  version: number;
  createdAt: number;
  updatedAt: number;
}

export interface TimeSeriesPoint {
  metricName: string;
  tags: Record<string, string>;
  value: number;
  timestamp: number;
}

export interface VectorRecord {
  id: string;
  collection: string;
  embedding: number[];
  metadata: Record<string, unknown>;
}

// ── Cognitive Loop ──
export type CognitivePhase =
  | 'observe'
  | 'orient'
  | 'decide'
  | 'reflect'
  | 'simulate'
  | 'act'
  | 'learn';

export interface CognitiveCycleContext {
  cycleId: string;
  taskId: string;
  phase: CognitivePhase;
  startedAt: number;
  deadline?: number;
  workingMemory: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

// ── AI Provider ──
export interface TextGenerationRequest {
  model: string;
  messages: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string;
  }>;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  stopSequences?: string[];
  stream?: boolean;
}

export interface TextGenerationResponse {
  content: string;
  model: string;
  tokensUsed: {
    input: number;
    output: number;
    total: number;
  };
  finishReason: 'stop' | 'length' | 'content_filter' | 'error';
  latencyMs: number;
  cost: number;
}

export interface TextGenerationProvider {
  readonly providerId: string;
  readonly providerName: string;
  readonly supportedModels: string[];
  generate(
    request: TextGenerationRequest
  ): Promise<TextGenerationResponse>;
  healthCheck(): Promise<boolean>;
  getCapabilities(): string[];
}

// ── Tool System ──
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, {
    type: string;
    description: string;
    required: boolean;
    default?: unknown;
  }>;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  requiresApproval: boolean;
}

export interface ToolInvocation {
  toolName: string;
  parameters: Record<string, unknown>;
  invocationId: string;
  timeoutMs: number;
  sandboxed: boolean;
}

export interface ToolResult {
  invocationId: string;
  success: boolean;
  output: unknown;
  error?: string;
  latencyMs: number;
  sideEffects: string[];
}

export interface ToolProvider {
  readonly providerId: string;
  readonly tools: ToolDefinition[];
  execute(invocation: ToolInvocation): Promise<ToolResult>;
  validateParameters(
    toolName: string,
    parameters: Record<string, unknown>
  ): boolean;
}

// ── DI Container ──
export type Lifecycle = 'singleton' | 'subsystem' | 'cognitive_cycle' | 'request' | 'transient';

export interface DIContainer {
  register<T>(
    capabilityId: string,
    provider: () => T,
    lifecycle: Lifecycle
  ): void;
  resolve<T>(capabilityId: string): T;
  createScope(): Scope;
  disposeScope(scope: Scope): void;
}

export interface Scope {
  id: string;
  instances: Map<string, unknown>;
  parent: Scope | null;
}
