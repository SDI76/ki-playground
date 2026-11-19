import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { SOUL, SEMANTIC, EPISODIC, BEGIN, CONTINUE, apiMd } from './templates.ts';

export type RunnerType = 'extern' | 'api' | 'claude' | 'codex';

export interface Agent {
  id: string;
  name: string;
  color: string;
  token: string;
  runner: RunnerType;
  baseUrl: string; // OpenAI-kompatibler Endpunkt (runner = api)
  apiKey: string;
  model: string;
  beginPrompt: string;
  continuePrompt: string;
  sessionMinutes: number; // Weltzeit, nach der der Kontext geleert wird
}

/** Summierter Tokenverbrauch eines Agenten über alle Sitzungen. */
export interface Usage {
  input: number; // neu gelesene Eingabe-Tokens
  cacheRead: number; // Eingabe aus dem Cache (deutlich günstiger)
  cacheWrite: number; // Eingabe, die in den Cache geschrieben wurde
  output: number;
  cost: number; // USD, soweit der Harness sie meldet
}

export interface LogEntry {
  wall: number;
  time: number;
  kind: 'text' | 'say' | 'tool' | 'result' | 'system' | 'error';
  text: string;
}

export const DATA_ROOT = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.resolve(import.meta.dirname, '..', 'data');
const ROOT = DATA_ROOT;
const FILE = path.join(ROOT, 'agents.json');
const WS = path.join(ROOT, 'workspaces');
const LOGS = path.join(ROOT, 'logs');
const USAGE = path.join(ROOT, 'usage.json');

export class AgentStore {
  agents: Agent[] = [];
  private logs = new Map<string, LogEntry[]>();
  onLog: ((id: string, e: LogEntry) => void) | null = null;
  onUsage: ((id: string, u: Usage) => void) | null = null;
  private usage = new Map<string, Usage>();
  private usageTimer: NodeJS.Timeout | null = null;
  /** Meldet, was ein Agent gerade in eine seiner Dateien geschrieben hat. */
  onNote: ((id: string, path: string, text: string, isNew: boolean) => void) | null = null;
  private seen = new Map<string, Map<string, { mtime: number; content: string }>>();

  constructor(private baseUrl: string) {
    fs.mkdirSync(WS, { recursive: true });
    fs.mkdirSync(LOGS, { recursive: true });
    if (fs.existsSync(FILE)) this.agents = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    try { this.usage = new Map(Object.entries(JSON.parse(fs.readFileSync(USAGE, 'utf8')))); } catch { /* noch kein Verbrauch */ }
    for (const a of this.agents) this.ensureWorkspace(a);
  }

  private save() {
    fs.writeFileSync(FILE, JSON.stringify(this.agents, null, 2));
  }

  dir(a: Agent) {
    return path.join(WS, a.id);
  }

  private ensureWorkspace(a: Agent) {
    const d = this.dir(a);
    fs.mkdirSync(d, { recursive: true });
    const put = (name: string, content: string) => {
      const f = path.join(d, name);
      if (!fs.existsSync(f)) fs.writeFileSync(f, content);
    };
    put('SOUL.md', SOUL);
    put('SEMANTIC_MEMORY.md', SEMANTIC);
    put('EPISODIC_MEMORY.md', EPISODIC);
    put('EPISODIC_MEMORY.jsonl', '');
    // API.md enthält Token und Adresse und wird immer frisch geschrieben
    fs.writeFileSync(path.join(d, 'API.md'), apiMd(this.baseUrl, a.token));
    this.scanAgent(a, true);
  }

  /** Vergleicht die Dateien aller Agenten mit dem letzten Stand und meldet Neues. */
  scan() {
    for (const a of this.agents) {
      try { this.scanAgent(a, false); } catch { /* Datei mitten im Schreiben – nächste Runde */ }
    }
  }

  private scanAgent(a: Agent, silent: boolean) {
    let known = this.seen.get(a.id);
    if (!known) this.seen.set(a.id, (known = new Map()));
    for (const f of this.listFiles(a)) {
      if (f.path === 'API.md' || f.size > 300_000) continue;
      const old = known.get(f.path);
      if (old && old.mtime === f.mtime) continue;
      const content = fs.readFileSync(path.join(this.dir(a), f.path), 'utf8');
      known.set(f.path, { mtime: f.mtime, content });
      if (silent || content === old?.content) continue;
      const text = describeChange(old?.content, content, f.path);
      if (text) this.onNote?.(a.id, f.path, text, !old);
    }
  }

  create(input: Partial<Agent>): Agent {
    const name = (input.name || '').trim() || `Eko${this.agents.length + 1}`;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent';
    let id = slug;
    for (let i = 2; this.agents.some((a) => a.id === id) || fs.existsSync(path.join(WS, id)); i++) id = `${slug}-${i}`;
    const a: Agent = {
      id,
      name,
      color: input.color || '#b6e23a',
      token: crypto.randomBytes(18).toString('base64url'),
      runner: input.runner || 'extern',
      baseUrl: input.baseUrl || '',
      apiKey: input.apiKey || '',
      model: input.model || '',
      beginPrompt: input.beginPrompt || BEGIN,
      continuePrompt: input.continuePrompt || CONTINUE,
      sessionMinutes: input.sessionMinutes ?? 60,
    };
    this.agents.push(a);
    this.ensureWorkspace(a);
    this.save();
    return a;
  }

