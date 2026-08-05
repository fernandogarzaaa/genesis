import type {
  SystemMetrics, ComponentHealth, Task, GenesisEvent, Plugin,
  EpisodicMemoryEntry, SemanticMemoryEntry, WorkingMemoryEntry,
  Proposal, AuditEntry, ModelProvider,
} from './types';

// ─── System Components ───────────────────────────────────────────

export const COMPONENTS: ComponentHealth[] = [
  { id: 'kernel', name: 'Kernel', type: 'kernel', status: 'running', uptime: 360000, latencyP50: 0.5, errorRate: 0, lastHeartbeat: Date.now(), memoryMB: 128, cpuPercent: 5 },
  { id: 'axiom-1', name: 'AXIOM Worker 1', type: 'cognitive', status: 'running', uptime: 360000, latencyP50: 45, errorRate: 0.002, lastHeartbeat: Date.now(), memoryMB: 512, cpuPercent: 28 },
  { id: 'axiom-2', name: 'AXIOM Worker 2', type: 'cognitive', status: 'running', uptime: 360000, latencyP50: 52, errorRate: 0.003, lastHeartbeat: Date.now(), memoryMB: 480, cpuPercent: 22 },
  { id: 'axiom-3', name: 'AXIOM Worker 3', type: 'cognitive', status: 'running', uptime: 360000, latencyP50: 38, errorRate: 0.001, lastHeartbeat: Date.now(), memoryMB: 445, cpuPercent: 15 },
  { id: 'eve-observer', name: 'EVE Observer', type: 'cognitive', status: 'running', uptime: 360000, latencyP50: 12, errorRate: 0, lastHeartbeat: Date.now(), memoryMB: 256, cpuPercent: 18 },
  { id: 'eve-reflector', name: 'EVE Reflector', type: 'cognitive', status: 'running', uptime: 360000, latencyP50: 28, errorRate: 0.001, lastHeartbeat: Date.now(), memoryMB: 312, cpuPercent: 22 },
  { id: 'adam-experience', name: 'ADAM Experience Learner', type: 'cognitive', status: 'running', uptime: 360000, latencyP50: 500, errorRate: 0.005, lastHeartbeat: Date.now(), memoryMB: 640, cpuPercent: 12 },
  { id: 'adam-meta', name: 'ADAM Meta Learner', type: 'cognitive', status: 'running', uptime: 360000, latencyP50: 3000, errorRate: 0.01, lastHeartbeat: Date.now(), memoryMB: 890, cpuPercent: 8 },
  { id: 'event-bus', name: 'Event Bus', type: 'kernel', status: 'running', uptime: 360000, latencyP50: 0.2, errorRate: 0, lastHeartbeat: Date.now(), memoryMB: 64, cpuPercent: 3 },
  { id: 'plugin-host', name: 'Plugin Host', type: 'kernel', status: 'running', uptime: 360000, latencyP50: 2, errorRate: 0, lastHeartbeat: Date.now(), memoryMB: 192, cpuPercent: 6 },
];

// ─── System Metrics ──────────────────────────────────────────────

export const SYSTEM_METRICS: SystemMetrics = {
  state: 'running',
  uptime: 360000,
  totalTasks: 12487,
  activeTasks: 8,
  completedTasks: 12341,
  failedTasks: 138,
  tokensUsed: 48210500,
  totalCost: 147.32,
  successRate: 0.9889,
  avgLatencyMs: 1240,
  pluginsInstalled: 23,
  pluginsLoaded: 18,
  eventBacklog: 0,
  memoryUsageMB: 3456,
};

// ─── Model Providers ─────────────────────────────────────────────

