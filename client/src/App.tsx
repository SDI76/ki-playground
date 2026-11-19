import { useCallback, useEffect, useRef, useState } from 'react';
import { Scene, type Snap } from './scene';
import { AgentPanel } from './AgentPanel';
import { Bubbles, Notes, type Note } from './Overlays';
import { PlaysPanel, ReplayBar, WorldTools, type PlayData } from './Plays';

export interface AgentInfo {
  id: string; name: string; color: string; token: string;
  runner: 'extern' | 'api' | 'claude' | 'codex';
  baseUrl: string; model: string; hasKey: boolean;
  beginPrompt: string; continuePrompt: string; sessionMinutes: number;
  running: boolean;
  usage: Usage | null;
}
export interface Usage { input: number; cacheRead: number; cacheWrite: number; output: number; cost: number }
export interface LogEntry { wall: number; time: number; kind: string; text: string }

export async function api<T = any>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Fehler ${res.status}`);
  return data;
}

export const RUNNER_LABEL = { extern: 'Extern (API / MCP)', api: 'Modell über Endpunkt', claude: 'Claude Code', codex: 'Codex' } as const;
type PhysValues = { weight: number; friction: number; spin: number; gravity: number; walk: number; jump: number };
type PhysState = { now: PhysValues; def: PhysValues; range: Record<keyof PhysValues, [number, number]> };
const one = (v: number) => v.toFixed(1).replace('.', ',');
const PHYS_FIELDS: { key: keyof PhysValues; label: string; step: number; fmt: (v: number) => string; tip: string }[] = [
  { key: 'weight', label: 'Gewicht der Objekte', step: 0.5, fmt: (v) => `${one(v)}×`, tip: 'Schwere Würfel lassen sich schlechter wegschieben und umwerfen. Tragen und Werfen bleiben gleich.' },
  { key: 'friction', label: 'Reibung', step: 0.05, fmt: (v) => v.toFixed(2).replace('.', ','), tip: 'Wie stark Objekte am Boden und aneinander haften.' },
  { key: 'spin', label: 'Kippträgheit', step: 0.1, fmt: one, tip: 'Bremst Drehungen. Hohe Werte lassen Objekte träger kippen und rollen.' },
  { key: 'gravity', label: 'Schwerkraft', step: 1, fmt: (v) => String(Math.round(v)), tip: 'Gilt für alles, auch für Sprünge und Würfe.' },
  { key: 'walk', label: 'Lauftempo', step: 0.5, fmt: one, tip: 'Einheiten pro Sekunde.' },
  { key: 'jump', label: 'Sprungkraft', step: 0.5, fmt: one, tip: 'Startgeschwindigkeit nach oben.' },
];
const STATE_LABEL: Record<string, string> = { wait: 'wartet', think: 'überlegt', away: 'abwesend' };
const STATE_TIP: Record<string, string> = {
  wait: 'Steht in einem Wait – bereit, dass die Zeit weiterläuft',
  think: 'Überlegt – die Welt wartet auf diesen Agenten',
  away: 'Hat sich zu lange nicht gerührt – die Welt wartet nicht mehr auf ihn',
};
const SPEEDS = [0.25, 0.5, 1, 2, 4, 8];
const COLORS = ['#b6e23a', '#ff8a5c', '#5cc8ff', '#f4d35e', '#d78bff', '#ff6f91'];

const short = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 1 : 2) + 'M' : n >= 1000 ? (n / 1000).toFixed(n >= 1e5 ? 0 : 1) + 'k' : String(n));
const full = (n: number) => n.toLocaleString('de-CH');

function UsageLine({ u }: { u: Usage }) {
  const read = u.input + u.cacheRead + u.cacheWrite;
  const tip = [
    `neu: ${full(u.input + u.cacheWrite)} Tokens – erstmals vom Modell gelesen`,
    `  davon in den Cache geschrieben: ${full(u.cacheWrite)}`,
    `Cache: ${full(u.cacheRead)} Tokens – bereits bekannter Kontext, bei jeder Anfrage erneut mitgeschickt (rund ein Zehntel des Preises)`,
    `aus: ${full(u.output)} Tokens – vom Modell geschrieben`,
    `Summe gelesen: ${full(read)} Tokens`,
    u.cost > 0 ? `Kosten laut Claude Code: ${u.cost.toFixed(2)} USD (abgeschlossene Läufe)` : '',
  ].filter(Boolean).join('\n');
  return <small className="usage" title={tip}>{short(u.input + u.cacheWrite)} neu · {short(u.cacheRead)} Cache · {short(u.output)} aus</small>;
}

function clock(s: number) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = Math.floor(s % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

export function App() {
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<Scene | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [baseUrl, setBaseUrl] = useState('');
  const [meta, setMeta] = useState({ time: 0, paused: true, speed: 1, resetIn: null as number | null, hold: [] as string[], states: {} as Record<string, string | null> });
  const [lockstep, setLockstep] = useState(false);
  const [hearRange, setHearRange] = useState(30);
  const [resetMin, setResetMin] = useState(60);
  const [rockShape, setRockShape] = useState('block');
  const [phys, setPhys] = useState<PhysState | null>(null);
  const [menu, setMenu] = useState<'physics' | 'plays' | 'world' | null>(null);
  const physOpen = menu === 'physics';
  const setPhysOpen = (f: (v: boolean) => boolean) => setMenu((m) => (f(m === 'physics') ? 'physics' : null));
  // Aufnahme und Replay; canRecord fehlt, solange der Server noch ohne diese Funktion läuft
  const [canRecord, setCanRecord] = useState(false);
  const [autoRecord, setAutoRecord] = useState(false);
  const [recording, setRecording] = useState<{ id: number; name: string; simStart: number } | null>(null);
  const [replay, setReplay] = useState<PlayData | null>(null);
  const replaying = useRef(false);
  replaying.current = !!replay;
  const physTimer = useRef<number | undefined>(undefined);
  const physPending = useRef<Partial<PhysValues> | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [follow, setFollow] = useState(false);
  const [adding, setAdding] = useState(false);
  const [listOpen, setListOpen] = useState(() => { try { return localStorage.getItem('agentList') !== 'closed'; } catch { return true; } });
  const toggleList = () => setListOpen((v) => { try { localStorage.setItem('agentList', v ? 'closed' : 'open'); } catch {} return !v; });
  const [online, setOnline] = useState(false);
  const [error, setError] = useState('');
  const logSubs = useRef(new Set<(id: string, e: LogEntry) => void>());
  const noteSubs = useRef(new Set<(n: Note) => void>());

  const load = useCallback(async () => {
    const s = await api('/api/state');
    setAgents(s.agents);
    setBaseUrl(s.baseUrl);
    setResetMin(s.world.resetIntervalMin);
    setRockShape(s.world.rockShape);
    setLockstep(!!s.world.lockstep);
    setHearRange(s.world.hearRange ?? 30);
    // fehlt, solange der Server noch ohne Physik-Menü läuft
    setCanRecord('autoRecord' in s.world);
    setAutoRecord(!!s.world.autoRecord);
    setRecording(s.world.recording || null);
    if (replaying.current) return; // die Insel des Replays nicht mit der Live-Insel überschreiben
    setPhys(s.world.physics ? { now: s.world.physics, def: s.world.physicsDefault, range: s.world.physicsRange } : null);
    scene.current?.setStatics(s.statics);
  }, []);

  // Regler sofort anzeigen, zum Server gebündelt schicken
  const setPhysics = (patch: Partial<PhysValues>) => {
    setPhys((p) => (p ? { ...p, now: { ...p.now, ...patch } } : p));
    window.clearTimeout(physTimer.current);
    const pending = { ...(physPending.current || {}), ...patch };
    physPending.current = pending;
    physTimer.current = window.setTimeout(() => { physPending.current = null; control({ physics: pending }); }, 120);
  };

  const guard = useCallback(async (fn: () => Promise<unknown>) => {
    try { setError(''); await fn(); } catch (e: any) { setError(e.message); }
  }, []);

  useEffect(() => {
    scene.current = new Scene(host.current!);
    load().catch((e) => setError(e.message));
    let ws: WebSocket | null = null;
    let closed = false;
    let lastKey = '';
    const connect = () => {
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
      ws.onopen = () => { setOnline(true); load().catch(() => {}); };
      ws.onclose = () => { setOnline(false); if (!closed) setTimeout(connect, 1000); };
      ws.onmessage = (ev) => {
        const m = JSON.parse(ev.data);
        if (m.t === 'snap') {
          if (!replaying.current) scene.current?.apply(m as Snap);
          const states: Record<string, string | null> = {};
          for (const a of m.agents) states[a.id] = a.st ?? null;
          const key = `${Math.floor(m.time)}|${m.paused}|${m.speed}|${m.resetIn}|${(m.hold || []).join()}|${JSON.stringify(states)}`;
          if (key !== lastKey) { lastKey = key; setMeta({ time: m.time, paused: m.paused, speed: m.speed, resetIn: m.resetIn, hold: m.hold || [], states }); }
        } else if (m.t === 'agents') load().catch(() => {});
        else if (replaying.current) return;
        else if (m.t === 'log') logSubs.current.forEach((f) => f(m.id, m.entry));
        else if (m.t === 'usage') setAgents((list) => list.map((a) => (a.id === m.id ? { ...a, usage: m.usage } : a)));
        else if (m.t === 'note') noteSubs.current.forEach((f) => f(m));
      };
    };
    connect();
    return () => { closed = true; ws?.close(); scene.current?.dispose(); scene.current = null; };
  }, [load]);

  useEffect(() => { if (scene.current) scene.current.follow = follow ? selected : null; }, [follow, selected]);

  const control = (body: object) => guard(() => api('/api/control', 'POST', body));
  const shown = replay ? ((replay.play.meta.agents || []) as unknown as AgentInfo[]) : agents;
  const startReplay = (id: number) => guard(async () => {
    const d = await api<PlayData>(`/api/plays/${id}`);
    setMenu(null);
    setSelected(null);
    setReplay(d);
  });
  const exitReplay = () => {
    replaying.current = false;
    setReplay(null);
    load().catch(() => {});
  };
  const sel = agents.find((a) => a.id === selected) || null;
  const fresh = meta.time === 0 && meta.paused;

  return (
    <div className="app">
      <div className="stage" ref={host} />

      <Bubbles scene={scene} agents={shown} logSubs={logSubs.current} />
      <Notes agents={shown} noteSubs={noteSubs.current} onOpen={replay ? () => {} : setSelected} />

      <header className="title">
        <span>{replay ? 'REPLAY' : 'SIMULATION'}</span>
        <span className="dim"> · {replay ? replay.play.name.toUpperCase() : !online ? 'KEINE VERBINDUNG' : fresh ? 'BEREIT' : meta.paused ? 'PAUSIERT' : meta.hold.length ? `STEHT · ${meta.hold.join(', ').toUpperCase()} ÜBERLEGT` : `LÄUFT ${meta.speed}×`}</span>
      </header>

      {!replay && <>
      <aside className={`panel left${listOpen ? '' : ' closed'}`}>
        <div className="panel-head">
          <button className="fold" onClick={toggleList} aria-expanded={listOpen} title={listOpen ? 'Agentenliste einklappen' : 'Agentenliste ausklappen'}>
            <span className="chev">{listOpen ? '▾' : '▸'}</span>
            <h2>Agenten</h2>
            {!listOpen && agents.map((x) => <i key={x.id} style={{ background: x.color }} title={x.name} />)}
          </button>
          {listOpen && <button className="ghost" onClick={() => setAdding((v) => !v)}>{adding ? 'Abbrechen' : '+ Neu'}</button>}
        </div>
        {listOpen && <>
        {adding && <NewAgent count={agents.length} onDone={(id) => { setAdding(false); if (id) setSelected(id); }} onError={setError} />}
        {agents.length === 0 && !adding && <p className="hint">Noch niemand auf der Insel. Leg einen Agenten an, bearbeite seine Dateien und starte dann die Simulation.</p>}
        <ul className="agents">
          {agents.map((a) => (
            <li key={a.id} className={a.id === selected ? 'on' : ''} onClick={() => setSelected(a.id === selected ? null : a.id)}>
              <i style={{ background: a.color }} />
              <div>
                <b>{a.name}</b>
                <small>{RUNNER_LABEL[a.runner]}{a.model ? ` · ${a.model}` : ''}</small>
                {a.usage && <UsageLine u={a.usage} />}
              </div>
              {meta.states[a.id] && !meta.paused
                ? <em className={meta.states[a.id]!} title={STATE_TIP[meta.states[a.id]!]}>{STATE_LABEL[meta.states[a.id]!]}</em>
                : a.runner !== 'extern' && <em className={a.running ? 'live' : ''}>{a.running ? 'aktiv' : 'aus'}</em>}
            </li>
          ))}
        </ul>
        {sel && (
          <label className="check">
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Kamera folgt {sel.name}
          </label>
        )}
        </>}
      </aside>

      {sel && <AgentPanel key={sel.id} agent={sel} baseUrl={baseUrl} logSubs={logSubs.current} onClose={() => setSelected(null)} onError={setError} />}

      <footer className="bar">
        <button className="primary" onClick={() => control({ paused: !meta.paused })}>
          {fresh ? '▶ Start' : meta.paused ? '▶ Weiter' : '❚❚ Pause'}
        </button>
        <div className="seg" role="group" aria-label="Tempo">
          {SPEEDS.map((s) => (
            <button key={s} className={meta.speed === s ? 'on' : ''} onClick={() => control({ speed: s })}>{s}×</button>
          ))}
        </div>
        <div className="time">
          <b>{clock(meta.time)}</b>
          <small>Weltzeit</small>
        </div>
        <div className="time">
          <b>{meta.resetIn === null ? '—' : clock(meta.resetIn)}</b>
          <small>bis Welt-Reset</small>
        </div>
        <label className="num">
          <input type="number" min={0} value={resetMin} onChange={(e) => setResetMin(Number(e.target.value))} onBlur={() => control({ resetIntervalMin: resetMin })} />
          <small>Reset alle … min (0 = nie)</small>
        </label>
        <label className="num">
          <input type="number" min={0} value={hearRange} onChange={(e) => setHearRange(Number(e.target.value))} onBlur={() => control({ hearRange })} />
          <small>Hörweite (0 = überall)</small>
        </label>
        <label className="num">
          <select value={lockstep ? '1' : '0'} onChange={(e) => { setLockstep(e.target.value === '1'); control({ lockstep: e.target.value === '1' }); }}>
            <option value="0">Echtzeit</option>
            <option value="1">Wenn alle warten</option>
          </select>
          <small>Zeit läuft</small>
        </label>
        {!phys && (
          <label className="num">
            <select value={rockShape} onChange={(e) => { setRockShape(e.target.value); control({ rockShape: e.target.value }); }}>
              <option value="block">Block</option>
              <option value="ball">Kugel, rollt</option>
            </select>
            <small>Form des Felsens</small>
          </label>
        )}
        {canRecord && <>
          <label className="check auto" title="Nimmt jeden Durchgang automatisch auf. Ein Welt-Reset beginnt ein neues Play.">
            <input type="checkbox" checked={autoRecord} onChange={(e) => { setAutoRecord(e.target.checked); control({ autoRecord: e.target.checked }); }} /> Autorecord
          </label>
          <button className={`ghost recbtn${recording ? ' on' : ''}`} onClick={() => guard(() => api('/api/record', 'POST', { on: !recording }))} title={recording ? `Aufnahme „${recording.name}" beenden` : 'Aufnahme von Hand starten'}>
            {recording ? `■ Stopp ${clock(Math.max(0, meta.time - recording.simStart))}` : '● Aufnahme'}
          </button>
          <button className={`ghost${menu === 'plays' ? ' on' : ''}`} onClick={() => setMenu((m) => (m === 'plays' ? null : 'plays'))}>Plays</button>
          <button className={`ghost${menu === 'world' ? ' on' : ''}`} onClick={() => setMenu((m) => (m === 'world' ? null : 'world'))} title="Dinge in die Welt setzen, den Agenten etwas zurufen">＋ Welt</button>
        </>}
        {phys && <button className={`ghost gear${physOpen ? ' on' : ''}`} onClick={() => setPhysOpen((v) => !v)} aria-expanded={physOpen} title="Spielphysik">⚙</button>}
        <button className="ghost" onClick={() => confirm('Welt jetzt zurücksetzen? Objekte und Körper gehen auf Anfang, die Dateien der Agenten bleiben.') && guard(() => api('/api/reset', 'POST'))}>Welt zurücksetzen</button>
      </footer>
      </>}

      {replay && <ReplayBar scene={scene} data={replay} logSubs={logSubs.current} noteSubs={noteSubs.current} onExit={exitReplay} />}
      {!replay && menu === 'plays' && <PlaysPanel onPlay={startReplay} onClose={() => setMenu(null)} onError={setError} recordingId={recording?.id ?? null} version={agents.length} />}
      {!replay && menu === 'world' && <WorldTools scene={scene} onClose={() => setMenu(null)} onError={setError} />}

      {!replay && phys && physOpen && (
        <section className="physics" aria-label="Spielphysik">
          <div className="panel-head">
            <h2>Spielphysik</h2>
            <div className="row">
              <button className="ghost" onClick={() => setPhysics({ ...phys.def })}>Standard</button>
              <button className="ghost" onClick={() => setMenu(null)} aria-label="Schliessen">✕</button>
            </div>
          </div>
          {PHYS_FIELDS.map((f) => (
            <label key={f.key} className="slider" title={f.tip}>
              <span>{f.label}</span>
              <input type="range" min={phys.range[f.key][0]} max={phys.range[f.key][1]} step={f.step} value={phys.now[f.key]}
                onChange={(e) => setPhysics({ [f.key]: Number(e.target.value) })} />
              <b>{f.fmt(phys.now[f.key])}</b>
            </label>
          ))}
          <label className="slider">
            <span>Form des Felsens</span>
            <select value={rockShape} onChange={(e) => { setRockShape(e.target.value); control({ rockShape: e.target.value }); }}>
              <option value="block">Block</option>
              <option value="ball">Kugel, rollt</option>
            </select>
            <b />
          </label>
          <p className="hint">Wirkt sofort, auch während die Simulation läuft. Was Agenten über Tempo und Sprunghöhe notiert haben, stimmt nach einer Änderung nicht mehr.</p>
        </section>
      )}

      {error && <div className="toast" onClick={() => setError('')}>{error}</div>}
    </div>
  );
}

