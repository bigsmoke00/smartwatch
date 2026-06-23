'use client';

import { useEffect, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

interface Props {
  token: string;
  sessionId: string;
  /** Só pra exibir um rótulo enquanto a sessão conecta — o backend decide o resto. */
  target?: 'host' | 'container';
  containerId?: string;
}

interface ReadyInfo {
  targetUser?: string;
  mode?: 'readonly' | 'readwrite';
  sudoGranted?: boolean;
  expiresAt?: string;
}

export default function TerminalView({ token, sessionId, target = 'host', containerId }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const socketRef = useRef<Socket | null>(null);
  const [info, setInfo] = useState<ReadyInfo | null>(null);
  const [remaining, setRemaining] = useState<string>('');

  useEffect(() => {
    if (!ref.current) return;
    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      cursorBlink: true,
      theme: { background: '#0b0d12' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(ref.current);
    fit.fit();
    termRef.current = term;

    // Nota: a sessão sempre conecta só com token+sessionId. target/readonly/
    // sudo/usuário do SO já foram fixados no pedido/aprovação e o backend
    // os resolve a partir do banco — o cliente não tem como mudar isso
    // mandando outro payload aqui (era essa a brecha de escalonamento).
    const wsBase = process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:4000';
    const s = io(`${wsBase}/ws/terminal`, {
      transports: ['websocket'],
      auth: { token, sessionId },
    });
    socketRef.current = s;

    s.on('ready', (data: ReadyInfo) => {
      setInfo(data);
      term.writeln(`\r\n\x1b[32m[conectado como ${data.targetUser ?? '?'} · ${data.mode === 'readonly' ? 'somente leitura' : 'leitura/escrita'}${data.sudoGranted ? ' · sudo' : ''}]\x1b[0m\r\n`);
    });
    s.on('output', (b64: string) => {
      try { term.write(atob(b64)); } catch { /* ignore */ }
    });
    s.on('closed', ({ reason }: { reason: string }) => {
      term.writeln(`\r\n\x1b[33m[sessão encerrada: ${reason}]\x1b[0m`);
    });
    s.on('error', (e: any) => {
      term.writeln(`\r\n\x1b[31m[erro: ${e?.message || e}]\x1b[0m`);
    });

    term.onData((data) => {
      const b64 = btoa(unescape(encodeURIComponent(data)));
      s.emit('input', b64);
    });

    const onResize = () => {
      fit.fit();
      s.emit('resize', { cols: term.cols, rows: term.rows });
    };
    window.addEventListener('resize', onResize);
    s.on('ready', () => setTimeout(onResize, 100));
    return () => {
      window.removeEventListener('resize', onResize);
      s.disconnect();
      term.dispose();
    };
  }, [token, sessionId, target, containerId]);

  // Contagem regressiva até expiresAt — só cosmético no front; o
  // encerramento real é forçado pelo backend (cron de TTL/ociosidade).
  useEffect(() => {
    if (!info?.expiresAt) { setRemaining(''); return; }
    const t = setInterval(() => {
      const ms = new Date(info.expiresAt!).getTime() - Date.now();
      if (ms <= 0) { setRemaining('expirando...'); return; }
      const m = Math.floor(ms / 60000);
      const sec = Math.floor((ms % 60000) / 1000);
      setRemaining(`${m}m ${sec}s`);
    }, 1000);
    return () => clearInterval(t);
  }, [info?.expiresAt]);

  return (
    <div>
      {info && (
        <div className="flex gap-3 text-xs text-muted px-1 pb-1.5">
          <span>usuário: <span className="font-mono">{info.targetUser}</span></span>
          <span>modo: {info.mode === 'readonly' ? 'somente leitura' : 'leitura/escrita'}</span>
          {info.sudoGranted && <span className="text-warn">sudo ativo</span>}
          {remaining && <span>expira em: {remaining}</span>}
        </div>
      )}
      <div ref={ref} className="h-[68vh] rounded border border-border" />
    </div>
  );
}
