import type { PageId } from '../../core/types';
import { useSystemStore } from '../../stores';
import {
  LayoutDashboard, ListTodo, Puzzle, Brain, Shield, Lightbulb,
  Activity, Cpu,
} from 'lucide-react';

const NAV_ITEMS: { id: PageId; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: 'dashboard', label: 'Command Center', icon: LayoutDashboard },
  { id: 'tasks', label: 'Tasks', icon: ListTodo },
  { id: 'plugins', label: 'Plugins', icon: Puzzle },
  { id: 'memory', label: 'Memory', icon: Brain },
  { id: 'security', label: 'Security', icon: Shield },
  { id: 'proposals', label: 'Proposals', icon: Lightbulb },
];

export default function Sidebar() {
  const page = useSystemStore((s) => s.page);
  const setPage = useSystemStore((s) => s.setPage);

  return (
    <aside className="w-56 bg-surface border-r border-border flex flex-col shrink-0">
      {/* Brand */}
      <div className="h-16 flex items-center px-5 border-b border-border">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded bg-primary/20 border border-primary/40 flex items-center justify-center">
            <Cpu className="w-4 h-4 text-primary" />
          </div>
          <span className="font-heading font-black text-lg text-primary glow-primary tracking-wider">
            GENESIS
          </span>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 py-4 px-3 space-y-1 overflow-y-auto">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const active = page === item.id;
          return (
            <button
              key={item.id}
              onClick={() => setPage(item.id)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded text-sm transition-all duration-150 cursor-pointer ${
                active
                  ? 'bg-primary/15 text-primary border border-primary/30'
                  : 'text-muted hover:text-foreground hover:bg-surface-raised border border-transparent'
              }`}
            >
              <Icon className={`w-4 h-4 ${active ? 'text-primary' : ''}`} />
              {item.label}
            </button>
          );
        })}
      </nav>

      {/* Bottom status */}
      <div className="p-4 border-t border-border">
        <div className="flex items-center gap-2 text-xs text-muted">
          <Activity className="w-3 h-3 text-success animate-pulse-glow" />
          <span className="text-success">System Online</span>
        </div>
      </div>
    </aside>
  );
}
