// ─── Genesis Kernel: ADAM — Learning Cognitive Subsystem ────────────
// §8 — Learns from experience, optimizes strategies, refines policies,
// generates skills, and evolves the system over time.
// ADAM is a SINGLETON — exactly one per Genesis instance.

import { v4 as uuid } from 'uuid';
import { EventBus } from '../../events/event-bus.js';
import { StorageEngine } from '../../storage/sqlite-store.js';
import { VectorStore } from '../../storage/vector-store.js';

interface ExperiencePattern {
  patternId: string;
  pattern: string;
  type: 'success' | 'failure' | 'context';
  confidence: number;
  occurrences: number;
  lastSeen: number;
  sourceExperiences: string[];
}

interface Proposal {
  id: string;
  type: 'routing_rule_change' | 'prompt_optimization' | 'threshold_adjustment' | 'strategy_change' | 'skill_creation' | 'validation_rule';
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  status: 'draft' | 'sandbox_testing' | 'replay_testing' | 'risk_evaluation' | 'pending_approval' | 'approved' | 'rejected' | 'canary' | 'deployed' | 'rolled_back';
  description: string;
  rationale: string;
  evidence: string[];
  change: Record<string, unknown>;
  rollback: Record<string, unknown>;
  createdBy: string;
  createdAt: number;
  confidence: number;
  estimatedImpact: {
    metric: string;
    currentValue: number;
    predictedValue: number;
    confidence: number;
  };
  deploymentPhase?: string;
}

export class ADAMSubsystem {
  readonly id = 'adam';
  readonly name = 'ADAM — Learning Function';
  private _bus: EventBus;
  private _storage: StorageEngine;
  private _vectorStore: VectorStore;
  private _patterns: Map<string, ExperiencePattern> = new Map();
  private _proposals: Map<string, Proposal> = new Map();
  private _cleanupFns: Array<() => void> = [];
  private _learningStats = {
    totalExperiencesConsolidated: 0,
    totalProposalsCreated: 0,
    totalProposalsDeployed: 0,
    totalProposalsRejected: 0,
    lastConsolidation: 0,
    lastProposal: 0,
  };

  constructor(bus: EventBus, storage: StorageEngine, vectorStore: VectorStore) {
    this._bus = bus;
    this._storage = storage;
    this._vectorStore = vectorStore;

    // Consume experience and completion events
    this._bus.subscribe('perc.experience.recorded', this._onExperienceRecorded.bind(this));
    this._bus.subscribe('cog.task.completed', this._onTaskCompleted.bind(this));
    this._bus.subscribe('perc.validation.completed', this._onValidationCompleted.bind(this));
  }

  /**
   * Start background tasks using lifecycle-aware scheduling.
   * Called by the kernel after construction.
   *
   * @param schedule — A scheduler function like supervisor.scheduleRecurring.
   *   Accepts (name, fn, intervalMs) and returns a cleanup function.
   */
  startBackgroundTasks(
    schedule: (name: string, fn: () => Promise<void>, intervalMs: number) => () => void,
  ): void {
    // Meta-learning: periodically analyze learning effectiveness
    const metaCleanup = schedule('adam.meta_learn', () => this._metaLearn(), 5 * 60 * 1000);
    this._cleanupFns.push(metaCleanup);
  }

  /**
   * Stop all background tasks. Called during shutdown.
   */
  stop(): void {
    for (const cleanup of this._cleanupFns) {
      cleanup();
    }
    this._cleanupFns = [];
  }

  /** Health check for supervisor integration. */
  async healthCheck(): Promise<boolean> {
    return true; // ADAM is healthy if its constructor succeeded
  }

  // ── Experience Learning ──

  async consolidateExperience(
    experience: {
      id: string;
      taskId: string;
      experience: string;
      outcome: 'success' | 'partial' | 'failure';
      context: Record<string, unknown>;
    },
  ): Promise<ExperiencePattern[]> {
    const newPatterns: ExperiencePattern[] = [];

    // Extract patterns from the experience
    const extracted = this._extractPatterns(experience);

    for (const pattern of extracted) {
      const key = this._patternKey(pattern.type, pattern.pattern);
      const existing = this._patterns.get(key);

      if (existing) {
        existing.occurrences++;
        existing.lastSeen = Date.now();
        existing.sourceExperiences.push(experience.id);
        existing.confidence = Math.min(1, existing.confidence + 0.05);
      } else {
        const newPattern: ExperiencePattern = {
          patternId: uuid(),
          pattern: pattern.pattern,
          type: pattern.type,
          confidence: 0.3,
          occurrences: 1,
          lastSeen: Date.now(),
          sourceExperiences: [experience.id],
        };
        this._patterns.set(key, newPattern);
        newPatterns.push(newPattern);
      }
    }

    // Store in semantic memory (state store)
    this._storage.setState(
      'semantic_memory',
      `experience:${experience.id}`,
      experience,
    );

    // Also store as vector for similarity search
    const embedding = this._textToEmbedding(experience.experience);
    this._vectorStore.insert('semantic_memory', [
      {
        embedding,
        metadata: {
          outcome: experience.outcome,
          taskId: experience.taskId,
          consolidated: true,
        },
      },
    ]);

    this._learningStats.totalExperiencesConsolidated++;
    this._learningStats.lastConsolidation = Date.now();

    if (newPatterns.length > 0) {
      this._bus.publish('learn.experience.consolidated', {
        patterns: newPatterns.map(p => ({
          id: p.patternId,
          type: p.type,
          confidence: p.confidence,
        })),
        sourceExperiences: [experience.id],
      });
    }

    return newPatterns;
  }

