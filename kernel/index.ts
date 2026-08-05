// ─── Genesis Kernel: Entry Point ────────────────────────────────────
// Boot sequence: §4.4 — Loads config, initializes storage, starts bus,
// registers capabilities, resolves dependencies, starts subsystems.

import 'dotenv/config';
import { LifecycleManager } from './core/lifecycle.js';
import { Supervisor } from './core/supervisor.js';
import { DIContainerImpl } from './core/di-container.js';
import { CapabilityRegistry } from './core/capability-registry.js';
import { EventBus } from './events/event-bus.js';
import { StorageEngine } from './storage/sqlite-store.js';
import { VectorStore } from './storage/vector-store.js';
import { ProviderRegistry } from './providers/provider-registry.js';
import { OpenAIProvider } from './providers/openai-provider.js';
import { AnthropicProvider } from './providers/anthropic-provider.js';
import { AXIOMSubsystem } from './cognitive/axiom/axiom-subsystem.js';
import { EVESubsystem } from './cognitive/eve/eve-subsystem.js';
import { ADAMSubsystem } from './cognitive/adam/adam-subsystem.js';
import { WSServer } from './api/ws-server.js';
import { SecurityEnforcer, type SecurityConfig } from './security/index.js';
import { redactSecrets } from './security/secret-store.js';

export interface GenesisConfig {
  dbPath?: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  wsPort?: number;
  hostId?: string;
  security?: Partial<SecurityConfig>;
}

export class GenesisKernel {
  readonly lifecycle: LifecycleManager;
  readonly di: DIContainerImpl;
  readonly capabilityRegistry: CapabilityRegistry;
  readonly eventBus: EventBus;
  readonly storage: StorageEngine;
  readonly vectorStore: VectorStore;
  readonly providerRegistry: ProviderRegistry;
  readonly security: SecurityEnforcer;
  readonly supervisor: Supervisor;
  readonly wsServer: WSServer;

  // Cognitive subsystems
  axiom!: AXIOMSubsystem;
  eve!: EVESubsystem;
  adam!: ADAMSubsystem;

  private _config: GenesisConfig;
  private _openAIProvider?: OpenAIProvider;
  private _anthropicProvider?: AnthropicProvider;

  constructor(config: GenesisConfig = {}) {
    this._config = config;

    // Phase 1: Preflight — Core infrastructure
    this.lifecycle = new LifecycleManager();
    this.di = new DIContainerImpl();
    this.capabilityRegistry = new CapabilityRegistry();
    this.eventBus = new EventBus(config.hostId ?? 'genesis-node-1');
    this.storage = new StorageEngine(config.dbPath ?? ':memory:');

    // Initialize security BEFORE other components that may need it
    this.security = new SecurityEnforcer(this.storage.db, {
      ...config.security,
    });

    // Supervisor: monitors component health, handles crash recovery
    this.supervisor = new Supervisor(
      this.lifecycle,
      this.eventBus,
      config.hostId ?? 'genesis-node-1',
    );

    this.vectorStore = new VectorStore();
    this.providerRegistry = new ProviderRegistry(this.capabilityRegistry);

    // WS Server now requires SecurityEnforcer
    this.wsServer = new WSServer(this, this.security, config.wsPort ?? 3001);

    // Wire storage to event bus
    this.storage.setEventBus(this.eventBus);
  }

  // ── Boot Sequence (§4.4) ──

