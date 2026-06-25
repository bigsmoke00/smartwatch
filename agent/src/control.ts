/**
 * Canal de controle agent ↔ backend.
 *
 * O agent abre uma conexão socket.io persistente em /ws/control identificando-se
 * com a API key (handshake.auth.apiKey). O backend valida e mantém um mapa
 * "serverId → socket".
 *
 * Mensagens:
 *   - backend → agent: `docker:invoke` { reqId, op, args }
 *   - agent  → backend: `docker:reply`  { reqId, ok, result?, error? }
 *
 * Operações suportadas:
 *   listContainers, inspectContainer, startContainer, stopContainer,
 *   restartContainer, removeContainer, containerLogs (streaming chunks),
 *   containerExec (streaming I/O via reqId-stream),
 *   listImages, pullImage (stream), removeImage,
 *   listVolumes, createVolume, removeVolume,
 *   createContainer (deploy)
 */
import { io as ioClient, Socket } from 'socket.io-client';
import Docker from 'dockerode';
import { config } from './config.js';
import { listDir, readFile, writeFile, executeScript } from './fs-ops.js';
import { spawnHostShell } from './host-shell.js';
import { runCapture } from './capture.js';

let socket: Socket | null = null;
const activeTermStreams = new Map<string, NodeJS.ReadWriteStream>();

export function startControlChannel(docker: Docker) {
  // baseUrl ex: https://logwatch.example.com/api → ws base sem /api
  const wsBase = config.ingestUrl.replace(/\/api\/.*$/, '').replace(/\/api$/, '');
  socket = ioClient(`${wsBase}/ws/control`, {
    transports: ['websocket'],
    auth: { apiKey: config.apiKey, serverName: config.serverName },
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 30_000,
    randomizationFactor: 0.5,
  });

  socket.on('connect', () => console.log('[agent] control channel connected'));
  socket.on('disconnect', () => console.log('[agent] control channel disconnected'));
  socket.on('connect_error', (e) => console.warn(`[agent] control connect error: ${e.message}`));

  socket.on('docker:invoke', async (msg: { reqId: string; op: string; args: any }) => {
    const reply = (ok: boolean, result?: any, error?: string) =>
      socket!.emit('docker:reply', { reqId: msg.reqId, ok, result, error });

    try {
      const result = await dispatch(docker, msg.op, msg.args, msg.reqId);
      reply(true, result);
    } catch (e: any) {
      reply(false, undefined, e.message || String(e));
    }
  });
}

