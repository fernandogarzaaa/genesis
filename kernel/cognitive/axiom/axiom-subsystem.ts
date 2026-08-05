// ─── Genesis Kernel: AXIOM — Executive Cognitive Subsystem ───────────
// §6 — Reasons, plans, orchestrates, and executes.
// The "decide and act" in the OODA-R-S-L loop.

import { v4 as uuid } from 'uuid';
import { EventBus } from '../../events/event-bus.js';
import { StorageEngine } from '../../storage/sqlite-store.js';
import { ProviderRegistry } from '../../providers/provider-registry.js';
import type {
  RoutingPolicy,
  TextGenerationRequest,
} from '../../core/kernel-types.js';

interface ExecutionPlan {
  planId: string;
  goal: string;
  steps: ExecutionStep[];
  estimatedTokens: number;
  estimatedCost: number;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  fallbackStrategy?: string;
  confidence: number;
}

interface ExecutionStep {
  stepId: string;
  action: string;
  dependencies: string[];
  capabilitiesRequired: string[];
  expectedOutcome: string;
  fallbackStepId: string | null;
  timeoutMs: number;
  maxRetries: number;
  riskLevel: 'low' | 'medium' | 'high';
  status: 'pending' | 'ready' | 'running' | 'completed' | 'failed' | 'retrying' | 'compensating' | 'abandoned';
  result?: string;
  error?: string;
  startTime?: number;
  endTime?: number;
}

export class AXIOMSubsystem {
  readonly id = 'axiom';
  readonly name = 'AXIOM — Executive Function';
  private _bus: EventBus;
  private _storage: StorageEngine;
  private _providerRegistry: ProviderRegistry;
  private _defaultPolicy: RoutingPolicy = 'balanced';

  constructor(
    bus: EventBus,
    storage: StorageEngine,
    providerRegistry: ProviderRegistry,
  ) {
    this._bus = bus;
    this._storage = storage;
    this._providerRegistry = providerRegistry;

    // Subscribe to task reception
    this._bus.subscribe('cog.task.received', this._onTaskReceived.bind(this));
    this._bus.subscribe('perc.reflection.completed', this._onReflectionCompleted.bind(this));
  }

  // ── Reasoning ──

  async reason(
    query: string,
    context: string = '',
    options?: {
      policy?: RoutingPolicy;
      temperature?: number;
      maxTokens?: number;
    },
  ): Promise<{
    answer: string;
    modelUsed: string;
    tokensUsed: number;
    cost: number;
    latencyMs: number;
  }> {
    const messages: TextGenerationRequest['messages'] = [];

    if (context) {
      messages.push({
        role: 'system',
        content: `You are AXIOM, the executive cognitive subsystem of Genesis. Use the following context to reason about the query.\n\nContext:\n${context}`,
      });
    } else {
      messages.push({
        role: 'system',
        content: 'You are AXIOM, the executive cognitive subsystem of Genesis. Reason step-by-step and provide clear, structured answers.',
      });
    }

    messages.push({ role: 'user', content: query });

    const { response } = await this._providerRegistry.generate(
      {
        messages,
        temperature: options?.temperature ?? 0.3,
        maxTokens: options?.maxTokens,
      },
      { policy: options?.policy ?? this._defaultPolicy },
    );

    return {
      answer: response.content,
      modelUsed: response.model,
      tokensUsed: response.tokensUsed.total,
      cost: response.cost,
      latencyMs: response.latencyMs,
    };
  }

  // ── Planning ──

