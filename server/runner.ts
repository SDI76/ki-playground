import { spawn, type ChildProcess } from 'node:child_process';
import readline from 'node:readline';
import type { World } from './world.ts';
import type { Agent, AgentStore } from './agents.ts';
import { TOOLS, runTool } from './tools.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + ' …' : s);

const HARNESS_NOTE = `Du bist in dieser Sitzung kein Assistent, der auf Aufträge wartet. Du hast einen Körper in einer simulierten Welt.
Dein Arbeitsordner gehört dir und überdauert jede Sitzung; dein Kontext nicht.
Lies zuerst SOUL.md, SEMANTIC_MEMORY.md und EPISODIC_MEMORY.md.`;

interface Handle {
  stop(): void;
  setPaused(p: boolean): void;
}

export class Runners {
  private handles = new Map<string, Handle>();
  onChange: (() => void) | null = null;

  constructor(private world: World, private store: AgentStore) {}

  isRunning(id: string) {
    return this.handles.has(id);
  }

  setPaused(p: boolean) {
    for (const h of this.handles.values()) h.setPaused(p);
  }

  start(agent: Agent) {
    if (this.handles.has(agent.id)) return;
    if (agent.runner === 'extern') throw new Error('Dieser Agent wird von aussen gesteuert (API oder MCP) – hier gibt es nichts zu starten.');
    if (agent.runner === 'api' && (!agent.baseUrl || !agent.model)) throw new Error('Endpunkt und Modell müssen gesetzt sein.');
    const h = agent.runner === 'api' ? this.apiLoop(agent) : this.claudeLoop(agent);
    this.handles.set(agent.id, h);
    this.world.setDriven(agent.id, true);
    this.onChange?.();
  }

  stop(id: string) {
    const h = this.handles.get(id);
    if (!h) return;
    h.stop();
    this.handles.delete(id);
    this.world.setDriven(id, false);
    this.onChange?.();
  }

  /** Beendet alle laufenden Agenten, z. B. bevor der Server stoppt. */
  stopAll() {
    for (const id of [...this.handles.keys()]) this.stop(id);
  }

  private finished(id: string, h: Handle) {
    if (this.handles.get(id) === h) {
      this.handles.delete(id);
      this.world.setDriven(id, false);
      this.onChange?.();
    }
  }

  // ---------- Modell über OpenAI-kompatiblen Endpunkt ----------

