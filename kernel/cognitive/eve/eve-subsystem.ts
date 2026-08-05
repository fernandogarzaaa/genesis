// ─── Genesis Kernel: EVE — Perceptual Cognitive Subsystem ───────────
// §7 — Observes, attends, validates, expects, reflects.
// The system's connection to reality. Primary safety net.

import { v4 as uuid } from 'uuid';
import { EventBus } from '../../events/event-bus.js';
import { VectorStore } from '../../storage/vector-store.js';
import { StorageEngine } from '../../storage/sqlite-store.js';

interface Observation {
  observationId: string;
  traceId: string;
  source: 'user' | 'tool' | 'system' | 'external' | 'sensor';
  modality: 'text' | 'image' | 'audio' | 'structured';
  content: unknown;
  metadata: {
    timestamp: number;
    latencyFromSourceMs: number;
    encoding: string;
    sizeBytes: number;
  };
  enrichment: {
    entities: string[];
    sentiment: number;
    language: string;
    classification: string;
  };
}

interface ValidationCheck {
  type: string;
  pass: boolean;
  confidence: number;
  details: string;
}

interface ValidationResult {
  validationId: string;
  validatedAgainst: string;
  checks: ValidationCheck[];
  overall: 'pass' | 'fail' | 'uncertain';
  action: 'approve' | 'veto' | 'flag_for_review';
  reason: string;
}

interface ReflectionResult {
  reflectionId: string;
  planId: string;
  similarExperiences: Array<{
    experienceId: string;
    similarity: number;
    outcome: string;
    risk: string;
  }>;
  failurePatternsMatched: string[];
  riskEstimate: {
    probabilityOfFailure: number;
    worstCaseImpact: string;
    uncertainty: number;
  };
  decision: 'pass' | 'revise' | 'escalate';
  critique: string;
  vetoExpiresAt: number | null;
}

export class EVESubsystem {
  readonly id = 'eve';
  readonly name = 'EVE — Perceptual Function';
  private _bus: EventBus;
  private _vectorStore: VectorStore;
  private _storage: StorageEngine;
  private _workingMemory: Map<string, { content: unknown; attentionWeight: number; timestamp: number }> = new Map();
  private _knownFailurePatterns: string[] = [
    'overconfident_planning',
    'missing_fallback_step',
    'single_point_of_failure',
    'untested_tool_usage',
    'insufficient_context',
    'token_limit_risk',
    'rate_limit_risk',
  ];

  constructor(bus: EventBus, vectorStore: VectorStore, storage: StorageEngine) {
    this._bus = bus;
    this._vectorStore = vectorStore;
    this._storage = storage;

    // Subscribe to relevant events
    this._bus.subscribe('cog.task.planned', this._onPlanCreated.bind(this));
    this._bus.subscribe('cog.task.executing', this._onExecutionStart.bind(this));
    this._bus.subscribe('cog.task.completed', this._onTaskCompleted.bind(this));
  }

  // ── Observation ──

  async observe(
    content: unknown,
    source: Observation['source'] = 'user',
    modality: Observation['modality'] = 'text',
  ): Promise<Observation> {
    const startTime = Date.now();

    const observation: Observation = {
      observationId: uuid(),
      traceId: uuid(),
      source,
      modality,
      content,
      metadata: {
        timestamp: Date.now(),
        latencyFromSourceMs: 0,
        encoding: typeof content === 'string' ? 'utf-8' : 'json',
        sizeBytes:
          typeof content === 'string'
            ? Buffer.byteLength(content, 'utf-8')
            : Buffer.byteLength(JSON.stringify(content), 'utf-8'),
      },
      enrichment: {
        entities: this._extractEntities(content),
        sentiment: this._estimateSentiment(content),
        language: 'en',
        classification: this._classifyInput(content),
      },
    };

    observation.metadata.latencyFromSourceMs = Date.now() - startTime;

    // Store in working memory
    this._workingMemory.set(observation.observationId, {
      content,
      attentionWeight: 1.0,
      timestamp: Date.now(),
    });

    // Emit
    await this._bus.publish('perc.observation.received', observation);
    await this._bus.publish('perc.observation.processed', {
      observationId: observation.observationId,
      enrichment: observation.enrichment,
    });

    return observation;
  }

