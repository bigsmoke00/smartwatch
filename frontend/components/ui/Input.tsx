'use client';
import { InputHTMLAttributes, forwardRef } from 'react';
import { cn } from '@/lib/utils';

interface Props extends InputHTMLAttributes<HTMLInputElement> {
  error?: boolean;
}

export const Input = forwardRef<HTMLInputElement, Props>(
  ({ className, error, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'w-full rounded-lg bg-panel2 border border-border px-3 py-2 text-sm text-text placeholder:text-mutedFaint',
        'transition-colors focus:outline-none focus:ring-2 focus:ring-accent/35 focus:border-accent/60',
        'disabled:opacity-50 disabled:cursor-not-allowed',
        error && 'border-danger/60 focus:ring-danger/30 focus:border-danger/60',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';