  async plan(
    goal: string,
    context: string = '',
    constraints: {
      maxSteps?: number;
      allowedCapabilities?: string[];
      riskTolerance?: 'low' | 'medium' | 'high';
    } = {},
  ): Promise<ExecutionPlan> {
    const result = await this.reason(
      `Create an execution plan for the following goal:\n\n"${goal}"\n\n` +
      `Constraints: max steps: ${constraints.maxSteps ?? 10}, ` +
      `risk tolerance: ${constraints.riskTolerance ?? 'medium'}\n\n` +
      `Respond with a structured plan. For each step, specify:\n` +
      `- Action description\n` +
      `- Dependencies (which steps must complete first)\n` +
      `- Expected outcome\n` +
      `- Risk level (low/medium/high)\n\n` +
      `Also estimate total tokens, cost, and overall risk level.`,
      context,
      { temperature: 0.4 },
    );

    // Parse the plan from the model response
    const steps = this._parsePlanSteps(result.answer);
    const riskLevel = this._extractRiskLevel(result.answer);

    const plan: ExecutionPlan = {
      planId: uuid(),
      goal,
      steps: steps.map((s, i) => ({
        stepId: uuid(),
        action: s.action,
        dependencies: s.dependencies.map(d =>
          steps.findIndex(st => st.action.includes(d)) >= 0
            ? steps[steps.findIndex(st => st.action.includes(d))].action
            : '',
        ).filter(Boolean).map(a => steps.find(st => st.action === a)?.stepId ?? uuid()),
        capabilitiesRequired: ['infra.text_generation'],
        expectedOutcome: s.expectedOutcome,
        fallbackStepId: null,
        timeoutMs: 30000,
        maxRetries: s.riskLevel === 'high' ? 5 : 3,
        riskLevel: s.riskLevel as 'low' | 'medium' | 'high',
        status: 'pending',
      })),
      estimatedTokens: result.tokensUsed,
      estimatedCost: result.cost,
      riskLevel,
      confidence: 0.75,
    };

    // Emit event so EVE can reflect on this plan
    await this._bus.publish('cog.task.planned', {
      planId: plan.planId,
      goal,
      description: result.answer,
      steps: plan.steps.map(s => ({ action: s.action, riskLevel: s.riskLevel })),
    });

    return plan;
  }

  // ── Orchestration & Execution ──