export const MODEL_PROVIDERS: ModelProvider[] = [
  { id: 'openai', name: 'OpenAI', type: 'text_generation', models: ['gpt-4o', 'gpt-4o-mini', 'o3-mini'], status: 'connected', latencyP50: 820, errorRate: 0.001, tokensUsed: 28500000, costTotal: 91.20, capabilities: ['infra.text_generation', 'infra.embedding'] },
  { id: 'anthropic', name: 'Anthropic', type: 'text_generation', models: ['claude-3.5-sonnet', 'claude-3-opus', 'claude-3-haiku'], status: 'connected', latencyP50: 650, errorRate: 0.0005, tokensUsed: 16200000, costTotal: 48.60, capabilities: ['infra.text_generation'] },
  { id: 'google', name: 'Google AI', type: 'text_generation', models: ['gemini-2.0-flash', 'gemini-1.5-pro'], status: 'degraded', latencyP50: 2400, errorRate: 0.03, tokensUsed: 3500000, costTotal: 7.52, capabilities: ['infra.text_generation', 'infra.embedding'] },
  { id: 'lancedb', name: 'LanceDB', type: 'storage', models: [], status: 'connected', latencyP50: 5, errorRate: 0, tokensUsed: 0, costTotal: 0, capabilities: ['infra.storage.vector'] },
  { id: 'sqlite', name: 'SQLite (Local)', type: 'storage', models: [], status: 'connected', latencyP50: 1, errorRate: 0, tokensUsed: 0, costTotal: 0, capabilities: ['infra.storage.event', 'infra.storage.state'] },
];

// ─── Recent Events ────────────────────────────────────────────────

export const RECENT_EVENTS: GenesisEvent[] = Array.from({ length: 20 }, (_, i) => ({
  id: `evt-${Date.now() - i * 5000}`,
  stream: ['cog.task', 'perc.validation', 'learn.proposal', 'system.plugin', 'security.audit'][i % 5],
  category: (['cog', 'perc', 'learn', 'system', 'security'] as const)[i % 5],
  type: ['completed', 'passed', 'created', 'loaded', 'logged'][i % 5],
  timestamp: Date.now() - i * 5000,
  sequence: 12487 - i,
  payload: { task_id: `task-${12487 - i}` },
  source: ['axiom-1', 'eve-reflector', 'adam-experience', 'plugin-host', 'kernel'][i % 5],
}));

// ─── Mock Tasks ───────────────────────────────────────────────────

