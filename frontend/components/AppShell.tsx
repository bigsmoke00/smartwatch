'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  Server,
  ScrollText,
  Users,
  LogOut,
  Activity,
  Bell,
  History,
  Database,
  Settings,
  Gauge,
  DollarSign,
  KeyRound,
  Shield,
  Boxes,
  FileCode,
  Download,
  Terminal as TerminalIcon,
  Database as DbIcon,
  TerminalSquare,
  Radar,
} from 'lucide-react';
import { Auth, apiFetch } from '@/lib/api';
import { loadMyPermissions, hasPerm } from '@/lib/perms';
import { cn } from '@/lib/utils';

interface NavItem {
  href: string;
  label: string;
  icon: any;
  perms?: string[]; // requer ao menos 1 dessas
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState<ReturnType<typeof Auth.user>>(null);
  const [perms, setPerms] = useState<Set<string> | null>(null);
  const [mfaSetupRequired, setMfaSetupRequired] = useState(false);

  useEffect(() => {
    const u = Auth.user();
    if (!u) {
      router.replace('/login');
      return;
    }
    setUser(u);
    setMfaSetupRequired(!!u.mfaSetupRequired);
    loadMyPermissions().then(setPerms);
    // /auth/me reflete o estado real do banco (a sessão pode ter sido aberta
    // antes do admin marcar mfa_required, ou antes do usuário configurar o
    // 2FA), então atualizamos o cache local com o valor atual.
    apiFetch<{ mfaEnabled: boolean; mfaRequired: boolean; mfaSetupRequired: boolean }>(
      '/auth/me',
    )
      .then((me) => {
        const merged = { ...u, ...me };
        localStorage.setItem('lw_user', JSON.stringify(merged));
        setUser(merged);
        setMfaSetupRequired(!!me.mfaSetupRequired);
      })
      .catch(() => {});
  }, [router]);

  useEffect(() => {
    if (mfaSetupRequired && pathname !== '/settings') {
      router.replace('/settings');
    }
  }, [mfaSetupRequired, pathname, router]);

  if (!user) return null;

  const groups: { title: string; items: NavItem[] }[] = [
    {
      title: 'Observabilidade',
      items: [
        { href: '/', label: 'Visão geral', icon: Activity },
        { href: '/logs', label: 'Logs', icon: ScrollText, perms: ['logs:read'] },
        { href: '/metrics', label: 'Métricas', icon: Gauge, perms: ['metrics:read'] },
        { href: '/alerts', label: 'Alertas', icon: Bell, perms: ['alerts:read'] },
      ],
    },
    {
      title: 'Infraestrutura',
      items: [
        { href: '/servers', label: 'Servidores', icon: Server, perms: ['servers:read'] },
        { href: '/docker', label: 'Docker manager', icon: Boxes, perms: ['docker:control', 'containers:read'] },
        { href: '/scripts', label: 'Scripts', icon: FileCode, perms: ['scripts:read'] },
        { href: '/databases', label: 'PostgreSQL', icon: DbIcon, perms: ['pg:read'] },
        { href: '/patroni', label: 'Cluster Patroni', icon: Database, perms: ['patroni:read'] },
      ],
    },
    {
      title: 'Operações',
      items: [
        { href: '/exports', label: 'Log exports', icon: Download, perms: ['logs:download'] },
        { href: '/audit', label: 'Audit log', icon: History, perms: ['audit:read'] },
      ],
    },
    {
      title: 'Acesso (Zero Trust)',
      items: [
        { href: '/terminal', label: 'Terminal web', icon: TerminalIcon, perms: ['terminal:request', 'terminal:open'] },
        { href: '/db-access', label: 'Acesso a banco', icon: TerminalSquare, perms: ['db:query', 'db:write_request', 'db:write_approve'] },
        { href: '/captures', label: 'Captura de rede/SIP', icon: Radar, perms: ['capture:request', 'capture:approve'] },
      ],
    },
    {
      title: 'Cloud',
      items: [
        { href: '/finops', label: 'FinOps', icon: DollarSign, perms: ['finops:read'] },
        { href: '/credential-rotations', label: 'Rotação de credenciais', icon: KeyRound, perms: ['credrot:read'] },
      ],
    },
    {
      title: 'Conta',
      items: [
        { href: '/settings', label: 'Ajustes / 2FA', icon: Settings },
        { href: '/settings/roles', label: 'Perfis e permissões', icon: Shield, perms: ['roles:read'] },
        { href: '/users', label: 'Usuários', icon: Users, perms: ['users:read'] },
      ],
    },
  ];

  return (
    <div className="flex h-screen">
      <aside className="w-64 border-r border-border bg-panel flex flex-col">
        <div className="px-4 py-4 border-b border-border">
          <div className="font-semibold text-lg flex items-center gap-2">
            <span className="inline-block w-2 h-2 rounded-full bg-accent" />
            LogWatch
          </div>
          <div className="text-xs text-muted mt-1 truncate">
            {user.email} <span className="text-accent">({user.role})</span>
          </div>
        </div>
        <nav className="flex-1 p-2 space-y-3 overflow-auto">
          {groups.map((g) => {
            const visible = g.items.filter((i) => {
              if (!i.perms || i.perms.length === 0) return true;
              return hasPerm(perms, ...i.perms);
            });
            if (!visible.length) return null;
            return (
              <div key={g.title}>
                <div className="px-3 pb-1 text-[10px] uppercase tracking-wider text-muted">{g.title}</div>
                <div className="space-y-0.5">
                  {visible.map((n) => {
                    const Icon = n.icon;
                    const active =
                      pathname === n.href ||
                      (n.href !== '/' && pathname.startsWith(n.href));
                    return (
                      <Link
                        key={n.href}
                        href={n.href}
                        className={cn(
                          'flex items-center gap-2 px-3 py-1.5 rounded-md text-sm hover:bg-panel2',
                          active && 'bg-panel2 text-accent',
                        )}
                      >
                        <Icon size={15} />
                        {n.label}
                      </Link>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </nav>
        <button
          onClick={async () => {
            await Auth.logout();
            router.push('/login');
          }}
          className="m-2 flex items-center gap-2 px-3 py-2 rounded-md text-sm hover:bg-panel2 text-muted"
        >
          <LogOut size={16} /> Sair
        </button>
        <div className="px-3 pb-2 text-[10px] text-muted/60">
          v{process.env.NEXT_PUBLIC_APP_VERSION ?? '?'}
        </div>
      </aside>
      <main className="flex-1 overflow-auto flex flex-col">
        {mfaSetupRequired && (
          <div className="bg-warn/10 border-b border-warn text-warn text-sm px-4 py-2 text-center">
            Sua conta exige autenticação de dois fatores. Configure o 2FA abaixo antes de continuar.
          </div>
        )}
        <div className="flex-1">{children}</div>
      </main>
    </div>
  );
}
