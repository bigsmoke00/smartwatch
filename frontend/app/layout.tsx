import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'LogWatch',
  description: 'Plataforma de gerenciamento e visualização de logs',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="pt-BR" className="dark">
      <body className="min-h-screen bg-bg text-text">{children}</body>
    </html>
  );
}
