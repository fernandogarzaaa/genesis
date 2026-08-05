import type { ReactNode } from 'react';

interface GlowTextProps {
  children: ReactNode;
  className?: string;
  variant?: 'primary' | 'accent' | 'success' | 'destructive';
}

export default function GlowText({ children, className = '', variant = 'primary' }: GlowTextProps) {
  const glowClass = `glow-${variant}`;
  return (
    <span className={`${glowClass} ${className}`}>
      {children}
    </span>
  );
}
