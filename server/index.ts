import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createVite } from 'vite';
import react from '@vitejs/plugin-react';
import { World, STATICS, PHYSICS_DEFAULT, PHYSICS_RANGE } from './world.ts';
import { AgentStore, DATA_ROOT, type Agent } from './agents.ts';
import { Runners } from './runner.ts';
import { Recorder } from './recorder.ts';
import { TOOLS, runTool, normalizeAction } from './tools.ts';

const PORT = Number(process.env.PORT) || 4710;
const BASE = `http://localhost:${PORT}`;

const world = await World.create();
const store = new AgentStore(BASE);
const runners = new Runners(world, store);
for (const a of store.agents) world.addBody(a.id, a.name, a.color);

// Aufnahmen für das Replay
const recorder = new Recorder(path.join(DATA_ROOT, 'replays.db'));
let autoRecord = false;

// Welt-Einstellungen überdauern einen Neustart
const SETTINGS = path.join(DATA_ROOT, 'settings.json');
try {
  const s = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  if (typeof s.resetIntervalMin === 'number') world.resetIntervalMin = s.resetIntervalMin;
  if (s.rockShape === 'ball' || s.rockShape === 'block') world.setRockShape(s.rockShape);
  if (typeof s.lockstep === 'boolean') world.lockstep = s.lockstep;
  if (typeof s.hearRange === 'number') world.hearRange = s.hearRange;
  if (s.physics && typeof s.physics === 'object') world.setPhysics(s.physics);
  if (typeof s.autoRecord === 'boolean') autoRecord = s.autoRecord;
} catch { /* noch keine gespeichert */ }
const saveSettings = () => fs.writeFileSync(SETTINGS, JSON.stringify({ resetIntervalMin: world.resetIntervalMin, rockShape: world.rockShape, lockstep: world.lockstep, hearRange: world.hearRange, physics: world.physics, autoRecord }, null, 2));

const app = express();
app.use(express.json({ limit: '4mb' }));
const server = http.createServer(app);

// ---------- Live-Verbindung zur Weboberfläche ----------

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (req.url === '/ws') wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
});
const broadcast = (msg: unknown) => {
  const s = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(s);
};
wss.on('connection', (ws) => ws.send(JSON.stringify(world.snapshot())));
store.onLog = (id, entry) => { broadcast({ t: 'log', id, entry }); recorder.event(world.simTime, 'log', id, entry); };
store.onNote = (id, path, text, isNew) => { broadcast({ t: 'note', id, path, text, isNew }); recorder.event(world.simTime, 'note', id, { path, text, isNew }); };

