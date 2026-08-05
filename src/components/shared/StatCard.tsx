import type { ReactNode } from 'react';

interface StatCardProps {
  label: string;
  value: string | number;
  change?: string;
  changePositive?: boolean;
  icon?: ReactNode;
  variant?: 'default' | 'success' | 'warning' | 'destructive';
}

export default function StatCard({ label, value, change, changePositive, icon, variant = 'default' }: StatCardProps) {
  const borderColors: Record<string, string> = {
    default: 'border-l-primary',
    success: 'border-l-success',
    warning: 'border-l-accent',
    destructive: 'border-l-destructive',
  };

  return (
    <div className={`bg-surface border border-border border-l-2 ${borderColors[variant]} rounded p-4 card-hover-glow cursor-pointer`}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-muted uppercase tracking-wider">{label}</span>
        {icon && <span className="text-muted">{icon}</span>}
      </div>
      <div className="text-2xl font-heading font-bold text-foreground tabular-nums">{value}</div>
      {change && (
        <div className={`text-xs mt-1 ${changePositive ? 'text-success' : 'text-destructive'}`}>
          {changePositive ? '▲' : '▼'} {change}
        </div>
      )}
    </div>
  );
}