  private apiLoop(agent: Agent): Handle {
    const { world, store } = this;
    const ac = new AbortController();
    let alive = true;
    const log = (kind: any, text: string) => store.log(agent.id, world.simTime, kind, text);
    const tools = TOOLS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    const handle: Handle = { stop: () => { alive = false; ac.abort(); }, setPaused: () => {} };

    (async () => {
      let messages: any[] = [];
      let sessionStart = -1;
      let resets = world.resetCount;
      let errors = 0;
      log('system', `Runner gestartet (${agent.model} @ ${agent.baseUrl})`);
      while (alive) {
        await world.whenRunning();
        if (!alive) break;
        const expired = sessionStart < 0 || world.simTime - sessionStart > agent.sessionMinutes * 60 || world.resetCount !== resets || messages.length > 160;
        if (expired) {
          let soul = '';
          try { soul = store.readFile(agent, 'SOUL.md'); } catch {}
          messages = [
            { role: 'system', content: `${HARNESS_NOTE}\nDu handelst ausschliesslich über deine Werkzeuge.\n\n${soul}` },
            { role: 'user', content: agent.beginPrompt },
          ];
          sessionStart = world.simTime;
          resets = world.resetCount;
          log('system', 'Neue Sitzung – Kontext geleert');
        }
        try {
          const res = await fetch(agent.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
            method: 'POST',
            signal: ac.signal,
            headers: { 'Content-Type': 'application/json', ...(agent.apiKey ? { Authorization: `Bearer ${agent.apiKey}` } : {}) },
            body: JSON.stringify({ model: agent.model, messages, tools }),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}: ${clip(await res.text(), 400)}`);
          const data = (await res.json()) as any;
          if (data.usage) {
            const cached = data.usage.prompt_tokens_details?.cached_tokens || 0;
            store.addUsage(agent.id, { input: (data.usage.prompt_tokens || 0) - cached, cacheRead: cached, output: data.usage.completion_tokens || 0 });
          }
          const msg = data.choices?.[0]?.message;
          if (!msg) throw new Error('Antwort ohne Nachricht');
          errors = 0;
          messages.push({ role: 'assistant', content: msg.content ?? '', ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) });
          if (msg.content) log('text', msg.content);
          if (msg.tool_calls?.length) {
            for (const tc of msg.tool_calls) {
              let args: any = {};
              try { args = JSON.parse(tc.function.arguments || '{}'); } catch {}
              log('tool', `${tc.function.name} ${clip(JSON.stringify(args), 600)}`);
              const out = alive ? await runTool(world, store, agent, tc.function.name, args) : { ok: false, error: 'gestoppt' };
              const text = typeof out === 'string' ? out : JSON.stringify(out);
              log('result', clip(text, 1200));
              messages.push({ role: 'tool', tool_call_id: tc.id, content: clip(text, 16000) });
            }
          } else {
            // wie im Paper: stoppt das Modell, bekommt es nur ein neutrales "Weiter."
            messages.push({ role: 'user', content: agent.continuePrompt });
            await world.waitSim(1, agent.id);
          }
        } catch (e: any) {
          if (!alive) break;
          errors++;
          log('error', e?.message || String(e));
          if (errors >= 5) { log('error', 'Fünf Fehler in Folge – Runner angehalten.'); break; }
          await sleep(4000);
        }
      }
      log('system', 'Runner beendet');
      this.finished(agent.id, handle);
    })();
    return handle;
  }

  // ---------- Claude Code als Harness (headless, im Arbeitsordner) ----------

  private claudeLoop(agent: Agent): Handle {
    const { world, store } = this;
    let alive = true;
    let proc: ChildProcess | null = null;
    let stopped = false; // SIGSTOP aktiv
    const log = (kind: any, text: string) => store.log(agent.id, world.simTime, kind, text);
    const handle: Handle = {
      stop: () => {
        alive = false;
        if (proc?.pid) { try { proc.kill('SIGCONT'); proc.kill('SIGTERM'); } catch {} }
      },
      setPaused: (p) => {
        if (!proc?.pid || p === stopped) return;
        try { proc.kill(p ? 'SIGSTOP' : 'SIGCONT'); stopped = p; } catch {}
      },
    };

    const runOnce = (prompt: string, cont: boolean) =>
      new Promise<number>((resolve) => {
        const args = [
          '-p', prompt,
          '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
          '--permission-mode', 'acceptEdits',
          '--allowedTools', 'Bash(curl:*),Read,Write,Edit,Glob,Grep',
          '--strict-mcp-config',
          '--append-system-prompt', `${HARNESS_NOTE}\nDeinen Körper steuerst du über die HTTP-Schnittstelle in API.md (curl).`,
        ];
        if (agent.model) args.push('--model', agent.model);
        if (cont) args.push('--continue');
        const env = { ...process.env };
        delete env.CLAUDECODE;
        delete env.CLAUDE_CODE_ENTRYPOINT;
        // Ohne Schlüssel rechnet Claude Code über das angemeldete Abo ab, nicht über die API.
        delete env.ANTHROPIC_API_KEY;
        delete env.ANTHROPIC_AUTH_TOKEN;
        proc = spawn('claude', args, { cwd: store.dir(agent), env, stdio: ['ignore', 'pipe', 'pipe'] });
        stopped = false;
        // Verbrauch: laufend aus den einzelnen Antworten, am Ende mit der Abrechnung des Laufs abgeglichen
        const fields = ['input', 'cacheRead', 'cacheWrite', 'output'] as const;
        const read = (u: any) => ({ input: u?.input_tokens || 0, cacheRead: u?.cache_read_input_tokens || 0, cacheWrite: u?.cache_creation_input_tokens || 0, output: u?.output_tokens || 0 });
        const perMsg = new Map<string, ReturnType<typeof read>>();
        const live = read(null);
        let curMsg = '';
        const count = (now: ReturnType<typeof read>, before: ReturnType<typeof read>) => {
          const d: Record<string, number> = {};
          for (const k of fields) { d[k] = now[k] - before[k]; live[k] += d[k]; }
          return d;
        };
        readline.createInterface({ input: proc.stdout! }).on('line', (line) => {
          let ev: any;
          try { ev = JSON.parse(line); } catch { return; }
          // message_start nennt die Eingabe, message_delta die endgültige Ausgabe einer Antwort
          const se = ev.type === 'stream_event' ? ev.event : null;
          if (se?.type === 'message_start') curMsg = se.message?.id || '';
          const u = se?.type === 'message_start' ? se.message?.usage : se?.type === 'message_delta' ? se.usage : ev.type === 'assistant' ? ev.message?.usage : null;
          const mid = se ? curMsg : ev.message?.id;
          if (u && mid) {
            const before = perMsg.get(mid) || read(null);
            const got = read(u);
            const now = { ...before };
            for (const k of fields) now[k] = Math.max(before[k], got[k]);
            store.addUsage(agent.id, count(now, before));
            perMsg.set(mid, now);
          } else if (ev.type === 'result' && ev.usage) {
            store.addUsage(agent.id, { ...count(read(ev.usage), { ...live }), cost: Number(ev.total_cost_usd) || 0 });
          }
          const content = ev.message?.content;
          if (ev.type === 'assistant' && Array.isArray(content)) {
            for (const c of content) {
              if (c.type === 'text' && c.text) log('text', c.text);
              else if (c.type === 'tool_use') log('tool', `${c.name} ${clip(JSON.stringify(c.input?.command ?? c.input?.file_path ?? c.input ?? {}), 600)}`);
            }
          } else if (ev.type === 'user' && Array.isArray(content)) {
            for (const c of content) {
              if (c.type !== 'tool_result') continue;
              const t = typeof c.content === 'string' ? c.content : (c.content || []).map((x: any) => x.text || '').join('\n');
              log('result', clip(t, 1200));
            }
          } else if (ev.type === 'result' && ev.is_error) {
            log('error', clip(String(ev.result ?? ev.subtype ?? 'Fehler'), 600));
          }
        });
        let err = '';
        proc.stderr!.on('data', (d) => { err = clip(err + d, 2000); });
        proc.on('error', (e) => { log('error', `claude liess sich nicht starten: ${e.message}`); resolve(1); });
        proc.on('close', (code) => {
          if (code && alive && err.trim()) log('error', err.trim());
          proc = null;
          resolve(code ?? 0);
        });
      });

    (async () => {
      let sessionStart = -1;
      let resets = world.resetCount;
      let errors = 0;
      log('system', `Runner gestartet (Claude Code${agent.model ? ', ' + agent.model : ''})`);
      // Sitzung läuft ab → Prozess beenden, die Schleife startet eine frische
      const watch = setInterval(() => {
        const expired = sessionStart >= 0 && (world.simTime - sessionStart > agent.sessionMinutes * 60 || world.resetCount !== resets);
        if (expired && proc?.pid) { try { proc.kill('SIGTERM'); } catch {} }
      }, 1000);
      while (alive) {
        await world.whenRunning();
        if (!alive) break;
        const fresh = sessionStart < 0 || world.simTime - sessionStart > agent.sessionMinutes * 60 || world.resetCount !== resets;
        if (fresh) {
          sessionStart = world.simTime;
          resets = world.resetCount;
          log('system', 'Neue Sitzung – Kontext geleert');
        }
        const code = await runOnce(fresh ? agent.beginPrompt : agent.continuePrompt, !fresh);
        if (!alive) break;
        const killedForReset = world.resetCount !== resets || world.simTime - sessionStart > agent.sessionMinutes * 60;
        if (code !== 0 && !killedForReset) {
          errors++;
          if (errors >= 3) { log('error', 'Claude Code ist dreimal in Folge fehlgeschlagen – Runner angehalten.'); break; }
          await sleep(3000);
        } else errors = 0;
      }
      clearInterval(watch);
      log('system', 'Runner beendet');
      this.finished(agent.id, handle);
    })();
    return handle;
  }
}
