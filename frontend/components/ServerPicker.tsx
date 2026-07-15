'use client';

import { useEffect, useMemo } from 'react';
import { Select } from './ui/Select';
import { useServers, type ServerRow } from '@/lib/useServers';

const ALL_KEY = '__all__';

export interface ServerPickerProps {
  /** id do servidor selecionado (string vazia = nada selecionado, ou "todos" quando allowAll). */
  value: string;
  onChange: (serverId: string) => void;
  /** classes do wrapper externo (default: flex lado a lado). */
  className?: string;
  /** classes aplicadas aos dois <Select> internos (ex: 'w-auto' pra caber numa barra de ações). */
  selectClassName?: string;
  /**
   * Texto da opção vazia do select de SERVIDOR — se definido, o servidor
   * começa sem seleção dentro do grupo (ex: telas de busca, onde o usuário
   * escolhe o ambiente e depois o servidor). Se omitido, o componente
   * seleciona automaticamente o primeiro servidor do grupo corrente.
   */
  placeholder?: string;
  /**
   * Se true, adiciona uma opção "Todos" no select de AMBIENTE que zera o
   * serverId (value='') — usado por telas que fazem busca/exportação
   * agregando todos os servidores (ex: /logs, /exports).
   */
  allowAll?: boolean;
  /** Rótulo da opção "Todos" (default: 'Todos os servidores'). Só faz sentido com allowAll. */
  allLabel?: string;
  /**
   * Se true e `value` estiver vazio (e allowAll for false), seleciona
   * automaticamente o primeiro servidor assim que a lista carregar — replica
   * o comportamento que Docker/Scripts já tinham antes desta troca (essas
   * telas sempre abriam com um servidor pré-selecionado).
   */
  autoSelectFirst?: boolean;
  disabled?: boolean;
  /**
   * Filtra quais servidores aparecem no SEGUNDO select (dentro do ambiente já
   * escolhido) — o nível de ambiente (cloud/região) continua mostrando todos
   * os grupos normalmente, só a lista de servidores dentro de cada grupo é
   * filtrada. Uso: telas dedicadas a um tipo específico de host (ex.: só
   * `sip-server` na tela de logs de chamadas) sem duplicar o componente nem
   * afetar as outras telas que não passam essa prop.
   */
  serverFilter?: (s: ServerRow) => boolean;
}

/**
 * Seleção em cascata de servidor: primeiro escolhe um "ambiente" (cloud, e
 * cloud+região quando a cloud tem mais de uma região cadastrada — ver
 * groupServers() em lib/useServers.ts), depois um servidor dentro daquele
 * grupo. Existe pra resolver duas coisas ao mesmo tempo:
 *
 *  1. Substituir os vários `apiFetch('/servers')` + <Select> locais e
 *     duplicados espalhados pela aplicação (useServers() já cacheia a
 *     lista uma vez por sessão de página).
 *  2. Evitar que o dropdown de servidor vire uma lista longa e poluída à
 *     medida que a frota cresce — o usuário pediu especificamente pra poder
 *     escolher "cloud" (e dentro de AWS, a região) antes do servidor
 *     específico.
 *
 * Contrato mínimo: value/onChange do id do servidor — dá pra trocar um
 * <Select> de servidor já existente por este componente sem mexer no resto
 * da tela (o "dono" do serverId continua sendo o componente pai).
 */
export function ServerPicker({
  value,
  onChange,
  className,
  selectClassName,
  placeholder,
  allowAll,
  allLabel,
  autoSelectFirst,
  disabled,
  serverFilter,
}: ServerPickerProps) {
  const { groups, loading } = useServers();

  // Grupos de ambiente sempre completos (cloud/região não é filtrada); só a
  // lista de servidores DENTRO de cada grupo passa pelo serverFilter, quando
  // fornecido. Grupos que ficam sem nenhum servidor após o filtro continuam
  // aparecendo no select de ambiente (evita o ambiente "sumir" da lista só
  // porque nenhum servidor dele bate o filtro agora) — o segundo select é
  // que fica vazio nesse caso.
  const filteredGroups = useMemo(() => {
    if (!serverFilter) return groups;
    return groups.map((g) => ({ ...g, servers: g.servers.filter(serverFilter) }));
  }, [groups, serverFilter]);

  const effectiveGroups = useMemo(() => {
    if (!allowAll) return filteredGroups;
    return [
      { cloud: '', region: null, key: ALL_KEY, label: allLabel ?? 'Todos os servidores', servers: [] },
      ...filteredGroups,
    ];
  }, [filteredGroups, allowAll, allLabel]);

  const currentGroup = useMemo(() => {
    if (!effectiveGroups.length) return null;
    if (!value && allowAll) return effectiveGroups[0]; // pseudo-grupo "Todos"
    const bySelected = effectiveGroups.find((g) => g.servers.some((s) => s.id === value));
    if (bySelected) return bySelected;
    // Sem servidor selecionado ainda (ou id não encontrado): cai no primeiro
    // grupo REAL (pula o pseudo-grupo "Todos" quando allowAll, senão o
    // ambiente já viria pré-selecionado como "Todos" mesmo sem pedir).
    return allowAll ? effectiveGroups[1] ?? effectiveGroups[0] : effectiveGroups[0];
  }, [effectiveGroups, value, allowAll]);

  // Seleciona automaticamente o primeiro servidor assim que a lista carrega
  // — só quando NÃO é o modo "Todos" e o chamador pediu explicitamente
  // (telas que sempre precisam de um servidor escolhido pra funcionar, como
  // Docker manager e Script Manager).
  useEffect(() => {
    if (autoSelectFirst && !value && !allowAll && filteredGroups.length && filteredGroups[0].servers[0]) {
      onChange(filteredGroups[0].servers[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoSelectFirst, value, allowAll, filteredGroups]);

  function onGroupChange(key: string) {
    if (key === ALL_KEY) {
      onChange('');
      return;
    }
    const g = effectiveGroups.find((x) => x.key === key);
    const first = g?.servers[0];
    if (first) onChange(first.id);
    else if (!g?.servers.length) onChange('');
  }

  const isAllGroup = currentGroup?.key === ALL_KEY;

  return (
    // Default empilhado (coluna) — mais seguro dentro de colunas estreitas de
    // grid (a maioria dos formulários de filtro da aplicação usa grids de
    // 12 colunas com esse seletor ocupando só 3-4). Telas com mais espaço
    // horizontal (ex.: barra de ações do Docker/Scripts) passam
    // className="flex items-center gap-2" pra ficar lado a lado.
    <div className={className ?? 'flex flex-col gap-1.5'}>
      <Select
        value={currentGroup?.key ?? ''}
        onChange={(e) => onGroupChange(e.target.value)}
        className={selectClassName}
        disabled={disabled || loading || !effectiveGroups.length}
      >
        {effectiveGroups.map((g) => (
          <option key={g.key} value={g.key}>
            {g.label}
          </option>
        ))}
      </Select>
      <Select
        value={isAllGroup ? '' : value}
        onChange={(e) => onChange(e.target.value)}
        className={selectClassName}
        disabled={disabled || loading || isAllGroup || !currentGroup?.servers.length}
      >
        {isAllGroup && <option value="">(qualquer servidor)</option>}
        {!isAllGroup && placeholder && <option value="">{placeholder}</option>}
        {(currentGroup?.servers ?? []).map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </Select>
    </div>
  );
}
