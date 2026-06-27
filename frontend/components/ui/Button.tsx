'use client';
import { ButtonHTMLAttributes, forwardRef } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'outline';
type Size = 'sm' | 'md' | 'lg' | 'icon';

const variants: Record<Variant, string> = {
  primary:
    'bg-accent-gradient text-white border-transparent shadow-[0_1px_0_0_rgba(255,255,255,0.15)_inset] hover:brightness-110 active:brightness-95',
  secondary:
    'bg-panel2 hover:bg-panel3 border border-border text-text',
  outline:
    'bg-transparent border border-border hover:border-borderStrong hover:bg-panel2 text-text',
  ghost: 'bg-transparent hover:bg-panel2 text-text border-transparent',
  danger: 'bg-danger hover:bg-danger/90 text-white border-transparent',
};

const sizes: Record<Size, string> = {
  sm: 'px-2.5 py-1.5 text-xs rounded-md gap-1.5',
  md: 'px-3.5 py-2 text-sm rounded-lg gap-2',
  lg: 'px-4 py-2.5 text-sm rounded-lg gap-2',
  icon: 'p-2 rounded-lg',
};

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, Props>(
  ({ className, variant = 'primary', size = 'md', loading, disabled, children, ...props }, ref) => (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center font-medium transition-all duration-150 disabled:opacity-50 disabled:cursor-not-allowed border select-none active:scale-[0.98]',
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    >
      {loading && <Loader2 size={14} className="animate-spin" />}
      {children}
    </button>
  ),
);
Button.displayName = 'Button';