export function createMockTasks(): Task[] {
  const now = Date.now();
  return [
    {
      id: 'task-12487', title: 'Analyze quarterly financial data', description: 'Process Q3 financial spreadsheets and generate summary report with key insights', status: 'acting', priority: 'high', phase: 'act', source: 'user:dashboard', createdAt: now - 120000, startedAt: now - 110000,
      steps: [
        { id: 's1', action: 'Parse Excel files', capability: 'tool.file_parse', status: 'completed', dependencies: [], startTime: now - 110000, endTime: now - 90000, result: '3 files parsed' },
        { id: 's2', action: 'Extract financial metrics', capability: 'cog.analyze', status: 'completed', dependencies: ['s1'], startTime: now - 90000, endTime: now - 60000 },
        { id: 's3', action: 'Generate summary', capability: 'infra.text_generation', status: 'running', dependencies: ['s2'], startTime: now - 60000 },
        { id: 's4', action: 'Create visualization data', capability: 'tool.chart_generate', status: 'pending', dependencies: ['s3'] },
      ],
      plan: { strategy: 'hierarchical_decomposition', steps: [], estimatedTokens: 4500, estimatedCost: 0.015, riskLevel: 'low', fallbackStrategy: 'direct_llm' },
      assignedTo: 'axiom-1', modelUsed: 'gpt-4o', tokensUsed: 3200, cost: 0.011, confidenceScore: 0.92,
    },
    {
      id: 'task-12486', title: 'Code review: PR #2847', description: 'Review pull request for authentication module refactoring', status: 'reflecting', priority: 'medium', phase: 'reflect', source: 'webhook:github', createdAt: now - 180000, startedAt: now - 170000,
      steps: [
        { id: 's1', action: 'Fetch PR diff', capability: 'tool.github_api', status: 'completed', dependencies: [], startTime: now - 170000, endTime: now - 165000 },
        { id: 's2', action: 'Analyze code changes', capability: 'cog.analyze', status: 'completed', dependencies: ['s1'], startTime: now - 165000, endTime: now - 140000 },
        { id: 's3', action: 'Generate review comments', capability: 'infra.text_generation', status: 'completed', dependencies: ['s2'], startTime: now - 140000, endTime: now - 100000 },
      ],
      plan: { strategy: 'forward_chain', steps: [], estimatedTokens: 2800, estimatedCost: 0.008, riskLevel: 'low' },
      reflection: { decision: 'pass', critique: 'Review is thorough. All security concerns addressed. Code style consistent.', riskEstimate: 0.1, similarPastOutcomes: 45, confidenceCalibration: 0.95 },
      assignedTo: 'axiom-2', modelUsed: 'claude-3.5-sonnet', tokensUsed: 2800, cost: 0.008, confidenceScore: 0.88,
    },
    {
      id: 'task-12485', title: 'Schedule team standup', description: 'Check calendars and find optimal time for daily standup', status: 'completed', priority: 'low', phase: 'act', source: 'user:slack', createdAt: now - 600000, startedAt: now - 590000, completedAt: now - 540000,
      steps: [
        { id: 's1', action: 'Query calendars', capability: 'tool.calendar_api', status: 'completed', dependencies: [], startTime: now - 590000, endTime: now - 580000 },
        { id: 's2', action: 'Find optimal slot', capability: 'cog.plan', status: 'completed', dependencies: ['s1'], startTime: now - 580000, endTime: now - 560000 },
        { id: 's3', action: 'Send invites', capability: 'tool.calendar_api', status: 'completed', dependencies: ['s2'], startTime: now - 560000, endTime: now - 540000 },
      ],
      result: 'Standup scheduled for 10:15 AM. All 8 team members available.',
      assignedTo: 'axiom-3', modelUsed: 'claude-3-haiku', tokensUsed: 800, cost: 0.001, confidenceScore: 0.98,
    },
    {
      id: 'task-12484', title: 'Monitor production alerts', description: 'Check for any production alerts and triage', status: 'failed', priority: 'critical', phase: 'act', source: 'system:scheduler', createdAt: now - 900000, startedAt: now - 890000, completedAt: now - 600000,
      steps: [
        { id: 's1', action: 'Query monitoring system', capability: 'tool.monitor_api', status: 'completed', dependencies: [], startTime: now - 890000, endTime: now - 880000 },
        { id: 's2', action: 'Analyze alerts', capability: 'cog.analyze', status: 'failed', dependencies: ['s1'], startTime: now - 880000, endTime: now - 600000, error: 'Monitoring API returned 503 after 3 retries' },
      ],
      result: 'Failed: unable to reach monitoring API. Escalated to on-call engineer.',
      assignedTo: 'axiom-1', confidenceScore: 0.5,
    },
    {
      id: 'task-12483', title: 'Draft weekly newsletter', description: 'Compose weekly engineering newsletter from commit logs', status: 'completed', priority: 'medium', phase: 'act', source: 'system:scheduler', createdAt: now - 1800000, startedAt: now - 1790000, completedAt: now - 1500000,
      steps: [
        { id: 's1', action: 'Fetch commit logs', capability: 'tool.git_api', status: 'completed', dependencies: [] },
        { id: 's2', action: 'Summarize changes', capability: 'infra.text_generation', status: 'completed', dependencies: ['s1'] },
        { id: 's3', action: 'Format newsletter', capability: 'infra.text_generation', status: 'completed', dependencies: ['s2'] },
      ],
      result: 'Newsletter drafted with 5 sections. Ready for review.',
      assignedTo: 'axiom-2', modelUsed: 'claude-3.5-sonnet', tokensUsed: 3500, cost: 0.011, confidenceScore: 0.95,
    },
  ];
}

// ─── Mock Plugins ─────────────────────────────────────────────────