  async boot(): Promise<void> {
    try {
      // Phase 1: Preflight
      await this.lifecycle.start();
      console.log('[Genesis] Phase 1: Preflight complete');
      await this.lifecycle.bootComplete();

      // Phase 2: Infrastructure
      this._registerCoreCapabilities();
      console.log('[Genesis] Phase 2: Infrastructure ready');

      // Phase 3: Capability Registration
      this._registerAIProviders();
      console.log('[Genesis] Phase 3: Capabilities registered');

      // Phase 4: Subsystem Start
      await this._startSubsystems();
      await this.lifecycle.initComplete();
      console.log('[Genesis] Phase 4: Subsystems started');

      // Start supervisor heartbeat monitoring
      this.supervisor.start();
      console.log('[Genesis] Supervisor: heartbeat monitoring active');

      // Phase 5: Security Bootstrap
      const operatorToken = this.security.bootstrapOperatorToken();
      if (operatorToken) {
        // Log token — will be redacted in production by secret redaction
        // but we want the user to see it on first boot
      }

      // Phase 6: External
      await this.wsServer.start();
      console.log(`[Genesis] Phase 6: WebSocket server on port ${this._config.wsPort ?? 3001}`);

      // Phase 7: Running
      await this.eventBus.publish('system.started', {
        instanceId: this.lifecycle.instanceId,
        timestamp: Date.now(),
        version: '1.0.0',
        securityMode: this.security.devMode ? 'dev' : 'production',
      });

      const modeStr = this.security.devMode ? 'DEV MODE (auth disabled)' : 'PRODUCTION MODE';
      console.log('[Genesis] KERNEL RUNNING ✓');
      console.log(`  Mode: ${modeStr}`);
      console.log(`  State: ${this.lifecycle.state}`);
      console.log(`  Events: ${this.eventBus.stats.eventsPublished} published`);
      console.log(`  Providers: ${this.providerRegistry.listProviders().length} registered`);
      console.log(`  Secrets: ${this.security.secretStore.listSecrets().length} stored`);
      console.log('─────────────────────────────────────────────');
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      console.error('[Genesis] BOOT FAILED:', redactSecrets(err.message));
      await this.eventBus.publish('kernel.boot.failed', {
        phase: 'unknown',
        error: redactSecrets(err.message),
        stack: err.stack ? redactSecrets(err.stack) : undefined,
      });
      await this.lifecycle.stop(redactSecrets(err.message));
      throw error;
    }
  }

  // ── Shutdown Sequence (§4.5) ──

  async shutdown(reason: string = 'operator request'): Promise<void> {
    console.log(`[Genesis] Shutting down: ${reason}`);

    await this.lifecycle.stop(reason);
    await this.eventBus.publish('system.stopping', { reason });

    // Stop WS server (stop accepting connections)
    await this.wsServer.stop();

    // Stop supervisor (stops background tasks and heartbeat monitoring)
    await this.supervisor.stop();

    // Stop subsystems (in reverse order)
    this.adam?.stop();
    this.axiom?.stop();
    this.eve?.stop();

    await this.eventBus.publish('system.stopped', {
      instanceId: this.lifecycle.instanceId,
      timestamp: Date.now(),
      reason,
    });

    await this.lifecycle.stopComplete();

    // Close storage
    this.storage.close();

    console.log('[Genesis] SHUTDOWN COMPLETE');
  }

  // ── Public API ──

  async submitTask(goal: string, context?: string): Promise<string> {
    const taskId = crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    await this.eventBus.publish('cog.task.received', {
      taskId,
      goal,
      context: context ?? '',
      timestamp: Date.now(),
    });

    return taskId;
  }

  getSnapshot() {
    return {
      lifecycle: this.lifecycle.snapshot(),
      eventBus: this.eventBus.stats,
      capabilities: this.capabilityRegistry.listCapabilities().length,
      providers: this.providerRegistry.listProviders().map(p => ({
        id: p.providerId,
        name: p.providerName,
        models: p.supportedModels,
      })),
      vectorStore: this.vectorStore.stats(),
      supervisor: this.supervisor.snapshot(),
      security: {
        devMode: this.security.devMode,
        secretsStored: this.security.secretStore.listSecrets().length,
        apiTokens: this.security.auth.listApiTokens().length,
      },
      subsystems: {
        eve: {
          workingMemorySize: this.eve?.workingMemorySize ?? 0,
        },
        adam: {
          stats: this.adam?.stats ?? {},
        },
      },
    };
  }

  // ── Private ──

