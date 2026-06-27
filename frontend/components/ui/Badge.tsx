'use client';
import { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

type Tone = 'default' | 'accent' | 'success' | 'warn' | 'danger' | 'info';

const tones: Record<Tone, string> = {
  default: 'border-border bg-panel2 text-muted',
  accent: 'border-accent/40 bg-accent/10 text-accentSoft',
  success: 'border-success/40 bg-success/10 text-success',
  warn: 'border-warn/40 bg-warn/10 text-warn',
  danger: 'border-danger/40 bg-danger/10 text-danger',
  info: 'border-info/40 bg-info/10 text-info',
};

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
  dot?: boolean;
}

export function Badge({ className, tone = 'default', dot, children, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-2xs font-medium uppercase tracking-wide',
        tones[tone],
        className,
      )}
      {...props}
    >
      {dot && <span className="w-1.5 h-1.5 rounded-full bg-current shrink-0" />}
      {children}
    </span>
  );
}
