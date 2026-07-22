'use client';
import { ReactNode } from 'react';
import { cn } from '@/lib/utils';

type Tone = 'default' | 'success' | 'warn' | 'danger' | 'accent';

const toneText: Record<Tone, string> = {
  default: 'text-text',
  success: 'text-success',
  warn: 'text-warn',
  danger: 'text-danger',
  accent: 'text-accentSoft',
};

// Faixa de 2px no topo do tile (estilo do mockup) — só aparece quando o tom
// não é o padrão, sinalizando estado (crítico/alerta/ok) sem poluir os
// neutros.
const toneTop: Record<Tone, string> = {
  default: 'border-t-transparent',
  success: 'border-t-success',
  warn: 'border-t-warn',
  danger: 'border-t-danger',
  accent: 'border-t-accent',
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
    <div
      className={cn(
        'relative bg-panel border border-border rounded-xl px-4 py-3.5 border-t-2',
        toneTop[tone],
      )}
    >
      <div className="flex items-center gap-1.5 text-2xs uppercase tracking-wider text-muted font-medium">
        {icon} {label}
      </div>
      <div className={cn('font-mono text-[26px] leading-none font-bold mt-2 tabular tracking-tight', toneText[tone])}>
        {value}
      </div>
      {hint && <div className="text-2xs text-mutedFaint mt-1.5">{hint}</div>}
    </div>
  );
}
