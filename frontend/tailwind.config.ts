import type { Config } from 'tailwindcss';

const config: Config = {
  darkMode: 'class',
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Tema dark "azul petróleo" — derivado da marca Smartspace. Os
        // neutros levam um leve tom teal (verde-azulado) pra casar com o
        // accent petrol; o accent substitui o antigo roxo em toda a UI.
        bg: '#0a0d0f',
        panel: '#111619',
        panel2: '#171d21',
        panel3: '#1d252b',
        border: '#232d33',
        borderStrong: '#33424a',
        muted: '#8a95a0',
        mutedFaint: '#586269',
        text: '#eef2f4',
        accent: '#1497a8',
        accentSoft: '#4fc1d0',
        success: '#2ecc81',
        warn: '#f5a623',
        danger: '#ef5566',
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
        glow: '0 0 0 1px rgba(20,151,168,0.4), 0 0 24px -4px rgba(20,151,168,0.45)',
      },
      borderRadius: {
        xl: '0.875rem',
        '2xl': '1.125rem',
      },
      backgroundImage: {
        'accent-gradient': 'linear-gradient(135deg, #1aa6b8 0%, #0c6373 100%)',
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