  // ── Attention ──

  computeAttention(contextIds: string[]): Array<{ id: string; weight: number }> {
    const weights: Array<{ id: string; weight: number }> = [];
    const now = Date.now();

    for (const id of contextIds) {
      const entry = this._workingMemory.get(id);
      if (entry) {
        // Recency boost: newer items get higher weight
        const age = now - entry.timestamp;
        const recencyBoost = Math.exp(-age / (30 * 60 * 1000)); // half-life of 30 min
        const weight = entry.attentionWeight * recencyBoost;
        weights.push({ id, weight });
      }
    }

    // Normalize
    const total = weights.reduce((sum, w) => sum + w.weight, 0);
    if (total > 0) {
      for (const w of weights) {
        w.weight = w.weight / total;
      }
    }

    return weights.sort((a, b) => b.weight - a.weight);
  }

  // ── Validation ──

  async validate(
    executionId: string,
    output: string,
    constraints: { expectedStructure?: string; safetyCheck?: boolean; factualCheck?: boolean } = {},
  ): Promise<ValidationResult> {
    const checks: ValidationCheck[] = [];

    // Check 1: Format/Structure compliance
    if (constraints.expectedStructure) {
      const structurePass = output.includes(constraints.expectedStructure) ||
        output.length > 0;
      checks.push({
        type: 'format_compliance',
        pass: structurePass,
        confidence: structurePass ? 0.95 : 0.3,
        details: structurePass
          ? 'Output matches expected structure'
          : 'Output does not match expected format',
      });
    }

    // Check 2: Logical consistency (basic heuristics)
    const consistencyPass = !this._hasContradictions(output);
    checks.push({
      type: 'logical_consistency',
      pass: consistencyPass,
      confidence: consistencyPass ? 0.9 : 0.5,
      details: consistencyPass
        ? 'No internal contradictions detected'
        : 'Potential contradictions found',
    });

    // Check 3: Safety (basic content filtering)
    if (constraints.safetyCheck !== false) {
      const safetyPass = !this._containsHarmfulContent(output);
      checks.push({
        type: 'safety',
        pass: safetyPass,
        confidence: safetyPass ? 0.95 : 0.85,
        details: safetyPass
          ? 'No harmful content detected'
          : 'Potentially harmful content flagged',
      });
    }

    // Check 4: Hallucination detection (heuristic)
    const hallucinationRisk = this._estimateHallucinationRisk(output);
    checks.push({
      type: 'hallucination',
      pass: hallucinationRisk < 0.5,
      confidence: 0.7,
      details:
        hallucinationRisk < 0.3
          ? 'Low hallucination risk'
          : hallucinationRisk < 0.6
            ? 'Moderate hallucination risk'
            : 'High hallucination risk — review recommended',
    });

    const failedChecks = checks.filter(c => !c.pass);
    const overall: ValidationResult['overall'] =
      failedChecks.length === 0
        ? 'pass'
        : failedChecks.some(c => c.type === 'safety')
          ? 'fail'
          : 'uncertain';

    const action: ValidationResult['action'] =
      overall === 'pass' ? 'approve' : overall === 'fail' ? 'veto' : 'flag_for_review';

    const result: ValidationResult = {
      validationId: uuid(),
      validatedAgainst: executionId,
      checks,
      overall,
      action,
      reason:
        failedChecks.length > 0
          ? `Failed checks: ${failedChecks.map(c => c.type).join(', ')}`
          : 'All checks passed',
    };

    await this._bus.publish('perc.validation.completed', result);

    return result;
  }

  // ── Expectation ──

  formExpectation(
    actionId: string,
    expectedOutcome: string,
    confidence: number,
  ): void {
    const expectation = {
      actionId,
      expectedOutcome,
      confidence,
      formedAt: Date.now(),
    };

    this._workingMemory.set(`expectation:${actionId}`, {
      content: expectation,
      attentionWeight: 0.8,
      timestamp: Date.now(),
    });

    this._bus.publish('perc.expectation.formed', expectation);
  }

