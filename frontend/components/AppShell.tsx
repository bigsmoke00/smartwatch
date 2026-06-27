'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
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
  ChevronsLeft,
  ChevronsRight,
  ChevronDown,
  User as UserIcon,
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

const NAV_GROUPS: { title: string; items: NavItem[] }[] = [
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

function currentPageLabel(pathname: string): string {
  for (const g of NAV_GROUPS) {
    for (const i of g.items) {
      if (i.href === pathname || (i.href !== '/' && pathname.startsWith(i.href))) {
        return i.label;
      }
    }
  }
  return 'LogWatch';
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState<ReturnType<typeof Auth.user>>(null);
  const [perms, setPerms] = useState<Set<string> | null>(null);
  const [mfaSetupRequired, setMfaSetupRequired] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const stored = typeof window !== 'undefined' ? localStorage.getItem('lw_sidebar_collapsed') : null;
    if (stored === '1') setCollapsed(true);
  }, []);

  useEffect(() => {
    const u = Auth.user();
    if (!u) {
      router.replace('/login');
      return;
    }
    setUser(u);
    setMfaSetupRequired(!!u.mfaSetupRequired);
    loadMyPermissions().then(setPerms);
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

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setUserMenuOpen(false);
    }
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, []);

  function toggleCollapsed() {
    setCollapsed((c) => {
      localStorage.setItem('lw_sidebar_collapsed', !c ? '1' : '0');
      return !c;
    });
  }

  if (!user) return null;

  return (
    <div className="flex h-screen bg-bg">
      <aside
        className={cn(
          'border-r border-border bg-panel flex flex-col transition-[width] duration-150 shrink-0',
          collapsed ? 'w-[68px]' : 'w-64',
        )}
      >
        <div className={cn('px-4 py-4 border-b border-border flex items-center gap-2.5', collapsed && 'justify-center px-2')}>
          <div className="w-7 h-7 rounded-lg bg-accent-gradient flex items-center justify-center shrink-0 shadow-[0_1px_0_0_rgba(255,255,255,0.15)_inset]">
            <Activity size={14} className="text-white" />
          </div>
          {!collapsed && (
            <div className="min-w-0">
              <div className="font-semibold text-[15px] tracking-tight leading-none">LogWatch</div>
              <div className="text-2xs text-mutedFaint mt-0.5">Plataforma de observabilidade</div>
            </div>
          )}
        </div>

        <nav className="flex-1 px-2 py-3 space-y-4 overflow-auto">
          {NAV_GROUPS.map((g) => {
            const visible = g.items.filter((i) => {
              if (!i.perms || i.perms.length === 0) return true;
              return hasPerm(perms, ...i.perms);
            });
            if (!visible.length) return null;
            return (
              <div key={g.title}>
                {!collapsed && (
                  <div className="px-2.5 pb-1 text-2xs uppercase tracking-wider text-mutedFaint font-medium">
                    {g.title}
                  </div>
                )}
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
                        title={collapsed ? n.label : undefined}
                        className={cn(
                          'relative flex items-center gap-2.5 px-2.5 py-[7px] rounded-lg text-sm transition-colors',
                          collapsed && 'justify-center',
                          active
                            ? 'bg-accent/10 text-accentSoft'
                            : 'text-muted hover:text-text hover:bg-panel2',
                        )}
                      >
                        {active && (
                          <span className="absolute left-0 top-1/2 -translate-y-1/2 h-4 w-[3px] rounded-full bg-accent" />
                        )}
                        <Icon size={15} className="shrink-0" />
                        {!collapsed && <span className="truncate">{n.label}</span>}
                      </Link>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </nav>

        <div className="p-2 border-t border-border space-y-1">
          <button
            onClick={toggleCollapsed}
            className={cn(
              'w-full flex items-center gap-2.5 px-2.5 py-[7px] rounded-lg text-sm text-mutedFaint hover:text-text hover:bg-panel2 transition-colors',
              collapsed && 'justify-center',
            )}
          >
            {collapsed ? <ChevronsRight size={15} /> : <ChevronsLeft size={15} />}
            {!collapsed && 'Recolher menu'}
          </button>
          {!collapsed && (
            <div className="px-2.5 pt-1 text-2xs text-mutedFaint/70">
              v{process.env.NEXT_PUBLIC_APP_VERSION ?? '?'}
            </div>
          )}
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-14 border-b border-border bg-panel/60 backdrop-blur-sm flex items-center justify-between px-5 shrink-0">
          <div className="text-sm font-medium text-text">{currentPageLabel(pathname)}</div>
          <div className="relative" ref={menuRef}>
            <button
              onClick={() => setUserMenuOpen((v) => !v)}
              className="flex items-center gap-2 pl-1.5 pr-2.5 py-1.5 rounded-lg hover:bg-panel2 transition-colors"
            >
              <div className="w-6 h-6 rounded-full bg-panel3 border border-border flex items-center justify-center text-muted">
                <UserIcon size={12} />
              </div>
              <span className="text-xs text-muted max-w-[180px] truncate">{user.email}</span>
              <Badge>{user.role}</Badge>
              <ChevronDown size={13} className="text-mutedFaint" />
            </button>
            {userMenuOpen && (
              <div className="absolute right-0 mt-1.5 w-56 rounded-lg border border-border bg-panel shadow-elevate py-1 z-50 animate-fadeIn">
                <div className="px-3 py-2 border-b border-border">
                  <div className="text-sm text-text truncate">{user.email}</div>
                  <div className="text-2xs text-muted">{user.role}</div>
                </div>
                <Link
                  href="/settings"
                  onClick={() => setUserMenuOpen(false)}
                  className="flex items-center gap-2 px-3 py-2 text-sm text-muted hover:text-text hover:bg-panel2"
                >
                  <Settings size={14} /> Ajustes / 2FA
                </Link>
                <button
                  onClick={async () => {
                    await Auth.logout();
                    router.push('/login');
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm text-danger hover:bg-danger/10"
                >
                  <LogOut size={14} /> Sair
                </button>
              </div>
            )}
          </div>
        </header>

        {mfaSetupRequired && (
          <div className="bg-warn/10 border-b border-warn/40 text-warn text-sm px-4 py-2 text-center">
            Sua conta exige autenticação de dois fatores. Configure o 2FA abaixo antes de continuar.
          </div>
        )}

        <main className="flex-1 overflow-auto">{children}</main>
      </div>
    </div>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-2xs uppercase tracking-wide text-accentSoft bg-accent/10 border border-accent/25 rounded px-1.5 py-0.5">
      {children}
    </span>
  );
}