export function createMockPlugins(): Plugin[] {
  const now = Date.now();
  return [
    { id: 'plg-openai', name: 'OpenAI Provider', version: '2.1.0', publisher: 'genesis-core', tier: 2, type: 'model_provider', description: 'Official OpenAI integration for GPT-4o, GPT-4o-mini, and o3-mini', status: 'running', provides: ['infra.text_generation', 'infra.embedding'], depends: [], permissions: { capabilities: [], network: { outbound: ['api.openai.com:443'], inbound: false, dns: true }, filesystem: { read: [], write: [] }, resources: { maxMemoryMB: 256, maxCpuPercent: 20, maxDiskMB: 100, maxNetworkMbps: 100, maxExecutionTimeMs: 60000 } }, installedAt: now - 86400000, loadedAt: now - 86400000, crashCount: 0, health: COMPONENTS[0], verified: true, marketplaceRating: 4.9, marketplaceInstalls: 125000 },
    { id: 'plg-anthropic', name: 'Anthropic Provider', version: '1.8.2', publisher: 'genesis-core', tier: 2, type: 'model_provider', description: 'Official Anthropic integration for Claude models', status: 'running', provides: ['infra.text_generation'], depends: [], permissions: { capabilities: [], network: { outbound: ['api.anthropic.com:443'], inbound: false, dns: true }, filesystem: { read: [], write: [] }, resources: { maxMemoryMB: 256, maxCpuPercent: 20, maxDiskMB: 100, maxNetworkMbps: 100, maxExecutionTimeMs: 60000 } }, installedAt: now - 86400000, loadedAt: now - 86400000, crashCount: 0, health: COMPONENTS[1], verified: true, marketplaceRating: 4.8, marketplaceInstalls: 98000 },
    { id: 'plg-validator-facts', name: 'Fact Checker', version: '1.3.0', publisher: 'genesis-community', tier: 3, type: 'validator', description: 'Cross-references model outputs against trusted sources', status: 'running', provides: ['perc.validation.factual'], depends: ['infra.text_generation', 'infra.storage.vector'], permissions: { capabilities: ['infra.text_generation', 'infra.storage.vector'], network: { outbound: ['api.openai.com:443'], inbound: false, dns: true }, filesystem: { read: [], write: ['~/.genesis/plugins/fact-checker/cache/'] }, resources: { maxMemoryMB: 256, maxCpuPercent: 30, maxDiskMB: 512, maxNetworkMbps: 10, maxExecutionTimeMs: 30000 } }, installedAt: now - 43200000, loadedAt: now - 43200000, crashCount: 0, health: COMPONENTS[0], verified: false, marketplaceRating: 4.5, marketplaceInstalls: 3400 },
    { id: 'plg-tool-github', name: 'GitHub Tools', version: '2.0.1', publisher: 'genesis-community', tier: 3, type: 'tool_provider', description: 'GitHub API integration for PRs, issues, and code review', status: 'running', provides: ['tool.github_api', 'tool.git_api'], depends: [], permissions: { capabilities: [], network: { outbound: ['api.github.com:443'], inbound: false, dns: true }, filesystem: { read: [], write: [] }, resources: { maxMemoryMB: 128, maxCpuPercent: 15, maxDiskMB: 50, maxNetworkMbps: 20, maxExecutionTimeMs: 30000 } }, installedAt: now - 86400000, loadedAt: now - 86400000, crashCount: 1, health: COMPONENTS[0], verified: true, marketplaceRating: 4.7, marketplaceInstalls: 12000 },
    { id: 'plg-middleware-cache', name: 'Response Cache', version: '1.0.0', publisher: 'genesis-community', tier: 3, type: 'middleware', description: 'Caches model responses to reduce cost and latency for repeated queries', status: 'running', provides: ['infra.text_generation'], depends: [], permissions: { capabilities: [], network: { outbound: [], inbound: false, dns: false }, filesystem: { read: [], write: ['~/.genesis/plugins/cache/'] }, resources: { maxMemoryMB: 512, maxCpuPercent: 10, maxDiskMB: 1024, maxNetworkMbps: 0, maxExecutionTimeMs: 5000 } }, installedAt: now - 172800000, loadedAt: now - 172800000, crashCount: 0, health: COMPONENTS[0], verified: false, marketplaceRating: 4.3, marketplaceInstalls: 2800 },
    { id: 'plg-storage-pg', name: 'PostgreSQL Backend', version: '3.2.0', publisher: 'genesis-core', tier: 2, type: 'storage_backend', description: 'Production PostgreSQL storage backend for state and events', status: 'loaded', provides: ['infra.storage.event', 'infra.storage.state'], depends: [], permissions: { capabilities: [], network: { outbound: ['localhost:5432'], inbound: false, dns: false }, filesystem: { read: [], write: [] }, resources: { maxMemoryMB: 1024, maxCpuPercent: 40, maxDiskMB: 0, maxNetworkMbps: 1000, maxExecutionTimeMs: 30000 } }, installedAt: now - 86400000, loadedAt: now - 86400000, crashCount: 0, health: COMPONENTS[0], verified: true, marketplaceRating: 4.6, marketplaceInstalls: 8500 },
    { id: 'plg-perception-img', name: 'Image Perception', version: '1.1.0', publisher: 'genesis-community', tier: 3, type: 'perception', description: 'Image analysis and OCR capabilities for EVE', status: 'loaded', provides: ['perc.observation.image'], depends: ['infra.text_generation'], permissions: { capabilities: ['infra.text_generation'], network: { outbound: [], inbound: false, dns: false }, filesystem: { read: [], write: ['~/.genesis/plugins/perception-img/temp/'] }, resources: { maxMemoryMB: 512, maxCpuPercent: 35, maxDiskMB: 256, maxNetworkMbps: 0, maxExecutionTimeMs: 45000 } }, installedAt: now - 43200000, loadedAt: now - 43200000, crashCount: 2, health: COMPONENTS[0], verified: false, marketplaceRating: 4.1, marketplaceInstalls: 1800 },
  ];
}

