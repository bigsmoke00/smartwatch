'use client';
import { HTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

export function Card({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'bg-panel border border-border rounded-lg shadow-sm',
        className,
      )}
      {...props}
    />
  );
}