async function dispatch(docker: Docker, op: string, args: any, reqId: string): Promise<any> {
  switch (op) {
    case 'listContainers':
      return docker.listContainers({ all: true, ...args });

    case 'inspectContainer':
      return docker.getContainer(args.id).inspect();

    case 'startContainer':
      await docker.getContainer(args.id).start();
      return { ok: true };

    case 'stopContainer':
      await docker.getContainer(args.id).stop({ t: args.timeout ?? 10 });
      return { ok: true };

    case 'restartContainer':
      await docker.getContainer(args.id).restart({ t: args.timeout ?? 10 });
      return { ok: true };

    case 'removeContainer':
      await docker.getContainer(args.id).remove({ force: !!args.force, v: !!args.removeVolumes });
      return { ok: true };

    case 'containerLogs': {
      // tail estático
      const logs = await docker.getContainer(args.id).logs({
        stdout: true, stderr: true, tail: args.tail ?? 200, timestamps: true, follow: false,
      });
      return { logs: logs.toString('utf8') };
    }

    case 'containerStats': {
      const stats: any = await docker.getContainer(args.id).stats({ stream: false });
      return summarizeStats(stats);
    }

    case 'listImages':
      return docker.listImages();

    case 'pullImage':
      return new Promise((resolve, reject) => {
        docker.pull(args.image, (err: any, stream: NodeJS.ReadableStream) => {
          if (err) return reject(err);
          docker.modem.followProgress(stream, (e2: any, output: any) => {
            if (e2) return reject(e2);
            resolve({ ok: true, output: output?.slice(-30) });
          }, (event: any) => {
            // Streamar progresso pra UI via canal stream-only
            socket?.emit('docker:stream', { reqId, kind: 'pull-progress', data: event });
          });
        });
      });

    case 'removeImage':
      await docker.getImage(args.id).remove({ force: !!args.force });
      return { ok: true };

    case 'listVolumes': {
      const v = await docker.listVolumes();
      return v.Volumes ?? [];
    }

    case 'createVolume':
      return docker.createVolume({ Name: args.name, Driver: args.driver, Labels: args.labels });

    case 'removeVolume':
      await docker.getVolume(args.name).remove({ force: !!args.force });
      return { ok: true };

    case 'createContainer': {
      // Deploy simples
      const c = await docker.createContainer({
        Image: args.image,
        name: args.name,
        Env: args.env ?? [],
        Cmd: args.cmd ?? undefined,
        HostConfig: {
          PortBindings: args.portBindings ?? {},
          Binds: args.binds ?? [],
          RestartPolicy: { Name: args.restartPolicy ?? 'unless-stopped' },
          NetworkMode: args.network ?? undefined,
        },
        ExposedPorts: args.exposedPorts ?? {},
        Labels: args.labels ?? {},
      });
      if (args.start !== false) await c.start();
      return { id: c.id };
    }

    // ============ FS / Scripts ============
    case 'fs.listDir':
      return listDir(args.path);

    case 'fs.readFile':
      return readFile(args.path);

    case 'fs.writeFile':
      return writeFile(args.path, args.content ?? '');

    case 'fs.execute':
      return executeScript({
        path: args.path,
        args: args.args,
        cwd: args.cwd,
        env: args.env,
        timeoutMs: args.timeoutMs,
      });

    // ============ Terminal exec (Zero Trust) ============
    case 'term.start': {
      const sessionId: string = args.sessionId;
      // ========= MODO HOST =========
      if (args.target === 'host' || (!args.containerId && args.target !== 'container')) {
        const sh = await spawnHostShell({
          sessionId,
          shell: args.shell, cwd: args.cwd,
          cols: args.cols, rows: args.rows,
          readonly: !!args.readonly, sudo: !!args.sudo,
          targetUser: args.targetUser,
        });
        sh.onData((s) => socket?.emit('term:output', { sessionId, data: Buffer.from(s, 'utf-8').toString('base64') }));
        sh.onCommand((cmd, ts) => socket?.emit('term:command', { sessionId, command: cmd, ts }));
        sh.onExit((code) => {
          socket?.emit('term:closed', { sessionId, reason: `exit ${code}` });
          activeTermStreams.delete(sessionId);
        });
        // adapta interface read-write
        const wrapper: any = {
          write: (b: Buffer) => sh.write(b.toString('utf-8')),
          end: () => sh.kill(),
          resize: (c: number, r: number) => sh.resize(c, r),
          isHost: true,
        };
        activeTermStreams.set(sessionId, wrapper);
        return { sessionId, started: true, target: 'host' };
      }
      // ========= MODO CONTAINER =========
      const c = docker.getContainer(args.containerId);
      const exec = await c.exec({
        AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: true,
        Cmd: args.command ? args.command.split(/\s+/) : ['/bin/sh'],
      });
      const stream: any = await exec.start({ hijack: true, stdin: true, Tty: true });
      stream.on('data', (chunk: Buffer) => {
        socket?.emit('term:output', { sessionId, data: chunk.toString('base64') });
      });
      stream.on('end', () => {
        socket?.emit('term:closed', { sessionId, reason: 'eof' });
        activeTermStreams.delete(sessionId);
      });
      activeTermStreams.set(sessionId, stream);
      return { sessionId, started: true, target: 'container' };
    }

    case 'term.input': {
      const s: any = activeTermStreams.get(args.sessionId);
      if (!s) throw new Error('session not found');
      s.write(Buffer.from(args.data ?? '', 'base64'));
      return { ok: true };
    }

    case 'term.resize': {
      const s: any = activeTermStreams.get(args.sessionId);
      if (s?.resize) s.resize(args.cols ?? 80, args.rows ?? 24);
      return { ok: true };
    }

    case 'term.close': {
      const s: any = activeTermStreams.get(args.sessionId);
      if (s) { try { s.end?.(); } catch {} activeTermStreams.delete(args.sessionId); }
      return { ok: true };
    }

    // ========= TCP discovery / processes =========
    case 'host.connections': {
      // ss -tnp state established → parse pra inferir edges container→external
      const r = await executeScript({
        path: '/bin/sh',
        args: ['-c', 'ss -tnp state established 2>/dev/null || netstat -tnp 2>/dev/null'],
        timeoutMs: 10_000,
      }).catch((e) => ({ exitCode: -1, stdout: '', stderr: e.message, durationMs: 0 } as any));
      return { kind: 'tcp', raw: r.stdout };
    }

    case 'host.processes': {
      // Top 30 processos por CPU
      const r = await executeScript({
        path: '/bin/sh',
        args: ['-c', 'ps -eo pid,user,pcpu,pmem,rss,etime,comm --sort=-pcpu | head -n 31'],
        timeoutMs: 5_000,
      }).catch((e) => ({ exitCode: -1, stdout: '', stderr: e.message, durationMs: 0 } as any));
      return { content: r.stdout };
    }

    case 'host.journalctl': {
      // Logs do host. journalctl primeiro; fallback /var/log/syslog.
      const sinceArg = args.since ? ['--since', String(args.since)] : [];
      const untilArg = args.until ? ['--until', String(args.until)] : [];
      const unitArg = args.unit ? ['-u', String(args.unit)] : [];
      const j = await executeScript({
        path: '/usr/bin/journalctl',
        args: ['--no-pager', '-o', 'short-iso', ...sinceArg, ...untilArg, ...unitArg],
        timeoutMs: 60_000,
      }).catch((e) => ({ exitCode: -1, stdout: '', stderr: e.message, durationMs: 0 } as any));
      if (j.exitCode === 0) return { kind: 'journalctl', content: j.stdout };
      const fb = await executeScript({
        path: '/bin/cat',
        args: ['/var/log/syslog'],
        timeoutMs: 30_000,
      }).catch((e) => ({ exitCode: -1, stdout: '', stderr: e.message, durationMs: 0 } as any));
      return { kind: 'syslog', content: fb.stdout, fallback: true, error: j.stderr };
    }

    // ========= Captura de rede/SIP (Zero Trust) =========
    // Só chega aqui depois de aprovado no backend (capture_sessions). Bloqueia
    // até a captura terminar (ping é rápido; sip/tcpdump duram args.durationSeconds).
    // Pra sip/tcpdump, cada chunk do .pcap (vindo de stdout do tcpdump, nunca
    // de um arquivo) é repassado em tempo real via docker:stream — o mesmo
    // canal genérico usado pro progresso de `docker pull` — correlacionado
    // por reqId. O backend só repassa esses chunks pra quem estiver olhando a
    // sessão ao vivo (ws /ws/captures); nada fica salvo em disco em nenhum
    // lado. Por isso o backend dispara isso via invokeStream() sem travar a
    // resposta HTTP da aprovação.
    case 'capture.run':
      return runCapture(args, (chunkB64) => {
        socket?.emit('docker:stream', { reqId, data: chunkB64 });
      });

    default:
      throw new Error(`Unknown op: ${op}`);
  }
}

function summarizeStats(s: any) {
  const cpuDelta = s.cpu_stats.cpu_usage.total_usage - s.precpu_stats.cpu_usage.total_usage;
  const sysDelta = s.cpu_stats.system_cpu_usage - s.precpu_stats.system_cpu_usage;
  const cpuPct = sysDelta > 0 && cpuDelta > 0
    ? (cpuDelta / sysDelta) * (s.cpu_stats.online_cpus ?? 1) * 100
    : 0;
  return {
    cpuPct: Math.round(cpuPct * 100) / 100,
    memUsed: s.memory_stats?.usage ?? 0,
    memLimit: s.memory_stats?.limit ?? 0,
    memPct: s.memory_stats?.limit
      ? Math.round((s.memory_stats.usage / s.memory_stats.limit) * 10000) / 100
      : 0,
    pids: s.pids_stats?.current ?? 0,
  };
}