  update(id: string, patch: Partial<Agent>): Agent {
    const a = this.get(id);
    const allowed: (keyof Agent)[] = ['name', 'color', 'runner', 'baseUrl', 'apiKey', 'model', 'beginPrompt', 'continuePrompt', 'sessionMinutes'];
    for (const k of allowed) if (patch[k] !== undefined) (a as any)[k] = patch[k];
    this.save();
    return a;
  }

  /** Entfernt den Agenten aus der Liste. Der Arbeitsordner bleibt auf der Platte liegen. */
  remove(id: string) {
    this.agents = this.agents.filter((a) => a.id !== id);
    this.save();
  }

  get(id: string): Agent {
    const a = this.agents.find((x) => x.id === id);
    if (!a) throw new Error('Agent nicht gefunden');
    return a;
  }

  byToken(token: string | undefined): Agent | undefined {
    return token ? this.agents.find((a) => a.token === token) : undefined;
  }

  // ---------- Dateien ----------

  private safe(a: Agent, rel: string): string {
    const root = this.dir(a);
    const f = path.resolve(root, rel);
    if (f !== root && !f.startsWith(root + path.sep)) throw new Error('Pfad liegt ausserhalb des Arbeitsordners');
    return f;
  }

  listFiles(a: Agent): { path: string; size: number; mtime: number }[] {
    const root = this.dir(a);
    const out: { path: string; size: number; mtime: number }[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        const f = path.join(d, e.name);
        if (e.isDirectory()) walk(f);
        else {
          const st = fs.statSync(f);
          out.push({ path: path.relative(root, f), size: st.size, mtime: st.mtimeMs });
        }
      }
    };
    walk(root);
    return out.sort((x, y) => x.path.localeCompare(y.path));
  }

  readFile(a: Agent, rel: string): string {
    const f = this.safe(a, rel);
    if (fs.statSync(f).size > 2_000_000) throw new Error('Datei ist zu gross zum Anzeigen');
    return fs.readFileSync(f, 'utf8');
  }

  /** silent = Änderung stammt von dir aus der Weboberfläche und soll keine Notiz-Meldung auslösen. */
  writeFile(a: Agent, rel: string, content: string, silent = false) {
    const f = this.safe(a, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content);
    if (silent) this.seen.get(a.id)?.set(path.relative(this.dir(a), f), { mtime: fs.statSync(f).mtimeMs, content });
  }

  appendFile(a: Agent, rel: string, content: string) {
    const f = this.safe(a, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, content.endsWith('\n') ? content : content + '\n');
  }

  // ---------- Verbrauch ----------

  getUsage(id: string): Usage | null {
    return this.usage.get(id) || null;
  }

  addUsage(id: string, d: Partial<Usage>) {
    const u = this.usage.get(id) || { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, cost: 0 };
    for (const k of Object.keys(u) as (keyof Usage)[]) u[k] = Math.max(0, u[k] + (Number(d[k]) || 0));
    this.usage.set(id, u);
    this.onUsage?.(id, u);
    this.usageTimer ??= setTimeout(() => { this.usageTimer = null; this.saveUsage(); }, 2000);
  }

  saveUsage() {
    fs.writeFileSync(USAGE, JSON.stringify(Object.fromEntries(this.usage), null, 2));
  }

  // ---------- Protokoll ----------

  log(id: string, time: number, kind: LogEntry['kind'], text: string) {
    const e: LogEntry = { wall: Date.now(), time: Math.round(time * 10) / 10, kind, text: text.length > 6000 ? text.slice(0, 6000) + ' …' : text };
    let l = this.logs.get(id);
    if (!l) this.logs.set(id, (l = []));
    l.push(e);
    if (l.length > 600) l.splice(0, l.length - 600);
    fs.appendFile(path.join(LOGS, `${id}.jsonl`), JSON.stringify(e) + '\n', () => {});
    this.onLog?.(id, e);
  }

  getLog(id: string): LogEntry[] {
    return this.logs.get(id) || [];
  }
}

/** Was ist neu? Angehängter Text, sonst die Zeilen, die es vorher nicht gab. */
function describeChange(old: string | undefined, now: string, file: string): string {
  let added: string;
  if (old === undefined) added = now;
  else if (now.startsWith(old)) added = now.slice(old.length);
  else {
    const had = new Set(old.split('\n'));
    added = now.split('\n').filter((l) => l.trim() && !had.has(l)).join('\n');
    if (!added.trim()) return '(Zeilen entfernt)';
  }
  added = added.trim();
  if (file.endsWith('.jsonl')) {
    added = added.split('\n').map((l) => {
      try {
        const e = JSON.parse(l);
        if (e && typeof e === 'object' && e.summary) return [e.summary, typeof e.detail === 'string' ? e.detail : ''].filter(Boolean).join('\n');
      } catch { /* keine JSON-Zeile */ }
      return l;
    }).join('\n\n');
  }
  return added.length > 900 ? added.slice(0, 900) + ' …' : added;
}
