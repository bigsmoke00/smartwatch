'use client';
import { ReactNode } from 'react';
import { Card } from './Card';
import { cn } from '@/lib/utils';

type Tone = 'default' | 'success' | 'warn' | 'danger' | 'accent';

const toneText: Record<Tone, string> = {
  default: 'text-text',
  success: 'text-success',
  warn: 'text-warn',
  danger: 'text-danger',
  accent: 'text-accentSoft',
};

export function StatCard({
  icon,
  label,
  value,
  hint,
  tone = 'default',
}: {
  icon?: ReactNode;
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: Tone;
}) {
  return (
    <Card className="p-3.5">
      <div className="flex items-center gap-1.5 text-2xs uppercase tracking-wide text-muted font-medium">
        {icon} {label}
      </div>
      <div className={cn('text-2xl font-semibold mt-1.5 tabular tracking-tight', toneText[tone])}>
        {value}
      </div>
      {hint && <div className="text-2xs text-mutedFaint mt-0.5">{hint}</div>}
    </Card>
  );
}