// ─── Mock Memory ──────────────────────────────────────────────────

export function createMockMemories() {
  return {
    workingMemories: [
      { id: 'wm-1', content: 'User requested financial data analysis for Q3', attentionWeight: 0.95, createdAt: Date.now() - 120000, expiresAt: Date.now() + 600000, source: 'task-12487', tags: ['finance', 'analysis', 'active'] },
      { id: 'wm-2', content: 'Code review PR #2847: auth module refactoring', attentionWeight: 0.82, createdAt: Date.now() - 180000, expiresAt: Date.now() + 600000, source: 'task-12486', tags: ['code-review', 'security', 'active'] },
      { id: 'wm-3', content: 'Google AI provider latency spike detected (2400ms p50)', attentionWeight: 0.70, createdAt: Date.now() - 300000, expiresAt: Date.now() + 300000, source: 'eve-observer', tags: ['alert', 'provider', 'latency'] },
      { id: 'wm-4', content: 'Previous financial summaries used template T3 with high satisfaction', attentionWeight: 0.45, createdAt: Date.now() - 600000, expiresAt: Date.now() + 600000, source: 'episodic-recall', tags: ['finance', 'template', 'historical'] },
    ] as WorkingMemoryEntry[],
    episodicMemories: [
      { id: 'ep-1', experience: 'Financial analysis task: parsed 3 large spreadsheets, extracted KPIs, generated summary. User rated 5/5.', taskId: 'task-12300', outcome: 'success', context: { domain: 'finance', complexity: 'high' }, timestamp: Date.now() - 86400000, contributedToSemantic: true },
      { id: 'ep-2', experience: 'Code review for auth module: identified 2 security issues, suggested improvements. PR approved.', taskId: 'task-12250', outcome: 'success', context: { domain: 'code-review', language: 'typescript' }, timestamp: Date.now() - 72000000, contributedToSemantic: true },
      { id: 'ep-3', experience: 'Newsletter generation: gathered commits, summarized. Email bounced due to formatting issue.', taskId: 'task-12200', outcome: 'partial', context: { domain: 'communication', format: 'email' }, timestamp: Date.now() - 172800000, contributedToSemantic: true },
      { id: 'ep-4', experience: 'Attempted to schedule meeting with 15 participants. Calendar query timed out after 30 seconds.', taskId: 'task-12150', outcome: 'failure', context: { domain: 'scheduling', scale: 'large' }, timestamp: Date.now() - 259200000, contributedToSemantic: false },
    ] as EpisodicMemoryEntry[],
    semanticMemories: [
      { id: 'sm-1', fact: 'Q3 financial templates should use T3 format for executive summaries', confidence: 0.94, derivedFrom: ['ep-1', 'ep-5'], category: 'finance', createdAt: Date.now() - 43200000, updatedAt: Date.now() - 8640000, validated: true },
      { id: 'sm-2', fact: 'Auth module changes require security review checklist verification', confidence: 0.97, derivedFrom: ['ep-2'], category: 'code-review', createdAt: Date.now() - 36000000, updatedAt: Date.now() - 7200000, validated: true },
      { id: 'sm-3', fact: 'Newsletter emails should be sent as multipart MIME with plain-text fallback', confidence: 0.88, derivedFrom: ['ep-3'], category: 'communication', createdAt: Date.now() - 144000000, updatedAt: Date.now() - 86400000, validated: true },
      { id: 'sm-4', fact: 'Calendar queries with more than 10 participants should use batch API', confidence: 0.91, derivedFrom: ['ep-4', 'ep-7'], category: 'scheduling', createdAt: Date.now() - 216000000, updatedAt: Date.now() - 172800000, validated: true },
      { id: 'sm-5', fact: 'GPT-4o yields 22% higher satisfaction on financial analysis vs Claude 3.5 Sonnet', confidence: 0.85, derivedFrom: ['ep-1', 'ep-8', 'ep-12'], category: 'routing', createdAt: Date.now() - 8640000, updatedAt: Date.now() - 3600000, validated: false },
    ] as SemanticMemoryEntry[],
  };
}