  // ── Reflection (the safety net) ──

  async reflect(
    planId: string,
    planDescription: string,
    plannedActions: string[],
  ): Promise<ReflectionResult> {
    // Search episodic memory for similar past plans
    const similarExperiences = await this._findSimilarExperiences(planDescription);

    // Check for known failure patterns
    const matchedPatterns = this._detectFailurePatterns(planDescription, plannedActions);

    // Estimate risk
    const riskEstimate = this._estimateRisk(similarExperiences, matchedPatterns);

    let decision: ReflectionResult['decision'];
    let critique = '';

    if (riskEstimate.probabilityOfFailure > 0.5) {
      decision = 'escalate';
      critique = `High risk (${(riskEstimate.probabilityOfFailure * 100).toFixed(0)}% failure probability). Matched patterns: ${matchedPatterns.join(', ') || 'none'}. Human review required.`;
    } else if (riskEstimate.probabilityOfFailure > 0.25 || matchedPatterns.length > 0) {
      decision = 'revise';
      critique = `Moderate risk identified. Patterns: ${matchedPatterns.join(', ') || 'none'}. ${similarExperiences.length > 0 ? `${similarExperiences.length} similar past experiences found.` : ''} Consider adding fallback steps.`;
    } else {
      decision = 'pass';
      critique = 'Plan looks reasonable. No significant risks identified.';
    }

    const result: ReflectionResult = {
      reflectionId: uuid(),
      planId,
      similarExperiences: similarExperiences.slice(0, 5),
      failurePatternsMatched: matchedPatterns,
      riskEstimate,
      decision,
      critique,
      vetoExpiresAt: null,
    };

    await this._bus.publish('perc.reflection.completed', result);

    return result;
  }

  // ── Anomaly Detection ──

  detectAnomaly(
    metricName: string,
    currentValue: number,
    historicalValues: number[],
    threshold: number = 3,
  ): { isAnomaly: boolean; severity: 'low' | 'medium' | 'high' | 'critical'; zScore: number } {
    if (historicalValues.length < 10) {
      return { isAnomaly: false, severity: 'low', zScore: 0 };
    }

    const mean = historicalValues.reduce((s, v) => s + v, 0) / historicalValues.length;
    const variance =
      historicalValues.reduce((s, v) => s + (v - mean) ** 2, 0) /
      historicalValues.length;
    const stdDev = Math.sqrt(variance);

    if (stdDev === 0) {
      return { isAnomaly: currentValue !== mean, severity: 'low', zScore: 0 };
    }

    const zScore = Math.abs((currentValue - mean) / stdDev);
    const isAnomaly = zScore > threshold;

    let severity: 'low' | 'medium' | 'high' | 'critical' = 'low';
    if (zScore > 6) severity = 'critical';
    else if (zScore > 4) severity = 'high';
    else if (zScore > threshold) severity = 'medium';

    if (isAnomaly) {
      this._bus.publish('perc.anomaly.detected', {
        anomalyType: 'statistical_outlier',
        severity,
        context: { metricName, currentValue, mean, stdDev, zScore },
      });
    }

    return { isAnomaly, severity, zScore };
  }

  // ── Working Memory ──

  addToWorkingMemory(key: string, content: unknown, attentionWeight = 0.5): void {
    this._workingMemory.set(key, { content, attentionWeight, timestamp: Date.now() });
  }

  getFromWorkingMemory(key: string): unknown | null {
    return this._workingMemory.get(key)?.content ?? null;
  }

  pruneWorkingMemory(maxAgeMs: number = 30 * 60 * 1000): number {
    const cutoff = Date.now() - maxAgeMs;
    let removed = 0;
    for (const [key, entry] of this._workingMemory) {
      if (entry.timestamp < cutoff) {
        this._workingMemory.delete(key);
        removed++;
      }
    }
    return removed;
  }

  get workingMemorySize(): number {
    return this._workingMemory.size;
  }

  // ── Lifecycle ──

  async healthCheck(): Promise<boolean> {
    // EVE is healthy as long as it's instantiated
    return true;
  }

