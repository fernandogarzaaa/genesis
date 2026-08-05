interface BadgeProps {
  children: string;
  variant?: 'default' | 'success' | 'warning' | 'destructive' | 'info';
  size?: 'sm' | 'md';
}

export default function Badge({ children, variant = 'default', size = 'sm' }: BadgeProps) {
  const variants: Record<string, string> = {
    default: 'bg-border text-muted',
    success: 'bg-success/15 text-success border border-success/30',
    warning: 'bg-accent/15 text-accent border border-accent/30',
    destructive: 'bg-destructive/15 text-destructive border border-destructive/30',
    info: 'bg-primary/15 text-primary border border-primary/30',
  };

  const sizes: Record<string, string> = {
    sm: 'px-1.5 py-0.5 text-[10px]',
    md: 'px-2 py-1 text-xs',
  };

  return (
    <span className={`${variants[variant]} ${sizes[size]} rounded font-medium uppercase tracking-wider inline-flex items-center`}>
      {children}
    </span>
  );
}