// ─── Mock Proposals ───────────────────────────────────────────────

export function createMockProposals(): Proposal[] {
  const now = Date.now();
  return [
    {
      id: 'prop-0042', type: 'routing_rule_change', riskLevel: 'low', status: 'deployed', description: 'Route 80% of summarization tasks to GPT-4o-mini instead of GPT-4o', rationale: 'GPT-4o-mini achieves comparable quality on summarization tasks at 1/5 the cost', evidence: ['evt-12000', 'evt-12100'], change: { taskType: 'summarization', model: 'gpt-4o-mini', weight: 0.8 }, rollback: { method: 'config_revert', timeMs: 500 }, createdBy: 'adam-experience', createdAt: now - 86400000, confidence: 0.92, estimatedImpact: { metric: 'cost_per_summarization', currentValue: 0.015, predictedValue: 0.004, confidence: 0.88 },
      sandboxResults: { scenarios: 50, successRate: 0.96, avgLatencyMs: 650 },
      replayResults: { tasksReplayed: 500, baselineSuccessRate: 0.94, proposedSuccessRate: 0.96, statisticalSignificance: 0.003, verdict: 'IMPROVEMENT_CONFIRMED' },
      riskEvaluation: { score: 0.25, requiredApproval: 'auto' },
      approvalBy: 'auto', deploymentPhase: 'full', deploymentProgress: 100,
    },
    {
      id: 'prop-0043', type: 'prompt_optimization', riskLevel: 'medium', status: 'canary', description: 'Add conciseness instruction to system prompt for email composition tasks', rationale: 'Email responses are consistently 40% longer than needed, wasting tokens', evidence: ['evt-12500'], change: { promptId: 'sys_email_v2', change: 'prepend: "Respond concisely. Target 150 words or fewer."' }, rollback: { method: 'config_revert', timeMs: 200 }, createdBy: 'adam-experience', createdAt: now - 3600000, confidence: 0.78, estimatedImpact: { metric: 'tokens_per_email', currentValue: 1200, predictedValue: 700, confidence: 0.75 },
      sandboxResults: { scenarios: 30, successRate: 0.93, avgLatencyMs: 400 },
      replayResults: { tasksReplayed: 200, baselineSuccessRate: 0.95, proposedSuccessRate: 0.93, statisticalSignificance: 0.08, verdict: 'NEUTRAL_WITH_COST_SAVINGS' },
      riskEvaluation: { score: 0.45, requiredApproval: 'axiom' },
      approvalBy: 'axiom-1', deploymentPhase: 'canary', deploymentProgress: 10,
    },
    {
      id: 'prop-0044', type: 'strategy_change', riskLevel: 'high', status: 'pending_approval', description: 'Use tree-of-thought reasoning for complex planning tasks (complexity > 0.7)', rationale: 'Complex multi-step plans have 15% higher failure rate. Tree-of-thought improves plan quality by exploring alternatives.', evidence: ['evt-12800', 'evt-12850'], change: { strategy: 'tree_of_thought', applyTo: { taskComplexity: '> 0.7' } }, rollback: { method: 'config_revert', timeMs: 50000 }, createdBy: 'adam-meta', createdAt: now - 7200000, confidence: 0.72, estimatedImpact: { metric: 'complex_task_success_rate', currentValue: 0.82, predictedValue: 0.91, confidence: 0.65 },
      sandboxResults: { scenarios: 40, successRate: 0.88, avgLatencyMs: 4500 },
      replayResults: { tasksReplayed: 300, baselineSuccessRate: 0.81, proposedSuccessRate: 0.89, statisticalSignificance: 0.01, verdict: 'IMPROVEMENT_CONFIRMED' },
      riskEvaluation: { score: 0.72, requiredApproval: 'human' },
    },
    {
      id: 'prop-0041', type: 'threshold_adjustment', riskLevel: 'medium', status: 'rolled_back', description: 'Lower validation confidence threshold from 0.8 to 0.72', rationale: 'Too many valid outputs are being escalated unnecessarily. 72% threshold would reduce escalations by 30%.', evidence: ['evt-11500'], change: { parameter: 'validation.auto_approve_threshold', old: 0.8, new: 0.72 }, rollback: { method: 'config_revert', timeMs: 500 }, createdBy: 'adam-experience', createdAt: now - 172800000, confidence: 0.65, estimatedImpact: { metric: 'escalation_rate', currentValue: 0.22, predictedValue: 0.15, confidence: 0.7 },
      sandboxResults: { scenarios: 60, successRate: 0.85, avgLatencyMs: 300 },
      replayResults: { tasksReplayed: 400, baselineSuccessRate: 0.96, proposedSuccessRate: 0.91, statisticalSignificance: 0.001, verdict: 'QUALITY_DEGRADATION_DETECTED' },
      riskEvaluation: { score: 0.55, requiredApproval: 'axiom' },
      approvalBy: 'axiom-2', deploymentPhase: 'canary', deploymentProgress: 5, rolledBackAt: now - 86400000, rollbackReason: 'Error rate increased 3x during canary. Auto-rollback triggered.',
    },
  ];
}