  private _registerCoreCapabilities(): void {
    // Kernel-owned capabilities
    const coreCaps = [
      { id: 'kernel.lifecycle', desc: 'Lifecycle management', tags: ['system', 'core'] },
      { id: 'kernel.scheduler', desc: 'Task scheduling', tags: ['system', 'core'] },
      { id: 'kernel.event_bus', desc: 'Event communication bus', tags: ['system', 'core'] },
      { id: 'kernel.config', desc: 'Configuration management', tags: ['system', 'core'] },
      { id: 'kernel.health', desc: 'Health monitoring', tags: ['system', 'core'] },
      { id: 'kernel.storage', desc: 'Storage engines', tags: ['system', 'core'] },
      { id: 'kernel.telemetry', desc: 'Telemetry pipeline', tags: ['system', 'core'] },
      { id: 'kernel.security', desc: 'Security enforcer', tags: ['system', 'core'] },
    ];

    for (const cap of coreCaps) {
      this.capabilityRegistry.registerCapability({
        id: cap.id,
        version: '1.0.0',
        interface: cap.id,
        description: cap.desc,
        sla: { latencyP50Ms: 1, latencyP99Ms: 5, availability: 1 },
        tags: cap.tags,
        deprecated: false,
        replaces: [],
      });
    }

    // Register infrastructure capability
    this.capabilityRegistry.registerCapability({
      id: 'infra.text_generation',
      version: '1.0.0',
      interface: 'TextGenerationProvider',
      description: 'Generate text from prompts via AI models',
      sla: { latencyP50Ms: 3000, latencyP99Ms: 10000, availability: 0.99 },
      tags: ['ai', 'nlp', 'generation'],
      deprecated: false,
      replaces: [],
    });
  }

  private _registerAIProviders(): void {
    // Read secrets from the encrypted store (preferred)
    // Fall back to process.env for backward compatibility (will be migrated)
    const secretStore = this.security.secretStore;
    const openaiKey =
      secretStore.getSecret('OPENAI_API_KEY') ??
      this._config.openaiApiKey ??
      process.env.OPENAI_API_KEY;

    const anthropicKey =
      secretStore.getSecret('ANTHROPIC_API_KEY') ??
      this._config.anthropicApiKey ??
      process.env.ANTHROPIC_API_KEY;

    if (openaiKey) {
      try {
        this._openAIProvider = new OpenAIProvider({
          apiKey: openaiKey,
          defaultModel: 'gpt-4o',
        });
        this.providerRegistry.registerProvider(this._openAIProvider);

        this.capabilityRegistry.registerProvider({
          id: this._openAIProvider.providerId,
          capabilityId: 'infra.text_generation',
          version: '1.0.0',
          tier: 2,
          health: 1.0,
          status: 'healthy',
          metrics: {
            latencyP50Ms: 1500,
            latencyP99Ms: 5000,
            availability: 0.998,
            qualityScore: 0.92,
            costPerUnit: 0.005,
          },
          recentFailures: 0,
        });

        console.log(`[Genesis] Provider registered: ${this._openAIProvider.providerName}`);
      } catch (error) {
        console.warn('[Genesis] OpenAI provider failed to initialize:', error);
      }
    } else {
      console.log('[Genesis] No OpenAI API key — skipping OpenAI provider');
    }

    if (anthropicKey) {
      try {
        this._anthropicProvider = new AnthropicProvider({
          apiKey: anthropicKey,
          defaultModel: 'claude-sonnet-4-20250514',
        });
        this.providerRegistry.registerProvider(this._anthropicProvider);

        this.capabilityRegistry.registerProvider({
          id: this._anthropicProvider.providerId,
          capabilityId: 'infra.text_generation',
          version: '1.0.0',
          tier: 2,
          health: 1.0,
          status: 'healthy',
          metrics: {
            latencyP50Ms: 2000,
            latencyP99Ms: 8000,
            availability: 0.997,
            qualityScore: 0.94,
            costPerUnit: 0.003,
          },
          recentFailures: 0,
        });

        console.log(`[Genesis] Provider registered: ${this._anthropicProvider.providerName}`);
      } catch (error) {
        console.warn('[Genesis] Anthropic provider failed to initialize:', error);
      }
    } else {
      console.log('[Genesis] No Anthropic API key — skipping Anthropic provider');
    }

    if (!openaiKey && !anthropicKey) {
      console.log('[Genesis] ⚠ No AI providers configured. Set OPENAI_API_KEY or ANTHROPIC_API_KEY in environment.');
    }
  }