  async execute(plan: ExecutionPlan): Promise<{
    success: boolean;
    results: Array<{ stepId: string; action: string; outcome: string; error?: string }>;
    totalLatencyMs: number;
    tokensUsed: number;
    cost: number;
  }> {
    const startTime = Date.now();
    const results: Array<{ stepId: string; action: string; outcome: string; error?: string }> = [];
    let totalTokens = 0;
    let totalCost = 0;

    // Topological sort: execute steps in dependency order
    const completed = new Set<string>();
    const remaining = [...plan.steps];

    while (remaining.length > 0) {
      // Find steps whose dependencies are all completed
      const ready = remaining.filter(s =>
        s.dependencies.length === 0 ||
        (s.dependencies.every(d => completed.has(d)) && s.status === 'pending')
      );

      if (ready.length === 0) {
        // Circular dependency or all blocked — execute next pending
        const next = remaining.find(s => s.status === 'pending');
        if (!next) break;
        ready.push(next);
      }

      // Execute ready steps in parallel (limit to 3 concurrent)
      const batch = ready.slice(0, 3);

      const batchResults = await Promise.all(
        batch.map(async step => {
          step.status = 'running';
          step.startTime = Date.now();

          this._bus.publish('cog.task.executing', {
            taskId: plan.planId,
            stepId: step.stepId,
            action: step.action,
          });

          try {
            // Execute the action using LLM
            const { response } = await this._providerRegistry.generate(
              {
                messages: [
                  {
                    role: 'system',
                    content: `You are executing a step in a larger plan. Goal: "${plan.goal}". Execute this step and return only the result.`,
                  },
                  { role: 'user', content: step.action },
                ],
                temperature: 0.2,
                maxTokens: 2000,
              },
            );

            step.status = 'completed';
            step.endTime = Date.now();
            step.result = response.content;
            completed.add(step.stepId);
            totalTokens += response.tokensUsed.total;
            totalCost += response.cost;

            this._bus.publish('cog.task.step_completed', {
              taskId: plan.planId,
              stepId: step.stepId,
              outcome: response.content,
              tokensUsed: response.tokensUsed.total,
              latencyMs: response.latencyMs,
            });

            return { stepId: step.stepId, action: step.action, outcome: response.content };
          } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));

            // Retry logic
            if (step.maxRetries > 0 && step.status === 'running') {
              step.status = 'retrying';
              step.maxRetries--;
              // Will be re-picked next iteration
              remaining.push(step);
              return null;
            }

            step.status = 'failed';
            step.error = err.message;
            step.endTime = Date.now();

            this._bus.publish('cog.task.step_completed', {
              taskId: plan.planId,
              stepId: step.stepId,
              outcome: null,
              error: err.message,
            });

            return { stepId: step.stepId, action: step.action, outcome: '', error: err.message };
          }
        }),
      );

      // Filter out nulls (retried steps) and add to results
      for (const r of batchResults) {
        if (r) results.push(r);
      }

      // Remove completed/failed steps from remaining
      for (const step of batch) {
        if (step.status === 'completed' || step.status === 'failed') {
          const idx = remaining.findIndex(s => s.stepId === step.stepId);
          if (idx >= 0) remaining.splice(idx, 1);
        }
      }
    }

    const totalLatencyMs = Date.now() - startTime;
    const allCompleted = results.every(r => !r.error);

    this._bus.publish('cog.task.completed', {
      taskId: plan.planId,
      outcome: allCompleted ? 'success' : 'partial',
      results,
      metrics: {
        totalLatencyMs,
        tokensUsed: totalTokens,
        cost: totalCost,
        stepsCompleted: results.filter(r => !r.error).length,
        stepsFailed: results.filter(r => r.error).length,
      },
    });

    return {
      success: allCompleted,
      results,
      totalLatencyMs,
      tokensUsed: totalTokens,
      cost: totalCost,
    };
  }

  // ── Simulation ──

  async simulate(
    plan: ExecutionPlan,
    scenarios: number = 3,
  ): Promise<{
    successRate: number;
    partialRate: number;
    failureRate: number;
    identifiedRisks: string[];
    recommendation: 'pass' | 'revise' | 'escalate';
    confidence: number;
  }> {
    const riskDescriptions = plan.steps
      .map(s => `- ${s.action} [risk: ${s.riskLevel}]`)
      .join('\n');

    const result = await this.reason(
      `Simulate the execution of this plan across ${scenarios} different scenarios. \n\n` +
      `Goal: ${plan.goal}\nSteps:\n${riskDescriptions}\n\n` +
      `For each scenario, determine:\n` +
      `1. Would the plan succeed, partially succeed, or fail?\n` +
      `2. What risks might materialize?\n` +
      `3. What would be the most likely failure point?\n\n` +
      `At the end, give: success rate (0-100%), partial rate, failure rate, identified risks list, and recommendation (pass/revise/escalate).`,
    );

    // Parse simulation results
    const successRate = this._extractPercentage(result.answer, 'success') ?? 0.6;
    const failureRate = this._extractPercentage(result.answer, 'failure') ?? 0.2;
    const partialRate = Math.max(0, 1 - successRate - failureRate);

    const risks = this._extractRisks(result.answer);

    let recommendation: 'pass' | 'revise' | 'escalate' = 'pass';
    if (failureRate > 0.4) recommendation = 'escalate';
    else if (failureRate > 0.15 || risks.length > 2) recommendation = 'revise';

    this._bus.publish('cog.simulation.ran', {
      simulationId: uuid(),
      planId: plan.planId,
      scenarios,
      results: { successRate, partialRate, failureRate, risks, recommendation },
    });

    return {
      successRate,
      partialRate,
      failureRate,
      identifiedRisks: risks,
      recommendation,
      confidence: 0.7,
    };
  }

  // ── Model Router Helpers ──

  setRoutingPolicy(policy: RoutingPolicy): void {
    this._defaultPolicy = policy;
  }

  // ── Private ──

  private _parsePlanSteps(text: string): Array<{
    action: string;
    dependencies: string[];
    expectedOutcome: string;
    riskLevel: string;
  }> {
    const steps: Array<{
      action: string;
      dependencies: string[];
      expectedOutcome: string;
      riskLevel: string;
    }> = [];

    // Try numbered steps: "1. ...", "Step 1: ..."
    const numberedRegex = /(?:^|\n)(?:\d+[.)]\s*|Step\s+\d+[:\s-]*)\s*(.+?)(?=\n(?:\d+[.)]|Step\s+\d+)|$)/gs;
    let match;
    while ((match = numberedRegex.exec(text)) !== null) {
      const action = match[1].trim();
      if (action.length > 10) {
        steps.push({
          action: action.substring(0, 200),
          dependencies: [],
          expectedOutcome: 'Step completed successfully',
          riskLevel: action.toLowerCase().includes('risk') ? 'medium' : 'low',
        });
      }
    }

    // Fallback: split by double newlines
    if (steps.length === 0) {
      const paragraphs = text.split('\n\n').filter(p => p.trim().length > 20);
      for (const p of paragraphs.slice(0, 10)) {
        const cleaned = p.replace(/^[#*-]+\s*/, '').trim();
        steps.push({
          action: cleaned.substring(0, 200),
          dependencies: [],
          expectedOutcome: 'Step completed successfully',
          riskLevel: 'low',
        });
      }
    }

    return steps;
  }

  private _extractRiskLevel(text: string): 'low' | 'medium' | 'high' | 'critical' {
    const lower = text.toLowerCase();
    if (lower.includes('critical risk') || lower.includes('risk level: critical')) return 'critical';
    if (lower.includes('high risk') || lower.includes('risk level: high')) return 'high';
    if (lower.includes('medium risk') || lower.includes('risk level: medium')) return 'medium';
    return 'low';
  }

  private _extractPercentage(text: string, type: string): number | null {
    const regex = new RegExp(`${type}[\\s\\w]*?[:\s]+(\\d+(?:\\.\\d+)?)\\s*%?`, 'i');
    const match = text.match(regex);
    if (!match) return null;
    const val = parseFloat(match[1]);
    return val > 1 ? val / 100 : val;
  }

  private _extractRisks(text: string): string[] {
    const risks: string[] = [];
    const riskSection = text.match(/risks?[:\n]([\s\S]*?)(?:\n\n|\n(?=[A-Z][a-z]+:)|$)/i);
    if (riskSection) {
      const lines = riskSection[1].split('\n');
      for (const line of lines) {
        const cleaned = line.replace(/^[#*\-\d.]+\s*/, '').trim();
        if (cleaned.length > 5) risks.push(cleaned.substring(0, 100));
      }
    }
    return risks.slice(0, 5);
  }

  // ── Lifecycle ──

  async healthCheck(): Promise<boolean> {
    // Healthy if we have at least one provider registered
    return this._providerRegistry.listProviders().length > 0;
  }

  stop(): void {
    // No background tasks to clean up (AXIOM is event-driven)
  }

  // ── Event Handlers ──

  private async _onTaskReceived(
    event: { payload: { taskId: string; goal: string; context?: string } },
  ): Promise<void> {
    const { taskId, goal, context } = event.payload;
    try {
      const plan = await this.plan(goal, context ?? '');
      // Plan emitted via bus — EVE will reflect on it
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this._bus.publish('cog.task.failed', {
        taskId,
        error: err.message,
        stepId: null,
      });
    }
  }

  private async _onReflectionCompleted(
    event: { payload: { planId: string; decision: string; critique: string } },
  ): Promise<void> {
    const { planId, decision, critique } = event.payload;

    if (decision === 'veto' || decision === 'escalate') {
      // Do not execute — escalate to operator
      this._bus.publish('cog.task.escalated', {
        planId,
        reason: `EVE ${decision}: ${critique}`,
      });
    } else if (decision === 'revise') {
      // Re-plan with critique
      this._bus.publish('cog.task.revised', {
        planId,
        critique,
      });
    }
    // 'pass' — execution continues
  }
}
