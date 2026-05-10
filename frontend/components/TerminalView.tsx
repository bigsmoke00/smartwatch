'use client';

import { useEffect, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

interface Props {
  token: string;
  sessionId: string;
  target?: 'host' | 'container';
  containerId?: string;
  readonly?: boolean;
  sudo?: boolean;
}

export default function TerminalView({ token, sessionId, target = 'host', containerId, readonly, sudo }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const socketRef = useRef<Socket | null>(null);

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

    const wsBase = process.env.NEXT_PUBLIC_WS_URL || 'ws://localhost:4000';
    const s = io(`${wsBase}/ws/terminal`, {
      transports: ['websocket'],
      auth: { token, sessionId, target, containerId, readonly, sudo },
    });
    socketRef.current = s;

    s.on('ready', () => term.writeln('\r\n\x1b[32m[connected]\x1b[0m\r\n'));
    s.on('output', (b64: string) => {
      try { term.write(atob(b64)); } catch { /* ignore */ }
    });
    s.on('closed', ({ reason }: { reason: string }) => {
      term.writeln(`\r\n\x1b[33m[session closed: ${reason}]\x1b[0m`);
    });
    s.on('error', (e: any) => {
      term.writeln(`\r\n\x1b[31m[error: ${e?.message || e}]\x1b[0m`);
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
    // resize inicial após connect
    s.on('ready', () => setTimeout(onResize, 100));
    return () => {
      window.removeEventListener('resize', onResize);
      s.disconnect();
      term.dispose();
    };
  }, [token, sessionId, target, containerId, readonly, sudo]);

  return <div ref={ref} className="h-[70vh] rounded border border-border" />;
}