  private async _startSubsystems(): Promise<void> {
    // EVE — perception first (observes everything)
    this.eve = new EVESubsystem(this.eventBus, this.vectorStore, this.storage);

    // AXIOM — executive function (plans and executes)
    this.axiom = new AXIOMSubsystem(this.eventBus, this.storage, this.providerRegistry);

    // ADAM — learning (learns from outcomes)
    this.adam = new ADAMSubsystem(this.eventBus, this.storage, this.vectorStore);

    // ── Register with Supervisor ──
    this.supervisor.register({
      name: 'axiom',
      healthCheck: () => this.axiom.healthCheck(),
      restartPolicy: 'always-backoff',
      dependencies: ['eve'],
      onStop: () => { this.axiom.stop(); return Promise.resolve(); },
    });

    this.supervisor.register({
      name: 'eve',
      healthCheck: () => this.eve.healthCheck(),
      restartPolicy: 'always-backoff',
      dependencies: [],
      onStop: () => { this.eve.stop(); return Promise.resolve(); },
    });

    this.supervisor.register({
      name: 'adam',
      healthCheck: () => this.adam.healthCheck(),
      restartPolicy: 'always-backoff',
      dependencies: ['eve'],
      onStop: async () => { this.adam.stop(); },
    });

    // ── Start ADAM's background tasks with lifecycle-aware scheduling ──
    this.adam.startBackgroundTasks(
      (name, fn, intervalMs) =>
        this.supervisor.scheduleRecurring(name, fn, intervalMs),
    );

    // Mark subsystems as started
    this.supervisor.markStarted('eve');
    this.supervisor.markStarted('axiom');
    this.supervisor.markStarted('adam');

    // Register cognitive capabilities
    const cogCaps = [
      { id: 'cog.planning', desc: 'Goal decomposition and planning', provider: 'axiom' },
      { id: 'cog.reasoning', desc: 'Logical reasoning and chain-of-thought', provider: 'axiom' },
      { id: 'cog.orchestration', desc: 'Multi-step execution coordination', provider: 'axiom' },
      { id: 'cog.execution', desc: 'Tool invocation and I/O management', provider: 'axiom' },
      { id: 'perc.observation', desc: 'Input ingestion and normalization', provider: 'eve' },
      { id: 'perc.validation', desc: 'Output checking against expectations', provider: 'eve' },
      { id: 'perc.reflection', desc: 'Pre-execution plan critique', provider: 'eve' },
      { id: 'perc.anomaly', desc: 'Anomaly and pattern drift detection', provider: 'eve' },
      { id: 'learn.experience', desc: 'Pattern extraction from outcomes', provider: 'adam' },
      { id: 'learn.strategy', desc: 'High-level strategy optimization', provider: 'adam' },
      { id: 'learn.policy', desc: 'Threshold and routing rule refinement', provider: 'adam' },
      { id: 'learn.meta', desc: 'Self-evaluation of learning effectiveness', provider: 'adam' },
    ];

    for (const cap of cogCaps) {
      this.capabilityRegistry.registerCapability({
        id: cap.id,
        version: '1.0.0',
        interface: cap.id,
        description: cap.desc,
        sla: { latencyP50Ms: 100, latencyP99Ms: 500, availability: 0.999 },
        tags: ['cognitive'],
        deprecated: false,
        replaces: [],
      });
    }

    console.log(`[Genesis] Cognitive subsystems: EVE ✓ | AXIOM ✓ | ADAM ✓`);
  }
}

// ── CLI Entry ──

if (process.argv[1]?.includes('kernel/index') || process.argv[1]?.endsWith('index.ts')) {
  const kernel = new GenesisKernel({
    dbPath: process.env.DB_PATH ?? './genesis.db',
    openaiApiKey: process.env.OPENAI_API_KEY,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY,
    wsPort: parseInt(process.env.WS_PORT ?? '3001', 10),
  });

  kernel.boot().catch(error => {
    console.error('Fatal:', redactSecrets(error instanceof Error ? error.message : String(error)));
    process.exit(1);
  });

  // Graceful shutdown
  process.on('SIGINT', () => kernel.shutdown('SIGINT'));
  process.on('SIGTERM', () => kernel.shutdown('SIGTERM'));
}
