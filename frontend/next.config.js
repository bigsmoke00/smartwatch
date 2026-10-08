const { version } = require('./package.json');

/** @type {import('next').NextConfig} */
module.exports = {
  reactStrictMode: true,
  output: 'standalone',
  // instrumentation.ts: registra no log do container para onde o frontend aponta.
  experimental: { instrumentationHook: true },
  // Versão exibida no rodapé do menu (AppShell) — lida do package.json em
  // build-time, fonte única (mesmo valor do /health do backend e do
  // agentVersion do agent, desde que os 3 package.json sejam bumpados juntos).
  env: {
    NEXT_PUBLIC_APP_VERSION: version,
  },
};
