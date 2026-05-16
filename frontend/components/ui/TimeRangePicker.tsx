'use client';

/**
 * Picker de janela temporal com presets + range absoluto.
 *
 * Valores emitidos seguem o que o backend já aceita em /logs?from=&to= :
 *   - relativos: "now", "now-15m", "now-1h", "now-7d"
 *   - ISO 8601:  "2024-05-14T11:23:00.000Z"
 *
 * Internamente:
 *   - Quando o usuário clica num preset, emitimos as strings relativas
 *     (deixa o backend resolver com base no "agora" da query — mais correto
 *     em casos de auto-refresh).
 *   - Quando escolhe datas no modo "absoluto", emitimos ISO.
 */
import { useState } from 'react';
import { Calendar, Clock, ChevronDown } from 'lucide-react';

export interface TimeRange {
  from: string;
  to: string;
  /** Rótulo legível pro usuário (ex: "Última hora", "14/05 11:00 → 12:00") */
  label: string;
  /** Indica se é relativo (ideal para auto-refresh) ou absoluto */
  relative: boolean;
}

interface Preset {
  label: string;
  from: string;
  to: string;
}

const PRESETS: Preset[] = [
  { label: 'Últimos 5 min',  from: 'now-5m',  to: 'now' },
  { label: 'Últimos 15 min', from: 'now-15m', to: 'now' },
  { label: 'Últimos 30 min', from: 'now-30m', to: 'now' },
  { label: 'Última hora',    from: 'now-1h',  to: 'now' },
  { label: 'Últimas 4 horas', from: 'now-4h', to: 'now' },
  { label: 'Últimas 12 horas', from: 'now-12h', to: 'now' },
  { label: 'Últimas 24 horas', from: 'now-24h', to: 'now' },
  { label: 'Últimos 2 dias', from: 'now-2d', to: 'now' },
  { label: 'Últimos 7 dias', from: 'now-7d', to: 'now' },
  { label: 'Últimos 30 dias', from: 'now-30d', to: 'now' },
];

interface Props {
  value: TimeRange;
  onChange: (r: TimeRange) => void;
}

export function TimeRangePicker({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'preset' | 'absolute'>('preset');
  const [absFrom, setAbsFrom] = useState<string>(toLocalInput(new Date(Date.now() - 3600_000)));
  const [absTo, setAbsTo] = useState<string>(toLocalInput(new Date()));

  function pickPreset(p: Preset) {
    onChange({ from: p.from, to: p.to, label: p.label, relative: true });
    setOpen(false);
  }

  function pickToday() {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    onChange({
      from: d.toISOString(), to: 'now',
      label: 'Hoje', relative: false,
    });
    setOpen(false);
  }

  function pickYesterday() {
    const start = new Date();
    start.setDate(start.getDate() - 1);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setHours(23, 59, 59, 999);
    onChange({
      from: start.toISOString(), to: end.toISOString(),
      label: 'Ontem', relative: false,
    });
    setOpen(false);
  }

  function applyAbsolute() {
    const f = new Date(absFrom);
    const t = new Date(absTo);
    if (isNaN(f.getTime()) || isNaN(t.getTime())) {
      alert('Datas inválidas');
      return;
    }
    if (f >= t) {
      alert('"De" precisa ser antes de "Até"');
      return;
    }
    onChange({
      from: f.toISOString(), to: t.toISOString(),
      label: `${fmtShort(f)} → ${fmtShort(t)}`,
      relative: false,
    });
    setOpen(false);
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 rounded-md bg-panel2 border border-border px-3 py-2 text-sm hover:border-accent"
      >
        <Clock size={14} className="text-muted" />
        <span>{value.label}</span>
        <ChevronDown size={12} className="text-muted" />
      </button>

      {open && (
        <>
          {/* backdrop pra fechar ao clicar fora */}
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 z-20 w-[420px] rounded-md bg-panel border border-border shadow-xl p-3">
            <div className="flex gap-1 mb-3 border-b border-border">
              <button
                onClick={() => setMode('preset')}
                className={`px-3 py-1.5 text-xs border-b-2 ${
                  mode === 'preset' ? 'border-accent text-accent' : 'border-transparent text-muted'
                }`}
              >
                Presets
              </button>
              <button
                onClick={() => setMode('absolute')}
                className={`px-3 py-1.5 text-xs border-b-2 ${
                  mode === 'absolute' ? 'border-accent text-accent' : 'border-transparent text-muted'
                }`}
              >
                Data específica
              </button>
            </div>

            {mode === 'preset' ? (
              <>
                <div className="grid grid-cols-2 gap-1">
                  {PRESETS.map((p) => (
                    <button
                      key={p.label}
                      onClick={() => pickPreset(p)}
                      className={`text-left text-xs px-2 py-1.5 rounded hover:bg-panel2 ${
                        value.label === p.label ? 'bg-panel2 text-accent' : ''
                      }`}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
                <div className="mt-2 pt-2 border-t border-border grid grid-cols-2 gap-1">
                  <button onClick={pickToday} className="text-left text-xs px-2 py-1.5 rounded hover:bg-panel2">
                    📅 Hoje (00:00 até agora)
                  </button>
                  <button onClick={pickYesterday} className="text-left text-xs px-2 py-1.5 rounded hover:bg-panel2">
                    🕐 Ontem (dia completo)
                  </button>
                </div>
                <p className="text-[10px] text-muted mt-2">
                  Presets usam tempo relativo (auto-refresh atualiza a janela).
                </p>
              </>
            ) : (
              <div className="space-y-2">
                <div>
                  <label className="text-xs text-muted flex items-center gap-1">
                    <Calendar size={11} /> De
                  </label>
                  <input
                    type="datetime-local"
                    value={absFrom}
                    onChange={(e) => setAbsFrom(e.target.value)}
                    className="w-full rounded-md bg-panel2 border border-border px-3 py-2 text-sm"
                  />
                </div>
                <div>
                  <label className="text-xs text-muted flex items-center gap-1">
                    <Calendar size={11} /> Até
                  </label>
                  <input
                    type="datetime-local"
                    value={absTo}
                    onChange={(e) => setAbsTo(e.target.value)}
                    className="w-full rounded-md bg-panel2 border border-border px-3 py-2 text-sm"
                  />
                </div>
                <button
                  onClick={applyAbsolute}
                  className="w-full rounded-md bg-accent text-white text-sm py-2 hover:bg-accent/90"
                >
                  Aplicar
                </button>
                <p className="text-[10px] text-muted">
                  Datas absolutas — auto-refresh não desloca a janela.
                </p>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** Default value usado quando a página carrega. */
export const DEFAULT_RANGE: TimeRange = {
  from: 'now-15m', to: 'now', label: 'Últimos 15 min', relative: true,
};

function toLocalInput(d: Date): string {
  // formato esperado por <input type="datetime-local">
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fmtShort(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
