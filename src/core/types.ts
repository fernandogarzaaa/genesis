// ─── Genesis Core Types ───────────────────────────────────────────

// ── Component Identity ──
export type ComponentId = 'kernel' | 'axiom' | 'eve' | 'adam' | string;
export type ComponentStatus = 'running' | 'degraded' | 'stopped' | 'quarantined' | 'fatal';

export interface ComponentHealth {
  id: ComponentId;
  name: string;
  type: 'kernel' | 'cognitive' | 'plugin' | 'provider' | 'tool' | 'storage';
  status: ComponentStatus;
  uptime: number; // seconds
  latencyP50: number; // ms
  errorRate: number; // 0-1
  lastHeartbeat: number; // timestamp
  memoryMB: number;
  cpuPercent: number;
}

// ── Events ──
export type EventCategory = 'cog' | 'perc' | 'learn' | 'human' | 'system' | 'security';

export interface GenesisEvent {
  id: string;
  stream: string;
  category: EventCategory;
  type: string;
  timestamp: number;
  sequence: number;
  payload: Record<string, unknown>;
  source: ComponentId;
}

// ── Tasks ──
export type TaskStatus = 'pending' | 'observing' | 'orienting' | 'deciding' | 'reflecting' | 'simulating' | 'acting' | 'completed' | 'failed' | 'escalated';
export type TaskPriority = 'low' | 'medium' | 'high' | 'critical';

export interface TaskStep {
  id: string;
  action: string;
  capability: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  dependencies: string[];
  startTime?: number;
  endTime?: number;
  result?: string;
  error?: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  phase: 'observe' | 'orient' | 'decide' | 'reflect' | 'simulate' | 'act' | 'learn';
  source: string; // user message, system event, etc.
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  steps: TaskStep[];
  plan?: ExecutionPlan;
  reflection?: ReflectionResult;
  simulation?: SimulationResult;
  result?: string;
  modelUsed?: string;
  tokensUsed?: number;
  cost?: number;
  confidenceScore?: number;
  assignedTo: ComponentId; // which AXIOM worker
}

export interface ExecutionPlan {
  strategy: string;
  steps: TaskStep[];
  estimatedTokens: number;
  estimatedCost: number;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  fallbackStrategy?: string;
}

export interface ReflectionResult {
  decision: 'pass' | 'revise' | 'escalate';
  critique: string;
  riskEstimate: number; // 0-1
  similarPastOutcomes: number; // count
  confidenceCalibration: number; // 0-1
}

export interface SimulationResult {
  singleResult?: {
    success: boolean;
    metrics: Record<string, number>;
  };
  monteCarloResults?: {
    successRate: number;
    partialRate: number;
    failureRate: number;
    identifiedRisks: string[];
  };
  recommendation: 'pass' | 'revise' | 'escalate';
  confidence: number;
}

// ── Plugins ──
export type PluginTier = 1 | 2 | 3;
export type PluginStatus = 'installed' | 'loaded' | 'running' | 'unloaded' | 'quarantined' | 'uninstalled';
export type PluginType = 'model_provider' | 'tool_provider' | 'validator' | 'storage_backend' | 'perception' | 'attention' | 'auth' | 'middleware' | 'workflow_pack' | 'skill_pack' | 'knowledge_pack';

export interface PluginPermission {
  capabilities: string[];
  network: {
    outbound: string[];
    inbound: boolean;
    dns: boolean;
  };
  filesystem: {
    read: string[];
    write: string[];
  };
  resources: {
    maxMemoryMB: number;
    maxCpuPercent: number;
    maxDiskMB: number;
    maxNetworkMbps: number;
    maxExecutionTimeMs: number;
  };
}

export interface Plugin {
  id: string;
  name: string;
  version: string;
  publisher: string;
  tier: PluginTier;
  type: PluginType;
  description: string;
  status: PluginStatus;
  provides: string[]; // capability IDs
  depends: string[]; // capability IDs it requires
  permissions: PluginPermission;
  installedAt: number;
  loadedAt?: number;
  crashCount: number;
  health: ComponentHealth;
  signature?: string;
  verified: boolean;
  marketplaceRating?: number;
  marketplaceInstalls?: number;
}

