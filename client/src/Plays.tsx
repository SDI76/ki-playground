import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import type { Scene, Snap, StaticPart } from './scene';
import { api, type LogEntry } from './App';
import type { Note } from './Overlays';

export interface PlayRow {
  id: number; name: string; note: string; created_at: string; ended_at: string | null;
  duration: number; frames: number; events: number; bytes: number; source: string;
  meta: { agents?: { id: string; name: string; color: string; runner?: string; model?: string }[]; statics?: StaticPart[] };
}
type Frame = {
  k?: 1; am?: Record<string, [string, string]>; a?: Record<string, number[]>; ax?: string[];
  m?: Record<string, [string, string, string]>; o?: Record<string, number[]>; x?: number[];
};
export interface PlayData { play: PlayRow; frames: [number, Frame][]; events: [number, string, string, any][] }

const clock = (s: number) => {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return `${h ? String(h).padStart(2, '0') + ':' : ''}${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
};
const size = (b: number) => (b > 1e6 ? `${(b / 1e6).toFixed(1).replace('.', ',')} MB` : `${Math.max(1, Math.round(b / 1e3))} kB`);
const day = (iso: string) => new Date(iso).toLocaleString('de-CH', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });

/** Baut aus den gespeicherten Differenzbildern den Zustand der Welt zu einem Zeitpunkt. */
class Player {
  private agents = new Map<string, { name: string; color: string; v: number[] }>();
  private objs = new Map<number, { kind: string; name: string; s: string; v: number[] }>();
  private fi = 0;
  private ei = 0;
  constructor(private d: PlayData) {}

  private apply(f: Frame) {
    if (f.k) { this.agents.clear(); this.objs.clear(); }
    for (const [id, [name, color]] of Object.entries(f.am || {})) this.agents.set(id, { name, color, v: this.agents.get(id)?.v || [0, 0, 0, 0, null as any, 0, 1] });
    for (const [id, v] of Object.entries(f.a || {})) { const a = this.agents.get(id); if (a) a.v = v; }
    for (const id of f.ax || []) this.agents.delete(id);
    for (const [id, [kind, name, s]] of Object.entries(f.m || {})) this.objs.set(Number(id), { kind, name, s, v: this.objs.get(Number(id))?.v || [0, -50, 0, 0, 0, 0, 1] });
    for (const [id, v] of Object.entries(f.o || {})) { const o = this.objs.get(Number(id)); if (o) o.v = v; }
    for (const id of f.x || []) this.objs.delete(id);
  }

  /** Springt zu einem Zeitpunkt, ohne die Ereignisse dazwischen abzuspielen. */
  seek(t: number) {
    const fr = this.d.frames;
    let end = 0;
    while (end < fr.length && fr[end][0] <= t) end++;
    let start = end - 1;
    while (start > 0 && !fr[start][1].k) start--;
    this.agents.clear();
    this.objs.clear();
    for (let i = Math.max(0, start); i < end; i++) this.apply(fr[i][1]);
    this.fi = end;
    this.ei = 0;
    while (this.ei < this.d.events.length && this.d.events[this.ei][0] <= t) this.ei++;
  }

  /** Läuft bis t vor. Liefert true, wenn sich das Bild geändert hat. */
  advance(t: number, emit: (e: [number, string, string, any]) => void) {
    let changed = false;
    while (this.fi < this.d.frames.length && this.d.frames[this.fi][0] <= t) { this.apply(this.d.frames[this.fi++][1]); changed = true; }
    while (this.ei < this.d.events.length && this.d.events[this.ei][0] <= t) emit(this.d.events[this.ei++]);
    return changed;
  }

  snap(time: number, paused: boolean, speed: number): Snap {
    return {
      time, paused, speed, resetIn: null, resetCount: 0,
      agents: [...this.agents].map(([id, a]) => ({ id, name: a.name, color: a.color, p: a.v.slice(0, 3), yaw: a.v[3], holding: a.v[4] ?? null, moving: !!a.v[5], grounded: !!a.v[6] })),
      objs: [...this.objs].map(([id, o]) => ({ id, kind: o.kind as any, name: o.name, s: o.s || undefined, p: o.v.slice(0, 3), q: o.v.slice(3, 7) })),
    };
  }
}

const SPEEDS = [0.5, 1, 2, 4, 8, 16];

/** Spielt ein aufgenommenes Play in der 3D-Ansicht ab. Keine KI ist verbunden. */
export function ReplayBar({ scene, data, logSubs, noteSubs, onExit }: {
  scene: RefObject<Scene | null>; data: PlayData;
  logSubs: Set<(id: string, e: LogEntry) => void>; noteSubs: Set<(n: Note) => void>; onExit: () => void;
}) {
  const player = useMemo(() => new Player(data), [data]);
  const total = Math.max(data.play.duration, data.frames.at(-1)?.[0] ?? 0, 0.1);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [voice, setVoice] = useState('');
  const st = useRef({ t: 0, playing: true, speed: 1 });
  st.current.playing = playing;
  st.current.speed = speed;

  const emit = useCallback((e: [number, string, string, any]) => {
    const [time, kind, agent, d] = e;
    if (kind === 'log') logSubs.forEach((f) => f(agent, { ...d, wall: Date.now(), time }));
    else if (kind === 'note') noteSubs.forEach((f) => f({ id: agent, ...d }));
    else if (kind === 'voice') { setVoice(d.text); window.setTimeout(() => setVoice((v) => (v === d.text ? '' : v)), 8000); }
  }, [logSubs, noteSubs]);

  const show = useCallback(() => scene.current?.apply(player.snap(st.current.t, !st.current.playing, st.current.speed)), [player, scene]);

  const seek = useCallback((to: number) => {
    st.current.t = Math.max(0, Math.min(total, to));
    player.seek(st.current.t);
    setT(st.current.t);
    show();
  }, [player, show, total]);

  useEffect(() => {
    if (data.play.meta.statics) scene.current?.setStatics(data.play.meta.statics);
    seek(0);
    let raf = 0;
    let last = performance.now();
    let shown = -1;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dt = Math.min((now - last) / 1000, 0.25);
      last = now;
      const s = st.current;
      if (!s.playing) return;
      s.t = Math.min(total, s.t + dt * s.speed);
      if (player.advance(s.t, emit)) show();
      if (Math.floor(s.t * 4) !== shown) { shown = Math.floor(s.t * 4); setT(s.t); }
      if (s.t >= total) setPlaying(false);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [data, player, seek, show, emit, total, scene]);

  // Pause und Tempo auch an die Szene melden (Laufbewegung, Wasser)
  useEffect(() => { show(); }, [playing, speed, show]);

  const toggle = () => {
    if (!playing && st.current.t >= total) seek(0);
    setPlaying((p) => !p);
  };

  return (
    <>
      {voice && <div className="voice">Stimme von aussen: {voice}</div>}
      <footer className="bar replay">
        <button className="primary" onClick={toggle}>{playing ? '❚❚ Pause' : '▶ Abspielen'}</button>
        <div className="seg" role="group" aria-label="Tempo">
          {SPEEDS.map((s) => <button key={s} className={speed === s ? 'on' : ''} onClick={() => setSpeed(s)}>{s}×</button>)}
        </div>
        <div className="time"><b>{clock(t)}</b><small>von {clock(total)}</small></div>
        <input className="scrub" type="range" min={0} max={total} step={0.1} value={t} onChange={(e) => seek(Number(e.target.value))} aria-label="Zeitleiste" />
        <button className="ghost" onClick={onExit}>Zurück zur Simulation</button>
      </footer>
    </>
  );
}

/** Liste der aufgenommenen Plays: abspielen, umbenennen, notieren, exportieren, importieren, löschen. */
export function PlaysPanel({ onPlay, onClose, onError, recordingId, version }: {
  onPlay: (id: number) => void; onClose: () => void; onError: (m: string) => void; recordingId: number | null; version: number;
}) {
  const [plays, setPlays] = useState<PlayRow[] | null>(null);
  const [edit, setEdit] = useState<number | null>(null);
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const file = useRef<HTMLInputElement>(null);

  const load = useCallback(() => api('/api/plays').then((r) => setPlays(r.plays)).catch((e) => onError(e.message)), [onError]);
  useEffect(() => { load(); }, [load, version, recordingId]);

  const save = async (id: number) => {
    try { await api(`/api/plays/${id}`, 'PATCH', { name, note }); setEdit(null); load(); } catch (e: any) { onError(e.message); }
  };
  const remove = async (p: PlayRow) => {
    if (!confirm(`„${p.name}" endgültig löschen? Das lässt sich nicht rückgängig machen.`)) return;
    try { await api(`/api/plays/${p.id}`, 'DELETE'); load(); } catch (e: any) { onError(e.message); }
  };
  const importFile = async (f: File | undefined) => {
    if (!f) return;
    try {
      const res = await fetch('/api/plays/import', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: f });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || `Fehler ${res.status}`);
      load();
    } catch (e: any) { onError(e.message); }
    if (file.current) file.current.value = '';
  };

  return (
    <section className="glass plays" aria-label="Plays">
      <div className="panel-head">
        <h2>Plays</h2>
        <div className="row">
          <button className="ghost" onClick={() => file.current?.click()}>Importieren</button>
          <input ref={file} type="file" accept=".kiplay,application/gzip" hidden onChange={(e) => importFile(e.target.files?.[0])} />
          <button className="ghost" onClick={onClose} aria-label="Schliessen">✕</button>
        </div>
      </div>
      {plays && plays.length === 0 && <p className="hint">Noch keine Aufnahme. Schalte „Autorecord" ein oder drücke „● Aufnahme" in der Leiste.</p>}
      <ul className="playlist">
        {(plays || []).map((p) => {
          const live = p.id === recordingId;
          return (
            <li key={p.id}>
              {edit === p.id ? (
                <div className="form">
                  <label>Name<input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></label>
                  <label>Notiz<textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} /></label>
                  <div className="row"><button className="primary" onClick={() => save(p.id)}>Speichern</button><button className="ghost" onClick={() => setEdit(null)}>Abbrechen</button></div>
                </div>
              ) : (
                <>
                  <div className="what">
                    <b>{p.name}{live && <em className="rec"> ● läuft</em>}{p.source === 'import' && <em> importiert</em>}</b>
                    <small>
                      {day(p.created_at)} · {live ? 'Aufnahme läuft' : clock(p.duration)} · {live ? '' : size(p.bytes) + ' · '}
                      {(p.meta.agents || []).map((a) => <i key={a.id} style={{ background: a.color }} title={`${a.name}${a.model ? ' · ' + a.model : ''}`} />)}
                      {' '}{(p.meta.agents || []).map((a) => a.name).join(', ') || 'keine Agenten'}
                    </small>
                    {p.note && <small className="note-line">{p.note}</small>}
                  </div>
                  <div className="row">
                    <button className="primary" disabled={live} onClick={() => onPlay(p.id)} title="Abspielen">▶</button>
                    <button className="ghost" onClick={() => { setEdit(p.id); setName(p.name); setNote(p.note); }} title="Name und Notiz bearbeiten">✎</button>
                    <a className={`btn ghost${live ? ' off' : ''}`} href={live ? undefined : `/api/plays/${p.id}/export`} download title="Als Datei exportieren">⬇</a>
                    <button className="ghost" disabled={live} onClick={() => remove(p)} title="Löschen">✕</button>
                  </div>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const KINDS = [
  { kind: 'cube', label: 'Würfel', lift: 0.6 },
  { kind: 'rock', label: 'Fels', lift: 0.9 },
  { kind: 'ring', label: 'Ring', lift: 0.4 },
] as const;

/** Eingriffe in die laufende Welt: Dinge setzen oder entfernen, den Agenten etwas zurufen. */
export function WorldTools({ scene, onClose, onError }: { scene: RefObject<Scene | null>; onClose: () => void; onError: (m: string) => void }) {
  const [mode, setMode] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [said, setSaid] = useState('');

  useEffect(() => {
    const s = scene.current;
    if (!s) return;
    s.setPickMode(mode === null ? null : mode === 'remove' ? 'object' : 'ground');
    s.onPick = (hit) => {
      const k = KINDS.find((x) => x.kind === mode);
      if (k && hit.point) api('/api/world/objects', 'POST', { kind: k.kind, position: [hit.point[0], hit.point[1] + k.lift, hit.point[2]] }).catch((e) => onError(e.message));
      else if (mode === 'remove' && hit.objId !== undefined) api(`/api/world/objects/${hit.objId}`, 'DELETE').catch((e) => onError(e.message));
    };
    return () => { s.setPickMode(null); s.onPick = null; };
  }, [mode, scene, onError]);

  const say = async () => {
    if (!text.trim()) return;
    try {
      const r = await api('/api/world/say', 'POST', { text });
      setSaid(r.heard_by?.length ? `Gehört von ${r.heard_by.join(', ')}.` : 'Niemand ist auf der Insel.');
      setText('');
    } catch (e: any) { onError(e.message); }
  };

  return (
    <section className="glass worldtools" aria-label="In die Welt eingreifen">
      <div className="panel-head">
        <h2>Welt</h2>
        <button className="ghost" onClick={onClose} aria-label="Schliessen">✕</button>
      </div>
      <div className="tools">
        <span>Setzen</span>
        <div className="seg">
          {KINDS.map((k) => <button key={k.kind} className={mode === k.kind ? 'on' : ''} onClick={() => setMode(mode === k.kind ? null : k.kind)}>{k.label}</button>)}
        </div>
        <button className={`ghost${mode === 'remove' ? ' danger' : ''}`} onClick={() => setMode(mode === 'remove' ? null : 'remove')}>Entfernen</button>
      </div>
      <p className="hint">
        {mode === null ? 'Wähle, was du setzen willst, und klicke dann in die Welt.' : mode === 'remove' ? 'Klicke ein Ding an, um es zu entfernen. Nochmals „Entfernen" beendet den Modus.' : 'Klicke auf eine Stelle. Jeder Klick setzt ein weiteres Ding; ein zweiter Klick auf den Knopf beendet den Modus.'}
      </p>
      <div className="tools">
        <span>Stimme</span>
        <input value={text} onChange={(e) => { setText(e.target.value); setSaid(''); }} onKeyDown={(e) => e.key === 'Enter' && say()} placeholder="Allen Agenten etwas zurufen …" />
        <button className="ghost" onClick={say} disabled={!text.trim()}>Senden</button>
      </div>
      <p className="hint">{said || 'Alle hören die Stimme, egal wie weit sie weg sind. Gesetzte Dinge verschwinden beim nächsten Welt-Reset.'}</p>
    </section>
  );
}