// ─── Mock Audit ────────────────────────────────────────────────────

export function createMockAudit(): AuditEntry[] {
  const now = Date.now();
  return [
    { id: 'aud-1', event: 'security.proposal.deployed', severity: 'info', timestamp: now - 86400000, source: 'kernel', details: 'Proposal prop-0042 deployed: routing_rule_change (full rollout)' },
    { id: 'aud-2', event: 'security.sandbox.violation', severity: 'warning', timestamp: now - 72000000, source: 'plugin-host', details: 'Plugin image-perception attempted filesystem access outside sandbox: /etc/passwd (blocked)' },
    { id: 'aud-3', event: 'security.proposal.rolled_back', severity: 'warning', timestamp: now - 86400000, source: 'kernel', details: 'Proposal prop-0041 auto-rollback: error rate exceeded threshold (3x baseline)' },
    { id: 'aud-4', event: 'security.input.flagged', severity: 'warning', timestamp: now - 3600000, source: 'eve-observer', details: 'Prompt injection attempt classified: user attempted to extract system prompt (risk: medium)' },
    { id: 'aud-5', event: 'security.plugin.installed', severity: 'info', timestamp: now - 43200000, source: 'plugin-host', details: 'Plugin image-perception v1.1.0 installed (tier 3, community)' },
    { id: 'aud-6', event: 'security.secret.rotated', severity: 'info', timestamp: now - 21600000, source: 'kernel', details: 'Secret OPENAI_API_KEY rotated by operator' },
    { id: 'aud-7', event: 'security.anomaly.detected', severity: 'critical', timestamp: now - 7200000, source: 'kernel', details: 'Anomaly: Google AI provider latency spike (2400ms p50, 8x normal). Routing traffic away.' },
    { id: 'aud-8', event: 'security.permission.denied', severity: 'info', timestamp: now - 3600000, source: 'plugin-host', details: 'Plugin response-cache attempted network access (denied by manifest)' },
  ];
}