function NewAgent({ count, onDone, onError }: { count: number; onDone: (id?: string) => void; onError: (m: string) => void }) {
  const [name, setName] = useState(`Eko${count + 1}`);
  const [color, setColor] = useState(COLORS[count % COLORS.length]);
  const [runner, setRunner] = useState<AgentInfo['runner']>('claude');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const a = await api('/api/agents', 'POST', { name, color, runner, baseUrl, apiKey, model });
      onDone(a.id);
    } catch (err: any) { onError(err.message); }
  };
  return (
    <form className="form" onSubmit={submit}>
      <div className="row">
        <label className="grow">Name<input value={name} onChange={(e) => setName(e.target.value)} required /></label>
        <label>Farbe<input type="color" value={color} onChange={(e) => setColor(e.target.value)} /></label>
      </div>
      <RunnerFields {...{ runner, setRunner, baseUrl, setBaseUrl, apiKey, setApiKey, model, setModel }} />
      <button className="primary" type="submit">Anlegen</button>
    </form>
  );
}

export function RunnerFields(p: {
  runner: AgentInfo['runner']; setRunner: (r: AgentInfo['runner']) => void;
  baseUrl: string; setBaseUrl: (s: string) => void;
  apiKey: string; setApiKey: (s: string) => void; keyHint?: string;
  model: string; setModel: (s: string) => void;
}) {
  return (
    <>
      <label>Gesteuert von
        <select value={p.runner} onChange={(e) => p.setRunner(e.target.value as AgentInfo['runner'])}>
          <option value="claude">Claude Code (headless, in der Sandbox)</option>
          <option value="codex">Codex (headless, in der Sandbox)</option>
          <option value="api">Modell über Endpunkt und Token</option>
          <option value="extern">Extern – verbindet sich selbst per API oder MCP</option>
        </select>
      </label>
      {p.runner === 'api' && (
        <>
          <label>Endpunkt (OpenAI-kompatibel)<input value={p.baseUrl} onChange={(e) => p.setBaseUrl(e.target.value)} placeholder="http://localhost:11434/v1" /></label>
          <label>Token<input type="password" value={p.apiKey} onChange={(e) => p.setApiKey(e.target.value)} placeholder={p.keyHint || 'leer lassen, falls keiner nötig ist'} autoComplete="off" /></label>
        </>
      )}
      {p.runner !== 'extern' && (
        <label>Modell<input value={p.model} onChange={(e) => p.setModel(e.target.value)} placeholder={p.runner === 'claude' ? 'leer = Standard, z. B. sonnet' : p.runner === 'codex' ? 'leer = Standard von Codex' : 'z. B. llama3.3'} /></label>
      )}
    </>
  );
}