  // ── Strategy Optimization ──

  optimizeStrategy(
    strategyId: string,
    currentMetrics: Record<string, number>,
    targetMetrics: Record<string, number>,
  ): Proposal | null {
    // Check if current performance deviates from targets
    const gaps: Array<{ metric: string; current: number; target: number; gap: number }> = [];
    for (const [metric, target] of Object.entries(targetMetrics)) {
      const current = currentMetrics[metric] ?? 0;
      if (Math.abs(current - target) / target > 0.1) {
        gaps.push({ metric, current, target, gap: target - current });
      }
    }

    if (gaps.length === 0) return null;

    // Create a proposal to adjust strategy
    const proposal: Proposal = {
      id: uuid(),
      type: 'strategy_change',
      riskLevel: 'low',
      status: 'draft',
      description: `Optimize strategy '${strategyId}' to close ${gaps.length} performance gaps`,
      rationale: gaps
        .map(g => `${g.metric}: ${g.current.toFixed(2)} → ${g.target.toFixed(2)}`)
        .join(', '),
      evidence: [],
      change: {
        strategyId,
        adjustments: gaps.map(g => ({
          metric: g.metric,
          direction: g.gap > 0 ? 'increase' : 'decrease',
          magnitude: Math.abs(g.gap),
        })),
      },
      rollback: {
        strategyId,
        revertTo: currentMetrics,
      },
      createdBy: 'adam.strategy_optimizer',
      createdAt: Date.now(),
      confidence: 0.6,
      estimatedImpact: {
        metric: gaps[0].metric,
        currentValue: gaps[0].current,
        predictedValue: gaps[0].target,
        confidence: 0.5,
      },
    };

    this._proposals.set(proposal.id, proposal);
    this._learningStats.totalProposalsCreated++;

    this._bus.publish('learn.proposal.created', {
      proposalId: proposal.id,
      type: proposal.type,
      riskLevel: proposal.riskLevel,
    });

    return proposal;
  }

  // ── Policy Refinement ──

  refinePolicy(
    policyId: string,
    currentSuccessRate: number,
    targetSuccessRate: number,
    sampleSize: number,
  ): Proposal | null {
    if (currentSuccessRate >= targetSuccessRate) return null;
    if (sampleSize < 10) return null; // Not enough data

    const proposal: Proposal = {
      id: uuid(),
      type: 'threshold_adjustment',
      riskLevel: 'medium',
      status: 'draft',
      description: `Refine policy '${policyId}' — success rate ${(currentSuccessRate * 100).toFixed(1)}% below target ${(targetSuccessRate * 100).toFixed(1)}%`,
      rationale: `Based on ${sampleSize} observations, the current policy is underperforming.`,
      evidence: [],
      change: {
        policyId,
        currentThreshold: currentSuccessRate,
        newThreshold: currentSuccessRate + (targetSuccessRate - currentSuccessRate) * 0.5,
        adjustmentFactor: 0.5,
      },
      rollback: {
        policyId,
        revertThreshold: currentSuccessRate,
      },
      createdBy: 'adam.policy_refiner',
      createdAt: Date.now(),
      confidence: Math.min(0.9, sampleSize / 100),
      estimatedImpact: {
        metric: 'success_rate',
        currentValue: currentSuccessRate,
        predictedValue: currentSuccessRate + (targetSuccessRate - currentSuccessRate) * 0.5,
        confidence: 0.6,
      },
    };

    this._proposals.set(proposal.id, proposal);
    this._learningStats.totalProposalsCreated++;

    this._bus.publish('learn.proposal.created', {
      proposalId: proposal.id,
      type: proposal.type,
      riskLevel: proposal.riskLevel,
    });

    return proposal;
  }

  // ── Proposal Lifecycle ──

  getProposal(proposalId: string): Proposal | undefined {
    return this._proposals.get(proposalId);
  }

  listProposals(status?: string): Proposal[] {
    const all = Array.from(this._proposals.values());
    return status
      ? all.filter(p => p.status === status)
      : all;
  }

  approveProposal(proposalId: string, approver: string = 'human'): void {
    const proposal = this._proposals.get(proposalId);
    if (!proposal) return;

    proposal.status = 'approved';
    proposal.deploymentPhase = 'canary';

    this._learningStats.totalProposalsDeployed++;

    this._bus.publish('learn.proposal.approved', {
      proposalId,
      approver,
    });

    this._bus.publish('learn.proposal.deployed', {
      proposalId,
      impact: proposal.estimatedImpact,
    });
  }

