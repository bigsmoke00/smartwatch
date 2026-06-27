'use client';
import { forwardRef, HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** elevated = sombra + leve destaque no hover (uso em cards clicáveis) */
  variant?: 'flat' | 'elevated';
}

// forwardRef pra permitir scrollIntoView/foco em painéis que abrem dentro de
// um Card (ex.: Logs/Inspect do Docker manager) — sem isso, passar `ref` num
// componente função simples falha silenciosamente (ref fica null).
export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { className, variant = 'flat', ...props },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(
        'relative bg-panel border border-border rounded-xl shadow-elevate',
        'before:absolute before:inset-0 before:rounded-xl before:bg-sheen before:opacity-[0.4] before:pointer-events-none',
        variant === 'elevated' && 'transition-colors hover:border-borderStrong',
        className,
      )}
      {...props}
    />
  );
});
