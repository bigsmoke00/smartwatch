'use client';
import { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export function Badge({
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md border border-border bg-panel2 px-2 py-0.5 text-xs uppercase tracking-wide',
        className,
      )}
      {...props}
    />
  );
}