  rejectProposal(proposalId: string, reason: string, rejecter: string = 'human'): void {
    const proposal = this._proposals.get(proposalId);
    if (!proposal) return;

    proposal.status = 'rejected';
    this._learningStats.totalProposalsRejected++;

    this._bus.publish('learn.proposal.rejected', {
      proposalId,
      rejecter,
      reason,
    });
  }

  // ── Meta-Learning ──

  private async _metaLearn(): Promise<void> {
    const now = Date.now();
    const stats = this._learningStats;

    const metaReport = {
      period: 'current',
      metrics: {
        totalExperiencesConsolidated: stats.totalExperiencesConsolidated,
        totalProposalsCreated: stats.totalProposalsCreated,
        totalProposalsDeployed: stats.totalProposalsDeployed,
        totalProposalsRejected: stats.totalProposalsRejected,
        proposalAcceptanceRate:
          stats.totalProposalsCreated > 0
            ? stats.totalProposalsDeployed / stats.totalProposalsCreated
            : 0,
        activePatterns: this._patterns.size,
      },
      trends: {
        learningRate:
          stats.lastConsolidation > 0
            ? stats.totalExperiencesConsolidated /
              ((now - stats.lastConsolidation) / 3600000)
            : 0,
      },
    };

    this._bus.publish('learn.meta.report', metaReport);

    // Detect learning stagnation
    if (metaReport.trends.learningRate < 0.1 && stats.totalExperiencesConsolidated > 100) {
      this._bus.publish('learn.stagnation.detected', {
        reason: 'Learning rate has declined',
        currentRate: metaReport.trends.learningRate,
      });
    }
  }

  // ── Private ──

  private _extractPatterns(experience: {
    outcome: string;
    experience: string;
  }): Array<{ pattern: string; type: 'success' | 'failure' | 'context' }> {
    const patterns: Array<{ pattern: string; type: 'success' | 'failure' | 'context' }> = [];
    const text = experience.experience;

    // Extract n-grams that might be patterns
    const words = text.split(/\s+/);
    const trigrams = new Set<string>();
    for (let i = 0; i < words.length - 2; i++) {
      const trigram = `${words[i]} ${words[i + 1]} ${words[i + 2]}`;
      if (trigram.length > 10 && trigram.length < 80) {
        trigrams.add(trigram);
      }
    }

    const outcome = experience.outcome === 'success' ? 'success' : 'failure';
    for (const trigram of Array.from(trigrams).slice(0, 5)) {
      patterns.push({ pattern: trigram, type: outcome });
    }

    return patterns;
  }

  private _patternKey(type: string, pattern: string): string {
    return `${type}:${pattern.substring(0, 50)}`;
  }

  private _textToEmbedding(text: string, dimensions = 128): number[] {
    // Simple hash-based embedding (production uses a real embedding model)
    const vec = new Array(dimensions).fill(0);
    for (let i = 0; i < text.length; i++) {
      const charCode = text.charCodeAt(i);
      vec[charCode % dimensions] += 1;
    }
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    return norm > 0 ? vec.map(v => v / norm) : vec;
  }

  get stats() {
    return { ...this._learningStats, activePatterns: this._patterns.size };
  }

  // ── Event Handlers ──

  private async _onExperienceRecorded(
    event: { payload: { id: string; taskId: string; experience: string; outcome: string; context?: Record<string, unknown> } },
  ): Promise<void> {
    await this.consolidateExperience({
      id: event.payload.id,
      taskId: event.payload.taskId,
      experience: event.payload.experience,
      outcome: event.payload.outcome as 'success' | 'partial' | 'failure',
      context: event.payload.context ?? {},
    });
  }

  private async _onTaskCompleted(
    event: { payload: { taskId: string; outcome: string; metrics?: { cost: number; tokensUsed: number; latencyMs: number } } },
  ): Promise<void> {
    const { taskId, outcome, metrics } = event.payload;
    if (!metrics) return;

    // Track task metrics for optimization
    this._storage.writeMetric('task.success_rate', outcome === 'success' ? 1 : 0, { taskId });
    this._storage.writeMetric('task.cost', metrics.cost, { taskId });
    this._storage.writeMetric('task.latency', metrics.latencyMs ?? 0, { taskId });
    this._storage.writeMetric('task.tokens', metrics.tokensUsed, { taskId });
  }

  private _onValidationCompleted(
    event: { payload: { validatedAgainst: string; overall: string; checks: Array<{ type: string; pass: boolean }> } },
  ): void {
    const { validatedAgainst, overall, checks } = event.payload;

    // If validation failed despite high confidence in planning, that's a learning signal
    const failedChecks = checks.filter(c => !c.pass);
    if (failedChecks.length > 0) {
      this._storage.writeMetric('validation.failure', 1, {
        executionId: validatedAgainst,
        overall,
        failedTypes: failedChecks.map(c => c.type).join(','),
      });
    }
  }
}
