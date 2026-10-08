import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import Script from 'next/script';
import './globals.css';

const sans = Inter({ subsets: ['latin'], variable: '--font-sans', display: 'swap' });
const mono = JetBrains_Mono({ subsets: ['latin'], variable: '--font-mono', display: 'swap' });

export const metadata: Metadata = {
  title: 'SmartGard',
  description: 'Plataforma de gerenciamento e visualização de logs',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="pt-BR" className={`dark ${sans.variable} ${mono.variable}`}>
      <head>
        {/* Configuração de execução (API/WebSocket) lida das variáveis do CONTAINER, não do build.
            beforeInteractive: o Next garante que roda ANTES de qualquer código do app e da
            hidratação (um <script> comum ficava atrás dos chunks async). Ver lib/runtime-config.ts. */}
        <Script src="/runtime-config.js" strategy="beforeInteractive" />
      </head>
      <body className="min-h-screen bg-bg text-text font-sans antialiased">{children}</body>
    </html>
  );
}
