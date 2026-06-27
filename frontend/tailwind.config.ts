import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: 'class',
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        bg: '#0a0b0f',
        panel: '#12141a',
        panel2: '#181b23',
        panel3: '#1e222c',
        border: '#242832',
        borderStrong: '#33394a',
        muted: '#8b92a5',
        mutedFaint: '#5b6275',
        text: '#eef0f5',
        accent: '#7c6cff',
        accentSoft: '#9c8fff',
        success: '#2ecc81',
        warn: '#f5a623',
        danger: '#f0526b',
        info: '#4b9bf5',
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      fontSize: {
        '2xs': ['0.6875rem', { lineHeight: '1rem' }],
      },
      boxShadow: {
        elevate: '0 1px 2px rgba(0,0,0,0.4), 0 8px 24px -8px rgba(0,0,0,0.5)',
        glow: '0 0 0 1px rgba(124,108,255,0.4), 0 0 24px -4px rgba(124,108,255,0.45)',
      },
      borderRadius: {
        xl: '0.875rem',
        '2xl': '1.125rem',
      },
      backgroundImage: {
        'accent-gradient': 'linear-gradient(135deg, #7c6cff 0%, #5b4dd6 100%)',
        sheen: 'linear-gradient(180deg, rgba(255,255,255,0.05), rgba(255,255,255,0))',
      },
      keyframes: {
        fadeIn: { from: { opacity: '0', transform: 'translateY(2px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        pulseSoft: { '0%,100%': { opacity: '1' }, '50%': { opacity: '.55' } },
      },
      animation: {
        fadeIn: 'fadeIn .18s ease-out',
        pulseSoft: 'pulseSoft 2s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
export default config;
