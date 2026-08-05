import { useSystemStore } from '../../stores';
import { Activity, Cpu, HardDrive, Zap } from 'lucide-react';

export default function Header() {
  const system = useSystemStore((s) => s.system);
  const components = useSystemStore((s) => s.components);

  const healthyCount = components.filter((c) => c.status === 'running').length;
  const degradedCount = components.filter((c) => c.status === 'degraded').length;

  return (
    <header className="h-16 bg-surface border-b border-border flex items-center justify-between px-6 shrink-0">
      <div className="flex items-center gap-6">
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${system.state === 'running' ? 'bg-success animate-pulse-glow' : system.state === 'degraded' ? 'bg-accent' : 'bg-destructive'}`} />
          <span className="text-xs text-muted uppercase tracking-wider">
            {system.state}
          </span>
        </div>
        <div className="h-4 w-px bg-border" />
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5 text-xs text-muted">
            <Cpu className="w-3.5 h-3.5" />
            <span className="tabular-nums">{healthyCount}</span>
            <span className="text-foreground/50">/</span>
            <span className="tabular-nums">{components.length}</span>
            <span className="hidden sm:inline">components</span>
          </div>
          {degradedCount > 0 && (
            <div className="flex items-center gap-1.5 text-xs text-accent">
              <Activity className="w-3.5 h-3.5" />
              <span className="tabular-nums">{degradedCount} degraded</span>
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-5">
        <div className="flex items-center gap-1.5 text-xs text-muted">
          <HardDrive className="w-3.5 h-3.5" />
          <span className="tabular-nums">{(system.memoryUsageMB / 1024).toFixed(1)} GB</span>
        </div>
        <div className="flex items-center gap-1.5 text-xs text-muted">
          <Zap className="w-3.5 h-3.5" />
          <span className="tabular-nums">{(system.tokensUsed / 1000000).toFixed(1)}M tokens</span>
        </div>
        <div className="text-xs text-muted tabular-nums">
          ${system.totalCost.toFixed(2)}
        </div>
      </div>
    </header>
  );
}