const stamp = () => new Date().toLocaleString('de-CH', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const startRecording = (name?: string) => {
  recorder.start(String(name || '').trim().slice(0, 120) || `Play vom ${stamp()}`, world.simTime, {
    agents: store.agents.map((a) => ({ id: a.id, name: a.name, color: a.color, runner: a.runner, model: a.model })),
    statics: STATICS, physics: { ...world.physics }, rockShape: world.rockShape, hearRange: world.hearRange, lockstep: world.lockstep,
  });
  recorder.frame(world.snapshot());
  broadcast({ t: 'agents' });
};
const stopRecording = () => {
  if (!recorder.current) return;
  recorder.stop(world.simTime);
  broadcast({ t: 'agents' });
};
setInterval(() => store.scan(), 1000);
runners.onChange = () => broadcast({ t: 'agents' });
store.onUsage = (id, usage) => broadcast({ t: 'usage', id, usage });
world.onReset = () => {
  broadcast({ t: 'reset' });
  // jeder Welt-Reset beginnt bei Autorecord ein neues Play
  if (recorder.current && autoRecord) { stopRecording(); startRecording(); }
  else recorder.event(world.simTime, 'reset', '', {});
};

let last = performance.now();
let frame = 0;
let lastRec = 0;
setInterval(() => {
  const now = performance.now();
  world.tick((now - last) / 1000);
  last = now;
  frame++;
  // 20 Bilder pro Sekunde, im Pausenzustand nur gelegentlich
  if (frame % (world.paused ? 30 : 3) === 0) broadcast(world.snapshot());
  // Aufnahme: zehn Bilder pro Sekunde Weltzeit (bei hohem Tempo so viele, wie die Welt hergibt)
  if (recorder.current && !world.paused && Math.abs(world.simTime - lastRec) >= 0.1) { lastRec = world.simTime; recorder.frame(world.snapshot()); }
  if (frame % 120 === 0) recorder.flush();
}, 1000 / 60);

// ---------- Steuerung (Weboberfläche) ----------

const pub = (a: Agent) => ({ ...a, apiKey: undefined, hasKey: !!a.apiKey, running: runners.isRunning(a.id), usage: store.getUsage(a.id) });
const wrap = (fn: (req: express.Request, res: express.Response) => unknown) => async (req: express.Request, res: express.Response) => {
  try {
    const out = await fn(req, res);
    if (!res.headersSent) res.json(out ?? { ok: true });
  } catch (e: any) {
    res.status(400).json({ error: e?.message || String(e) });
  }
};

app.get('/api/state', wrap(() => ({
  agents: store.agents.map(pub),
  statics: STATICS,
  world: { paused: world.paused, speed: world.speed, resetIntervalMin: world.resetIntervalMin, rockShape: world.rockShape, lockstep: world.lockstep, hearRange: world.hearRange, physics: world.physics, physicsDefault: PHYSICS_DEFAULT, physicsRange: PHYSICS_RANGE, time: world.simTime, autoRecord, recording: recorder.current ? { ...recorder.current } : null },
  baseUrl: BASE,
})));

app.post('/api/control', wrap((req) => {
  const { paused, speed, resetIntervalMin, rockShape, lockstep, hearRange, physics } = req.body || {};
  if (typeof req.body?.autoRecord === 'boolean') { autoRecord = req.body.autoRecord; saveSettings(); broadcast({ t: 'agents' }); }
  if (paused === false && autoRecord && !recorder.current) startRecording();
  if (physics && typeof physics === 'object') { world.setPhysics(physics); saveSettings(); broadcast({ t: 'agents' }); }
  if (typeof hearRange === 'number' && hearRange >= 0) { world.hearRange = hearRange; saveSettings(); broadcast({ t: 'agents' }); }
  if (typeof lockstep === 'boolean') { world.lockstep = lockstep; saveSettings(); broadcast({ t: 'agents' }); }
  if (rockShape === 'block' || rockShape === 'ball') { world.setRockShape(rockShape); saveSettings(); broadcast({ t: 'agents' }); }
  if (typeof speed === 'number') world.speed = Math.max(0.1, Math.min(16, speed));
  if (typeof resetIntervalMin === 'number') { world.resetIntervalMin = Math.max(0, resetIntervalMin); saveSettings(); }
  if (typeof paused === 'boolean') {
    world.setPaused(paused);
    runners.setPaused(paused);
  }
  broadcast(world.snapshot());
}));

app.post('/api/reset', wrap(() => { world.reset(); broadcast(world.snapshot()); }));

// ---------- Eingriffe von aussen in die laufende Welt ----------

app.post('/api/world/objects', wrap((req) => { const r = world.spawnObj(req.body?.kind, req.body?.position); broadcast(world.snapshot()); return r; }));
app.delete('/api/world/objects/:id', wrap((req) => { const r = world.removeObj(Number(req.params.id)); broadcast(world.snapshot()); return r; }));
app.post('/api/world/say', wrap((req) => {
  const r = world.announce(req.body?.text);
  recorder.event(world.simTime, 'voice', '', { text: String(req.body?.text).trim().slice(0, 500) });
  broadcast({ t: 'voice', text: String(req.body?.text).trim().slice(0, 500) });
  return r;
}));

// ---------- Aufnahmen (Plays) ----------

app.get('/api/plays', wrap(() => ({ plays: recorder.list(), recording: recorder.current, autoRecord })));
app.post('/api/record', wrap((req) => {
  if (req.body?.on) startRecording(req.body?.name);
  else stopRecording();
  return { recording: recorder.current };
}));
app.get('/api/plays/:id', wrap((req) => recorder.full(Number(req.params.id))));
app.patch('/api/plays/:id', wrap((req) => { const p = recorder.update(Number(req.params.id), req.body || {}); broadcast({ t: 'agents' }); return p; }));
app.delete('/api/plays/:id', wrap((req) => { recorder.remove(Number(req.params.id)); }));
app.get('/api/plays/:id/export', (req, res) => {
  try {
    const id = Number(req.params.id);
    const name = recorder.get(id).name.replace(/[^\w\-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || `play-${id}`;
    const buf = recorder.exportFile(id);
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${name}.kiplay"`);
    res.end(buf);
  } catch (e: any) { res.status(400).json({ error: e?.message || String(e) }); }
});
app.post('/api/plays/import', express.raw({ type: '*/*', limit: '300mb' }), wrap((req) => recorder.importFile(req.body as Buffer)));

app.post('/api/agents', wrap((req) => {
  const a = store.create(req.body || {});
  world.addBody(a.id, a.name, a.color);
  broadcast({ t: 'agents' });
  return pub(a);
}));

app.patch('/api/agents/:id', wrap((req) => {
  const a = store.update(String(req.params.id), req.body || {});
  world.updateBody(a.id, a.name, a.color);
  broadcast({ t: 'agents' });
  return pub(a);
}));

app.delete('/api/agents/:id', wrap((req) => {
  runners.stop(String(req.params.id));
  world.removeBody(String(req.params.id));
  store.remove(String(req.params.id));
  broadcast({ t: 'agents' });
}));

app.post('/api/agents/:id/run', wrap((req) => {
  const a = store.get(String(req.params.id));
  if (req.body?.on) runners.start(a);
  else runners.stop(a.id);
}));

app.get('/api/agents/:id/files', wrap((req) => store.listFiles(store.get(String(req.params.id)))));
app.get('/api/agents/:id/file', wrap((req) => ({ content: store.readFile(store.get(String(req.params.id)), String(req.query.path)) })));
app.put('/api/agents/:id/file', wrap((req) => store.writeFile(store.get(String(req.params.id)), String(req.body.path), String(req.body.content ?? ''), true)));
app.get('/api/agents/:id/log', wrap((req) => store.getLog(String(req.params.id))));

// ---------- Schnittstelle für Agenten: HTTP ----------

function auth(req: express.Request): Agent | undefined {
  const h = req.headers.authorization || '';
  return store.byToken(h.startsWith('Bearer ') ? h.slice(7).trim() : (req.query.token as string | undefined));
}

app.get('/api/agent/observe', async (req, res) => {
  const a = auth(req);
  if (!a) return void res.status(401).json({ error: 'Token fehlt oder ist ungültig' });
  res.json(await runTool(world, store, a, 'observe', {}));
});

app.post('/api/agent/input', async (req, res) => {
  const a = auth(req);
  if (!a) return void res.status(401).json({ error: 'Token fehlt oder ist ungültig' });
  const name = normalizeAction(req.body?.type);
  if (!TOOLS.some((t) => t.name === name && !t.files)) return void res.status(400).json({ error: `Unbekannte Aktion: ${req.body?.type}` });
  if (a.runner === "extern") store.log(a.id, world.simTime, 'tool', `${name} ${JSON.stringify(req.body?.data ?? {})}`);
  res.json(await runTool(world, store, a, name, req.body?.data));
});

// ---------- Schnittstelle für Agenten: MCP (Streamable HTTP, zustandslos) ----------

app.post('/mcp', async (req, res) => {
  const a = auth(req);
  if (!a) return void res.status(401).json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Token fehlt oder ist ungültig' } });
  const { id, method, params } = req.body || {};
  if (id === undefined || id === null) return void res.status(202).end(); // Benachrichtigung
  const ok = (result: unknown) => res.json({ jsonrpc: '2.0', id, result });
  switch (method) {
    case 'initialize':
      return void ok({
        protocolVersion: params?.protocolVersion || '2025-03-26',
        capabilities: { tools: {} },
        serverInfo: { name: 'ki-playground', version: '0.1.0' },
        instructions: `Du steuerst den Körper von "${a.name}" auf einer simulierten Insel. y zeigt nach oben. Beginne mit observe.`,
      });
    case 'ping':
      return void ok({});
    case 'tools/list':
      return void ok({ tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters })) });
    case 'tools/call': {
      const name = params?.name;
      if (a.runner === "extern") store.log(a.id, world.simTime, 'tool', `${name} ${JSON.stringify(params?.arguments ?? {})}`);
      const out = await runTool(world, store, a, name, params?.arguments);
      const text = typeof out === 'string' ? out : JSON.stringify(out);
      return void ok({ content: [{ type: 'text', text }], isError: (out as any)?.ok === false });
    }
    default:
      return void res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Methode nicht gefunden: ${method}` } });
  }
});
app.get('/mcp', (_req, res) => void res.status(405).end());

// ---------- Weboberfläche ----------

const vite = await createVite({
  configFile: false,
  root: path.resolve(import.meta.dirname, '..', 'client'),
  plugins: [react()],
  appType: 'spa',
  server: { middlewareMode: true, hmr: { server } },
});
app.use(vite.middlewares);

// Beim Beenden keine Agenten-Prozesse zurücklassen, die weiter Kontingent verbrauchen
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(sig, () => { runners.stopAll(); store.saveUsage(); try { recorder.stop(world.simTime); recorder.close(); } catch {} process.exit(0); });
}

server.listen(PORT, '127.0.0.1', () => console.log(`KI Playground läuft auf ${BASE}`));
