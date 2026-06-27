'use client';
import { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  /** elevated = sombra + leve destaque no hover (uso em cards clicáveis) */
  variant?: 'flat' | 'elevated';
}

export function Card({ className, variant = 'flat', ...props }: CardProps) {
  return (
    <div
      className={cn(
        'relative bg-panel border border-border rounded-xl shadow-elevate',
        'before:absolute before:inset-0 before:rounded-xl before:bg-sheen before:opacity-[0.4] before:pointer-events-none',
        variant === 'elevated' && 'transition-colors hover:border-borderStrong',
        className,
      )}
      {...props}
    />
  );
}