// ── Memory ──
export type MemoryType = 'working' | 'episodic' | 'semantic';

export interface WorkingMemoryEntry {
  id: string;
  content: string;
  attentionWeight: number; // 0-1, how relevant right now
  createdAt: number;
  expiresAt: number;
  source: string;
  tags: string[];
}

export interface EpisodicMemoryEntry {
  id: string;
  experience: string;
  taskId?: string;
  outcome: 'success' | 'partial' | 'failure';
  context: Record<string, unknown>;
  timestamp: number;
  embedding?: number[];
  contributedToSemantic: boolean;
}

export interface SemanticMemoryEntry {
  id: string;
  fact: string;
  confidence: number; // 0-1
  derivedFrom: string[]; // episodic memory IDs
  category: string;
  createdAt: number;
  updatedAt: number;
  embedding?: number[];
  validated: boolean;
}

// ── Proposals (ADAM) ──
export type ProposalType = 'routing_rule_change' | 'prompt_optimization' | 'threshold_adjustment' | 'strategy_change' | 'skill_creation' | 'validation_rule';
export type ProposalRisk = 'low' | 'medium' | 'high' | 'critical';
export type ProposalStatus = 'draft' | 'sandbox_testing' | 'replay_testing' | 'risk_evaluation' | 'pending_approval' | 'approved' | 'rejected' | 'canary' | 'partial_rollout' | 'deployed' | 'rolled_back';

export interface Proposal {
  id: string;
  type: ProposalType;
  riskLevel: ProposalRisk;
  status: ProposalStatus;
  description: string;
  rationale: string;
  evidence: string[]; // event references
  change: Record<string, unknown>;
  rollback: Record<string, unknown>;
  createdBy: string; // ADAM subsystem
  createdAt: number;
  confidence: number; // 0-1
  estimatedImpact: {
    metric: string;
    currentValue: number;
    predictedValue: number;
    confidence: number;
  };
  sandboxResults?: {
    scenarios: number;
    successRate: number;
    avgLatencyMs: number;
  };
  replayResults?: {
    tasksReplayed: number;
    baselineSuccessRate: number;
    proposedSuccessRate: number;
    statisticalSignificance: number; // p-value
    verdict: string;
  };
  riskEvaluation?: {
    score: number;
    requiredApproval: 'auto' | 'axiom' | 'human' | 'multi_human';
  };
  approvalBy?: string;
  deploymentPhase?: 'canary' | 'partial' | 'full';
  deploymentProgress?: number; // 0-100
  rolledBackAt?: number;
  rollbackReason?: string;
}

// ── Audit ──
export type AuditSeverity = 'info' | 'warning' | 'critical';

export interface AuditEntry {
  id: string;
  event: string;
  severity: AuditSeverity;
  timestamp: number;
  source: ComponentId;
  details: string;
}

// ── Model Providers ──
export interface ModelProvider {
  id: string;
  name: string;
  type: string;
  models: string[];
  status: 'connected' | 'degraded' | 'disconnected';
  latencyP50: number;
  errorRate: number;
  tokensUsed: number;
  costTotal: number;
  capabilities: string[];
}

// ── System State ──
export type SystemState = 'booting' | 'running' | 'degraded' | 'maintenance' | 'emergency' | 'shutdown';

export interface SystemMetrics {
  state: SystemState;
  uptime: number;
  totalTasks: number;
  activeTasks: number;
  completedTasks: number;
  failedTasks: number;
  tokensUsed: number;
  totalCost: number;
  successRate: number; // 0-1
  avgLatencyMs: number;
  pluginsInstalled: number;
  pluginsLoaded: number;
  eventBacklog: number;
  memoryUsageMB: number;
}

// ── Navigation ──
export type PageId = 'dashboard' | 'tasks' | 'plugins' | 'memory' | 'security' | 'proposals';