  stop(): void {
    this._workingMemory.clear();
  }

  // ── Private Helpers ──

  private _extractEntities(content: unknown): string[] {
    if (typeof content !== 'string') return [];
    // Simple entity extraction: capitalized words and common patterns
    const words = content.split(/\s+/);
    const entities = words.filter(w => /^[A-Z][a-z]{2,}/.test(w));
    // Also detect file paths, URLs, code references
    const patterns = [
      /`[^`]+`/g,  // code references
      /https?:\/\/[^\s]+/g,  // URLs
      /\/[\w./-]+/g,  // file paths
    ];
    for (const pattern of patterns) {
      const matches = content.match(pattern);
      if (matches) entities.push(...matches);
    }
    return [...new Set(entities)].slice(0, 20);
  }

  private _estimateSentiment(content: unknown): number {
    if (typeof content !== 'string') return 0;
    const positive = ['good', 'great', 'excellent', 'success', 'works', 'working', 'yes', 'thanks', 'correct', 'perfect', 'well', 'right'];
    const negative = ['bad', 'error', 'fail', 'failure', 'wrong', 'broken', 'no', 'bug', 'issue', 'problem', 'crash', 'incorrect'];
    const lower = content.toLowerCase();
    let score = 0;
    for (const word of positive) {
      if (lower.includes(word)) score += 1;
    }
    for (const word of negative) {
      if (lower.includes(word)) score -= 1;
    }
    // Normalize to [-1, 1]
    return Math.max(-1, Math.min(1, score / 10));
  }

  private _classifyInput(content: unknown): string {
    if (typeof content !== 'string') return 'structured';
    const lower = content.toLowerCase();
    if (/```[\s\S]*```/.test(content)) return 'code';
    if (/https?:\/\/[^\s]+/.test(content)) return 'reference';
    if (content.includes('?') && content.length < 200) return 'question';
    if (content.length > 500) return 'detailed_query';
    return 'message';
  }

  private _hasContradictions(text: string): boolean {
    // Basic contradiction detection
    const patterns = [
      { a: 'always', b: 'never', same: true },
      { a: 'yes', b: 'no', near: 50 },
    ];
    for (const pattern of patterns) {
      const idxA = text.toLowerCase().indexOf(pattern.a);
      const idxB = text.toLowerCase().indexOf(pattern.b);
      if (idxA >= 0 && idxB >= 0) {
        if (pattern.same || (pattern.near && Math.abs(idxA - idxB) < pattern.near)) {
          return true;
        }
      }
    }
    return false;
  }

  private _containsHarmfulContent(text: string): boolean {
    // Basic harmful content detection — production would use a classifier model
    const harmfulPatterns = [
      /hack\s+(into|the)\s+(system|server|database)/i,
      /exploit\s+(the|a)\s+vulnerability/i,
      /bypass\s+(security|authentication|authorization)/i,
      /malicious\s+(code|script|payload)/i,
      /steal\s+(credentials|passwords|data|tokens)/i,
    ];
    return harmfulPatterns.some(p => p.test(text));
  }

  private _estimateHallucinationRisk(text: string): number {
    if (typeof text !== 'string') return 0.5;
    let risk = 0;
    // High confidence but no sources
    if (/\b(definitely|absolutely|certainly|undoubtedly)\b/i.test(text) &&
        !/according to|source|reference|citation/i.test(text)) {
      risk += 0.3;
    }
    // Making specific claims with numbers that seem implausible
    const numbers = text.match(/\d+(?:\.\d+)?/g);
    if (numbers && numbers.length > 5) {
      risk += 0.2;
    }
    // Very short responses to complex questions
    if (text.length < 50 && text.split(/\s+/).length > 10) {
      risk += 0.1;
    }
    return Math.min(1, risk);
  }

  private async _findSimilarExperiences(
    description: string,
  ): Promise<Array<{ experienceId: string; similarity: number; outcome: string; risk: string }>> {
    // Search vector store for similar experiences
    try {
      // Create a simple embedding from text (character-level n-grams as fallback)
      const embedding = this._simpleEmbed(description);
      const results = this._vectorStore.search('episodic_memory', embedding, 5);

      return results.map(r => ({
        experienceId: r.id,
        similarity: r.score,
        outcome: (r.metadata.outcome as string) ?? 'unknown',
        risk: (r.metadata.risk as string) ?? 'medium',
      }));
    } catch {
      return [];
    }
  }

  private _simpleEmbed(text: string, dimensions = 128): number[] {
    // Simple character n-gram hash embedding (fallback when no embedding model)
    const vec = new Array(dimensions).fill(0);
    for (let i = 0; i < text.length - 2; i++) {
      const trigram = text.substring(i, i + 3);
      let hash = 0;
      for (let j = 0; j < trigram.length; j++) {
        hash = (hash * 31 + trigram.charCodeAt(j)) & 0x7fffffff;
      }
      vec[hash % dimensions] += 1;
    }
    // Normalize
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    return norm > 0 ? vec.map(v => v / norm) : vec;
  }

  private _detectFailurePatterns(
    description: string,
    actions: string[],
  ): string[] {
    const matched: string[] = [];
    const lower = description.toLowerCase();

    if (actions.length > 5 && !lower.includes('fallback')) {
      matched.push('missing_fallback_step');
    }
    if (lower.includes('confident') || lower.includes('definitely') || lower.includes('certain')) {
      matched.push('overconfident_planning');
    }
    if (actions.length === 1 && actions[0].length > 100) {
      matched.push('single_point_of_failure');
    }
    if (/api|external|remote|network|http/i.test(lower)) {
      matched.push('rate_limit_risk');
    }
    if (lower.length > 2000) {
      matched.push('token_limit_risk');
    }

    return matched;
  }

  private _estimateRisk(
    experiences: Array<{ outcome: string; similarity: number }>,
    patterns: string[],
  ): { probabilityOfFailure: number; worstCaseImpact: string; uncertainty: number } {
    let probabilityOfFailure = 0.1; // base risk

    // Past similar experiences with failures raise risk
    const failures = experiences.filter(e => e.outcome === 'failure');
    if (failures.length > 0) {
      probabilityOfFailure += failures.length * 0.15;
    }

    // Failure patterns raise risk
    probabilityOfFailure += patterns.length * 0.1;

    // Uncertainty increases with fewer experiences
    const uncertainty = experiences.length === 0 ? 0.4 : 0.1;

    // Worst case impact
    let worstCaseImpact = 'low';
    if (patterns.includes('single_point_of_failure')) worstCaseImpact = 'high';
    else if (patterns.length >= 3) worstCaseImpact = 'high';
    else if (patterns.length >= 1) worstCaseImpact = 'medium';

    return {
      probabilityOfFailure: Math.min(0.95, probabilityOfFailure),
      worstCaseImpact,
      uncertainty,
    };
  }

  // ── Event Handlers ──

  private async _onPlanCreated(event: { payload: { planId: string; description: string; steps: Array<{ action: string }> } }): Promise<void> {
    const { planId, description, steps } = event.payload;
    const actions = steps.map(s => s.action);
    await this.reflect(planId, description, actions);
  }

  private _onExecutionStart(event: { payload: { taskId: string; stepId: string; action: string } }): void {
    const { action } = event.payload;
    this.formExpectation(
      event.payload.stepId,
      action,
      0.7,
    );
  }

  private async _onTaskCompleted(event: { payload: { taskId: string; result: string; success: boolean } }): Promise<void> {
    const { taskId, result, success } = event.payload;

    // Store in episodic memory
    const experience = {
      id: uuid(),
      taskId,
      experience: result,
      outcome: success ? 'success' : 'failure',
      context: {},
      timestamp: Date.now(),
    };

    // Add vector embedding for similarity search
    const embedding = this._simpleEmbed(result);
    this._vectorStore.insert('episodic_memory', [
      { embedding, metadata: { outcome: experience.outcome, taskId, risk: success ? 'low' : 'high' } },
    ]);

    await this._bus.publish('perc.experience.recorded', experience);
  }
}
