import { DatabaseSync } from 'node:sqlite';
import zlib from 'node:zlib';

// Nimmt einen Durchgang ("Play") auf: Bilder der Welt und Ereignisse der Agenten, in einer SQLite-Datei.
// Bilder werden als Differenz gespeichert (nur was sich bewegt hat), mit einem vollen Bild alle KEY Sekunden.

const KEY = 20; // Sekunden Weltzeit zwischen zwei vollen Bildern
const FORMAT = 'ki-playground-play';

export interface PlayRow {
  id: number; name: string; note: string; created_at: string; ended_at: string | null;
  duration: number; frames: number; events: number; bytes: number; source: string; meta: any;
}

type Snap = {
  time: number;
  agents: { id: string; name: string; color: string; p: number[]; yaw: number; holding: number | null; moving: boolean; grounded: boolean }[];
  objs: { id: number; kind: string; name: string; s?: string; p: number[]; q: number[] }[];
};

export class Recorder {
  private db: DatabaseSync;
  current: { id: number; name: string; simStart: number } | null = null;
  private frames: [number, string][] = [];
  private events: [number, string, string, string][] = [];
  private last = new Map<string, string>();
  private lastKey = -Infinity;

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS plays (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL, ended_at TEXT, duration REAL NOT NULL DEFAULT 0,
        frames INTEGER NOT NULL DEFAULT 0, events INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL DEFAULT 0,
        source TEXT NOT NULL DEFAULT 'aufnahme', meta TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS frames (play_id INTEGER NOT NULL, t REAL NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS frames_play ON frames (play_id, t);
      CREATE TABLE IF NOT EXISTS events (play_id INTEGER NOT NULL, t REAL NOT NULL, kind TEXT NOT NULL, agent TEXT NOT NULL, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_play ON events (play_id, t);
    `);
    // Aufnahmen, die ein Absturz offen gelassen hat, sauber abschliessen
    for (const r of this.db.prepare('SELECT id FROM plays WHERE ended_at IS NULL').all() as { id: number }[]) this.finish(r.id, null);
  }

  private row(r: any): PlayRow {
    let meta: any = {};
    try { meta = JSON.parse(r.meta); } catch {}
    return { ...r, meta };
  }

  list(): PlayRow[] {
    return (this.db.prepare('SELECT * FROM plays ORDER BY id DESC').all() as any[]).map((r) => {
      const p = this.row(r);
      // die Insel selbst gehört nicht in die Liste
      return { ...p, meta: { ...p.meta, statics: undefined } };
    });
  }

  get(id: number): PlayRow {
    const r = this.db.prepare('SELECT * FROM plays WHERE id = ?').get(id);
    if (!r) throw new Error('Dieses Play gibt es nicht.');
    return this.row(r);
  }

  start(name: string, simTime: number, meta: unknown): PlayRow {
    if (this.current) this.stop(simTime);
    const res = this.db.prepare('INSERT INTO plays (name, created_at, meta) VALUES (?, ?, ?)').run(name, new Date().toISOString(), JSON.stringify(meta));
    this.current = { id: Number(res.lastInsertRowid), name, simStart: simTime };
    this.last.clear();
    this.lastKey = -Infinity;
    return this.get(this.current.id);
  }

  stop(simTime: number) {
    if (!this.current) return;
    const { id, simStart } = this.current;
    this.flush();
    this.current = null;
    this.finish(id, simTime - simStart);
  }

  private finish(id: number, duration: number | null) {
    const s = this.db.prepare(
      'SELECT (SELECT COUNT(*) FROM frames WHERE play_id = ?1) AS f, (SELECT COUNT(*) FROM events WHERE play_id = ?1) AS e, ' +
      '(SELECT COALESCE(SUM(LENGTH(data)), 0) FROM frames WHERE play_id = ?1) + (SELECT COALESCE(SUM(LENGTH(data)), 0) FROM events WHERE play_id = ?1) AS b, ' +
      '(SELECT COALESCE(MAX(t), 0) FROM frames WHERE play_id = ?1) AS d',
    ).get(id) as any;
    this.db.prepare('UPDATE plays SET ended_at = COALESCE(ended_at, ?), duration = ?, frames = ?, events = ?, bytes = ? WHERE id = ?')
      .run(new Date().toISOString(), Math.round(Math.max(duration ?? 0, s.d) * 100) / 100, s.f, s.e, s.b, id);
  }

  /** Ein Bild der Welt. Gespeichert wird nur, was sich seit dem letzten Bild geändert hat. */
  frame(snap: Snap) {
    if (!this.current) return;
    const t = Math.round((snap.time - this.current.simStart) * 100) / 100;
    const key = t - this.lastKey >= KEY;
    if (key) { this.last.clear(); this.lastKey = t; }
    const f: any = key ? { k: 1 } : {};
    const seen = new Set<string>();
    for (const a of snap.agents) {
      const id = 'a' + a.id;
      seen.add(id);
      const sig = JSON.stringify([...a.p, a.yaw, a.holding, a.moving ? 1 : 0, a.grounded ? 1 : 0]);
      if (!this.last.has(id)) (f.am ??= {})[a.id] = [a.name, a.color];
      if (this.last.get(id) !== sig) { (f.a ??= {})[a.id] = JSON.parse(sig); this.last.set(id, sig); }
    }
    for (const o of snap.objs) {
      const id = 'o' + o.id;
      seen.add(id);
      const meta = JSON.stringify([o.kind, o.name, o.s || '']);
      if (this.last.get(id + 'm') !== meta) { (f.m ??= {})[o.id] = JSON.parse(meta); this.last.set(id + 'm', meta); }
      const sig = JSON.stringify([...o.p, ...o.q]);
      if (this.last.get(id) !== sig) { (f.o ??= {})[o.id] = JSON.parse(sig); this.last.set(id, sig); }
    }
    for (const id of [...this.last.keys()]) {
      if (id.endsWith('m') && id[0] === 'o') continue;
      if (seen.has(id)) continue;
      this.last.delete(id);
      this.last.delete(id + 'm');
      if (id[0] === 'o') (f.x ??= []).push(Number(id.slice(1)));
      else (f.ax ??= []).push(id.slice(1));
    }
    if (Object.keys(f).length) this.frames.push([t, JSON.stringify(f)]);
    if (this.frames.length >= 40) this.flush();
  }

  event(simTime: number, kind: string, agent: string, data: unknown) {
    if (!this.current) return;
    this.events.push([Math.round((simTime - this.current.simStart) * 100) / 100, kind, agent, JSON.stringify(data)]);
  }

  flush() {
    if (!this.current || (!this.frames.length && !this.events.length)) return;
    const id = this.current.id;
    const fi = this.db.prepare('INSERT INTO frames (play_id, t, data) VALUES (?, ?, ?)');
    const ei = this.db.prepare('INSERT INTO events (play_id, t, kind, agent, data) VALUES (?, ?, ?, ?, ?)');
    this.db.exec('BEGIN');
    try {
      for (const [t, d] of this.frames) fi.run(id, t, d);
      for (const [t, k, a, d] of this.events) ei.run(id, t, k, a, d);
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); throw e; }
    this.frames = [];
    this.events = [];
  }

  update(id: number, patch: { name?: unknown; note?: unknown }) {
    const p = this.get(id);
    const name = typeof patch.name === 'string' && patch.name.trim() ? patch.name.trim().slice(0, 120) : p.name;
    const note = typeof patch.note === 'string' ? patch.note.slice(0, 2000) : p.note;
    this.db.prepare('UPDATE plays SET name = ?, note = ? WHERE id = ?').run(name, note, id);
    if (this.current?.id === id) this.current.name = name;
    return this.get(id);
  }

  remove(id: number) {
    if (this.current?.id === id) throw new Error('Dieses Play wird gerade aufgenommen. Erst die Aufnahme stoppen.');
    this.get(id);
    this.db.prepare('DELETE FROM frames WHERE play_id = ?').run(id);
    this.db.prepare('DELETE FROM events WHERE play_id = ?').run(id);
    this.db.prepare('DELETE FROM plays WHERE id = ?').run(id);
  }

  /** Alles, was die Replay-Ansicht braucht. */
  full(id: number) {
    if (this.current?.id === id) this.flush();
    const play = this.get(id);
    const frames = (this.db.prepare('SELECT t, data FROM frames WHERE play_id = ? ORDER BY t, rowid').all(id) as any[]).map((r) => [r.t, JSON.parse(r.data)]);
    const events = (this.db.prepare('SELECT t, kind, agent, data FROM events WHERE play_id = ? ORDER BY t, rowid').all(id) as any[]).map((r) => [r.t, r.kind, r.agent, JSON.parse(r.data)]);
    return { play, frames, events };
  }

  /** Ein Play als einzelne, komprimierte Datei zum Weitergeben. */
  exportFile(id: number): Buffer {
    const { play, frames, events } = this.full(id);
    const { id: _id, bytes: _b, source: _s, ...rest } = play;
    return zlib.gzipSync(JSON.stringify({ format: FORMAT, version: 1, play: rest, frames, events }));
  }

  importFile(buf: Buffer): PlayRow {
    let d: any;
    try { d = JSON.parse(zlib.gunzipSync(buf).toString('utf8')); } catch { throw new Error('Das ist keine Play-Datei (oder sie ist beschädigt).'); }
    if (d?.format !== FORMAT || !Array.isArray(d.frames) || !Array.isArray(d.events) || !d.play) throw new Error('Das ist keine Play-Datei.');
    if (d.version !== 1) throw new Error(`Diese Play-Datei hat Version ${d.version}; unterstützt wird Version 1.`);
    const p = d.play;
    const res = this.db.prepare('INSERT INTO plays (name, note, created_at, ended_at, duration, source, meta) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(String(p.name || 'Importiertes Play').slice(0, 120), String(p.note || '').slice(0, 2000), String(p.created_at || new Date().toISOString()),
        String(p.ended_at || new Date().toISOString()), Number(p.duration) || 0, 'import', JSON.stringify(p.meta || {}));
    const id = Number(res.lastInsertRowid);
    const fi = this.db.prepare('INSERT INTO frames (play_id, t, data) VALUES (?, ?, ?)');
    const ei = this.db.prepare('INSERT INTO events (play_id, t, kind, agent, data) VALUES (?, ?, ?, ?, ?)');
    this.db.exec('BEGIN');
    try {
      for (const f of d.frames) fi.run(id, Number(f[0]) || 0, JSON.stringify(f[1] ?? {}));
      for (const e of d.events) ei.run(id, Number(e[0]) || 0, String(e[1]), String(e[2]), JSON.stringify(e[3] ?? null));
      this.db.exec('COMMIT');
    } catch (e) { this.db.exec('ROLLBACK'); this.db.prepare('DELETE FROM plays WHERE id = ?').run(id); throw e; }
    this.finish(id, Number(p.duration) || 0);
    return this.get(id);
  }

  close() {
    try { this.db.close(); } catch {}
  }
}
