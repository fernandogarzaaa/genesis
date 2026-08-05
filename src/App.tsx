import { useEffect } from 'react';
import Shell from './components/layout/Shell';
import { useSystemStore, useTaskStore, usePluginStore, useMemoryStore, useProposalStore, useAuditStore } from './stores';
import { kernelClient } from './core/kernel-client';
import StatCard from './components/shared/StatCard';
import GlowText from './components/shared/GlowText';
import Badge from './components/shared/Badge';
import {
  Activity, Cpu, Zap, DollarSign, ListTodo, Lightbulb,
} from 'lucide-react';
import type { Task, Proposal, GenesisEvent } from './core/types';

export default function App() {
  const page = useSystemStore((s) => s.page);
  const system = useSystemStore((s) => s.system);
  const components = useSystemStore((s) => s.components);
  const events = useSystemStore((s) => s.events);
  const tick = useSystemStore((s) => s.tick);
  const tasks = useTaskStore((s) => s.tasks);
  const proposals = useProposalStore((s) => s.proposals);
  const approveProposal = useProposalStore((s) => s.approveProposal);
  const rejectProposal = useProposalStore((s) => s.rejectProposal);

  // Periodic UI refresh
  useEffect(() => {
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [tick]);

  // Submit a task to the kernel for testing
  const handleSubmitTask = () => {
    if (kernelClient.connected) {
      kernelClient.submitTask('Analyze the current system status and report findings', 'System diagnostics');
    }
  };

  return (
    <Shell>
      {page === 'dashboard' && (
        <DashboardView
          system={system}
          components={components}
          events={events}
          tasks={tasks}
          onSubmitTask={handleSubmitTask}
        />
      )}
      {page === 'tasks' && (
        <TasksView tasks={tasks} />
      )}
      {page === 'proposals' && (
        <ProposalsView
          proposals={proposals}
          onApprove={approveProposal}
          onReject={rejectProposal}
        />
      )}
      {page === 'plugins' && <PluginsView />}
      {page === 'memory' && <MemoryView />}
      {page === 'security' && <SecurityView />}
    </Shell>
  );
}

// ── Dashboard View ──

function DashboardView({
  system,
  components,
  events,
  tasks,
  onSubmitTask,
}: {
  system: ReturnType<typeof useSystemStore.getState>['system'];
  components: ReturnType<typeof useSystemStore.getState>['components'];
  events: GenesisEvent[];
  tasks: Task[];
  onSubmitTask: () => void;
}) {
  const activeTasks = tasks.filter(t => t.status !== 'completed' && t.status !== 'failed');
  const recentEvents = events.slice(0, 8);

  return (
    <div className="space-y-6">
      {/* Status Banner */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black font-heading">
            <GlowText variant="primary">COMMAND CENTER</GlowText>
          </h1>
          <p className="text-sm text-muted mt-1">
            Kernel {system.state.toUpperCase()} • Uptime {Math.floor(system.uptime / 3600)}h {Math.floor((system.uptime % 3600) / 60)}m
          </p>
        </div>
        <button
          onClick={onSubmitTask}
          className="px-4 py-2 bg-primary/20 border border-primary/40 rounded text-sm text-primary hover:bg-primary/30 transition-colors cursor-pointer active:scale-[0.97]"
        >
          Submit Task to Kernel →
        </button>
      </div>

      {/* Stat Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          label="Active Tasks"
          value={activeTasks.length}
          icon={<ListTodo className="w-4 h-4" />}
          variant="default"
        />
        <StatCard
          label="Success Rate"
          value={`${(system.successRate * 100).toFixed(1)}%`}
          change={system.successRate > 0.8 ? '+2.1%' : '-1.2%'}
          changePositive={system.successRate > 0.8}
          icon={<Activity className="w-4 h-4" />}
          variant={system.successRate > 0.8 ? 'success' : 'warning'}
        />
        <StatCard
          label="Total Cost"
          value={`$${system.totalCost.toFixed(2)}`}
          icon={<DollarSign className="w-4 h-4" />}
          variant="default"
        />
        <StatCard
          label="Tokens Used"
          value={`${(system.tokensUsed / 1000).toFixed(0)}K`}
          icon={<Zap className="w-4 h-4" />}
          variant="default"
        />
      </div>

      {/* Components Grid */}
      <div>
        <h2 className="text-sm font-heading text-muted uppercase tracking-wider mb-3 flex items-center gap-2">
          <Cpu className="w-3.5 h-3.5" /> System Components
        </h2>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
          {components.map((c) => (
            <div
              key={c.id}
              className="bg-surface border border-border rounded p-3 card-hover-glow cursor-pointer"
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-muted uppercase">{c.name}</span>
                <div
                  className={`w-2 h-2 rounded-full ${
                    c.status === 'running'
                      ? 'bg-success animate-pulse-glow'
                      : c.status === 'degraded'
                        ? 'bg-accent'
                        : c.status === 'fatal'
                          ? 'bg-destructive'
                          : 'bg-muted'
                  }`}
                />
              </div>
              <div className="text-xs text-muted space-y-0.5">
                <div>CPU: {c.cpuPercent.toFixed(0)}%</div>
                <div>MEM: {c.memoryMB.toFixed(0)}MB</div>
                <div>LAT: {c.latencyP50.toFixed(0)}ms</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Recent Events */}
      <div>
        <h2 className="text-sm font-heading text-muted uppercase tracking-wider mb-3 flex items-center gap-2">
          <Activity className="w-3.5 h-3.5" /> Event Stream
        </h2>
        <div className="bg-surface border border-border rounded overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-surface-raised border-b border-border">
              <tr className="text-muted uppercase">
                <th className="text-left p-2 font-normal">Category</th>
                <th className="text-left p-2 font-normal">Type</th>
                <th className="text-left p-2 font-normal">Source</th>
                <th className="text-right p-2 font-normal">Time</th>
              </tr>
            </thead>
            <tbody>
              {recentEvents.map((ev) => (
                <tr key={ev.id} className="border-b border-border/50 hover:bg-surface-raised/50 transition-colors">
                  <td className="p-2">
                    <Badge variant={ev.category === 'system' ? 'default' : ev.category === 'cog' ? 'info' : ev.category === 'perc' ? 'success' : 'warning'}>
                      {ev.category}
                    </Badge>
                  </td>
                  <td className="p-2 font-mono text-[11px] text-foreground/80">{ev.type}</td>
                  <td className="p-2 text-muted">{ev.source}</td>
                  <td className="p-2 text-right text-muted tabular-nums">
                    {new Date(ev.timestamp).toLocaleTimeString()}
                  </td>
                </tr>
              ))}
              {recentEvents.length === 0 && (
                <tr>
                  <td colSpan={4} className="p-6 text-center text-muted">
                    <Activity className="w-4 h-4 mx-auto mb-1 opacity-50" />
                    Waiting for kernel events...
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ── Tasks View ──

function TasksView({ tasks }: { tasks: Task[] }) {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-black font-heading"><GlowText variant="primary">TASKS</GlowText></h1>
      {tasks.length === 0 ? (
        <div className="text-center py-12 text-muted">
          <ListTodo className="w-8 h-8 mx-auto mb-2 opacity-50" />
          <p>No tasks yet. Submit a task from the Command Center to see it here.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {tasks.map((task) => (
            <div key={task.id} className="bg-surface border border-border rounded p-4 card-hover-glow">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-heading text-foreground">{task.title}</h3>
                <Badge variant={
                  task.status === 'completed' ? 'success' :
                  task.status === 'failed' ? 'destructive' :
                  task.status === 'acting' ? 'info' :
                  'warning'
                }>
                  {task.status}
                </Badge>
              </div>
              <p className="text-xs text-muted mb-2">{task.description}</p>
              <div className="flex gap-2 text-xs text-muted">
                <span>Phase: {task.phase}</span>
                <span>•</span>
                <span>Steps: {task.steps.length}</span>
                {task.tokensUsed && <><span>•</span><span>{task.tokensUsed} tokens</span></>}
                {task.cost && <><span>•</span><span>${task.cost.toFixed(3)}</span></>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Proposals View ──

function ProposalsView({
  proposals,
  onApprove,
  onReject,
}: {
  proposals: Proposal[];
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
}) {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-black font-heading"><GlowText variant="primary">PROPOSALS</GlowText></h1>
      {proposals.length === 0 ? (
        <div className="text-center py-12 text-muted">
          <Lightbulb className="w-8 h-8 mx-auto mb-2 opacity-50" />
          <p>No proposals yet. ADAM generates proposals as it learns from task outcomes.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {proposals.map((p) => (
            <div key={p.id} className="bg-surface border border-border rounded p-4 card-hover-glow">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <Lightbulb className="w-4 h-4 text-accent" />
                  <h3 className="text-sm font-heading text-foreground">{p.type.replace(/_/g, ' ')}</h3>
                </div>
                <Badge variant={
                  p.status === 'deployed' ? 'success' :
                  p.status === 'rejected' ? 'destructive' :
                  p.status === 'approved' ? 'info' :
                  p.riskLevel === 'critical' ? 'destructive' :
                  'warning'
                }>
                  {p.status}
                </Badge>
              </div>
              <p className="text-xs text-muted mb-2">{p.description}</p>
              <p className="text-xs text-muted/70 mb-3 italic">"{p.rationale}"</p>
              <div className="flex items-center gap-2 text-xs text-muted mb-3">
                <span>Risk: {p.riskLevel}</span>
                <span>•</span>
                <span>Confidence: {(p.confidence * 100).toFixed(0)}%</span>
              </div>
              {p.status === 'draft' || p.status === 'pending_approval' ? (
                <div className="flex gap-2">
                  <button
                    onClick={() => onApprove(p.id)}
                    className="px-3 py-1 bg-success/20 border border-success/40 rounded text-xs text-success hover:bg-success/30 cursor-pointer transition-colors active:scale-[0.97]"
                  >
                    ✓ Approve
                  </button>
                  <button
                    onClick={() => onReject(p.id)}
                    className="px-3 py-1 bg-destructive/20 border border-destructive/40 rounded text-xs text-destructive hover:bg-destructive/30 cursor-pointer transition-colors active:scale-[0.97]"
                  >
                    ✗ Reject
                  </button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Plugins View ──

function PluginsView() {
  const plugins = usePluginStore((s) => s.plugins);
  const togglePlugin = usePluginStore((s) => s.togglePluginLoad);
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-black font-heading"><GlowText variant="primary">PLUGINS</GlowText></h1>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {plugins.map((p) => (
          <div key={p.id} className="bg-surface border border-border rounded p-4 card-hover-glow">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-sm font-heading text-foreground">{p.name}</h3>
              <Badge variant={p.status === 'running' ? 'success' : p.status === 'quarantined' ? 'destructive' : 'warning'}>
                {p.status}
              </Badge>
            </div>
            <p className="text-xs text-muted mb-3">{p.description}</p>
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted">v{p.version} • {p.publisher} • Tier {p.tier}</span>
              <button
                onClick={() => togglePlugin(p.id)}
                className="px-3 py-1 bg-primary/20 border border-primary/40 rounded text-xs text-primary hover:bg-primary/30 cursor-pointer transition-colors active:scale-[0.97]"
              >
                {p.status === 'running' ? 'Unload' : 'Load'}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Memory View ──

function MemoryView() {
  const memories = useMemoryStore();
  const tab = memories.memoryTab;
  const setTab = memories.setMemoryTab;
  const entries = tab === 'working' ? memories.workingMemories : tab === 'episodic' ? memories.episodicMemories : memories.semanticMemories;

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-black font-heading"><GlowText variant="primary">MEMORY</GlowText></h1>
      <div className="flex gap-2 mb-4">
        {(['working', 'episodic', 'semantic'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-3 py-1.5 rounded text-xs uppercase tracking-wider cursor-pointer transition-colors ${
              tab === t ? 'bg-primary/20 border border-primary/40 text-primary' : 'bg-surface border border-border text-muted hover:text-foreground'
            }`}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="space-y-2">
        {entries.map((entry) => (
          <div key={entry.id} className="bg-surface border border-border rounded p-3 card-hover-glow">
            <p className="text-xs text-foreground">
              {'content' in entry ? entry.content : 'experience' in entry ? entry.experience : entry.fact}
            </p>
            <div className="flex gap-2 mt-1 text-[11px] text-muted">
              {('attentionWeight' in entry && typeof entry.attentionWeight === 'number') && (
                <span>Weight: {entry.attentionWeight.toFixed(2)}</span>
              )}
              {('confidence' in entry && typeof entry.confidence === 'number') && (
                <span>Confidence: {entry.confidence.toFixed(2)}</span>
              )}
              {('outcome' in entry) && (
                <Badge variant={entry.outcome === 'success' ? 'success' : 'destructive'}>{entry.outcome}</Badge>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Security View ──

function SecurityView() {
  const audits = useAuditStore((s) => s.entries);
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-black font-heading"><GlowText variant="primary">SECURITY</GlowText></h1>
      <div className="bg-surface border border-border rounded overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-surface-raised border-b border-border">
            <tr className="text-muted uppercase">
              <th className="text-left p-2 font-normal">Event</th>
              <th className="text-left p-2 font-normal">Severity</th>
              <th className="text-left p-2 font-normal">Source</th>
              <th className="text-right p-2 font-normal">Time</th>
            </tr>
          </thead>
          <tbody>
            {audits.map((a) => (
              <tr key={a.id} className="border-b border-border/50 hover:bg-surface-raised/50">
                <td className="p-2 text-foreground/80">{a.event}</td>
                <td className="p-2">
                  <Badge variant={a.severity === 'critical' ? 'destructive' : a.severity === 'warning' ? 'warning' : 'default'}>
                    {a.severity}
                  </Badge>
                </td>
                <td className="p-2 text-muted">{a.source}</td>
                <td className="p-2 text-right text-muted tabular-nums">
                  {new Date(a.timestamp).toLocaleTimeString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
