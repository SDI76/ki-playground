import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export interface StaticPart { name: string; center: number[]; size: number[]; ground?: boolean }
export interface Snap {
  time: number; paused: boolean; speed: number; lock?: boolean; hold?: string[]; resetIn: number | null; resetCount: number;
  agents: { st?: 'wait' | 'think' | 'away' | null; id: string; name: string; color: string; p: number[]; yaw: number; holding: number | null; moving: boolean; grounded: boolean }[];
  objs: { id: number; kind: 'cube' | 'rock' | 'ring'; s?: string; name: string; p: number[]; q: number[] }[];
}

interface Tracked { sig?: string; node: THREE.Object3D; pos: THREE.Vector3; quat: THREE.Quaternion; seen: number }
interface AgentNode extends Tracked { yaw: number; moving: boolean; legs: THREE.Object3D[]; arms: THREE.Object3D[]; color: string; name: string; label: THREE.Sprite }

const WATER_FRAG = `
uniform float uTime;
uniform vec4 uRects[5];
varying vec3 vPos;
float sdBox(vec2 p, vec2 c, vec2 h) { vec2 d = abs(p - c) - h; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0); }
void main() {
  float d = 1e5;
  for (int i = 0; i < 5; i++) d = min(d, sdBox(vPos.xz, uRects[i].xy, uRects[i].zw));
  float wave = sin(vPos.z * 0.55 + sin(vPos.x * 0.08 + uTime * 0.25) * 2.0 + uTime * 0.5) * 0.5 + 0.5;
  vec3 deep = vec3(0.035, 0.075, 0.12);
  vec3 col = deep + vec3(0.02, 0.035, 0.05) * wave * (1.0 - smoothstep(70.0, 220.0, length(vPos.xz)));
  float glow = exp(-max(d, 0.0) * 0.16);
  col += vec3(0.20, 0.36, 0.48) * glow * (0.75 + 0.25 * wave);
  float line = smoothstep(0.22, 0.0, abs(d - 1.3));
  col += vec3(0.85, 0.93, 1.0) * line * 0.9;
  float far = smoothstep(120.0, 420.0, length(vPos.xz));
  col = mix(col, vec3(0.04, 0.07, 0.11), far);
  gl_FragColor = vec4(col, 1.0);
}`;

export class Scene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private objs = new Map<number, Tracked>();
  private agents = new Map<string, AgentNode>();
  private water: THREE.ShaderMaterial;
  private staticGroup = new THREE.Group();
  private clock = new THREE.Clock();
  private raf = 0;
  private stamp = 0;
  private paused = true;
  private ro: ResizeObserver;
  follow: string | null = null;
  private recenter = false;
  /** Auswahl per Klick: eine Stelle am Boden oder ein Ding. */
  onPick: ((hit: { point?: number[]; objId?: number }) => void) | null = null;
  private pickMode: 'ground' | 'object' | null = null;
  setPickMode(m: 'ground' | 'object' | null) {
    this.pickMode = m;
    this.renderer.domElement.style.cursor = m ? 'crosshair' : '';
  }
  private home = new THREE.Vector3(0, 2, 0);

  constructor(private host: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color('#070e17');
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.5, 900);
    this.camera.position.set(-30, 72, 150);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0, 2, 0);
    this.controls.enableDamping = true;
    // Verschieben bewegt den Drehpunkt auf der Bodenebene statt in der Bildebene
    this.controls.screenSpacePanning = false;
    // Shift + Ziehen verschiebt den Drehpunkt (von Haus aus). Alt + Klick holt ihn zurück zur Mitte der Insel.
    this.renderer.domElement.addEventListener('pointerdown', (e) => {
      this.recenter = e.altKey;
      if (e.altKey) e.stopImmediatePropagation();
    }, { capture: true });
    // Klick ohne Ziehen: im Setz- oder Entfern-Modus eine Stelle oder ein Ding auswählen
    let down: { x: number; y: number } | null = null;
    this.renderer.domElement.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
    this.renderer.domElement.addEventListener('pointerup', (e) => {
      const d = down;
      down = null;
      if (!d || !this.pickMode || !this.onPick || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return;
      const r = this.renderer.domElement.getBoundingClientRect();
      const ray = new THREE.Raycaster();
      ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.camera);
      if (this.pickMode === 'ground') {
        const hit = ray.intersectObjects([this.staticGroup, ...[...this.objs.values()].map((o) => o.node)], true)[0];
        if (hit) this.onPick({ point: [hit.point.x, hit.point.y, hit.point.z] });
      } else {
        for (const [id, o] of this.objs) {
          if (ray.intersectObject(o.node, true).length) { this.onPick({ objId: id }); break; }
        }
      }
    });
    this.controls.maxPolarAngle = Math.PI / 2 - 0.04;
    this.controls.minDistance = 6;
    this.controls.maxDistance = 260;

    this.scene.add(new THREE.HemisphereLight('#9fb8d4', '#0b1420', 1.15));
    const sun = new THREE.DirectionalLight('#ffffff', 2.1);
    sun.position.set(-45, 70, 35);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const c = sun.shadow.camera;
    c.left = -70; c.right = 70; c.top = 70; c.bottom = -70; c.near = 1; c.far = 220;
    sun.shadow.bias = -0.0004;
    this.scene.add(sun);

    this.water = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uRects: { value: Array.from({ length: 5 }, () => new THREE.Vector4(0, 0, 0, 0)) } },
      vertexShader: 'varying vec3 vPos; void main(){ vPos = (modelMatrix * vec4(position,1.0)).xyz; gl_Position = projectionMatrix * viewMatrix * vec4(vPos,1.0); }',
      fragmentShader: WATER_FRAG,
    });
    const sea = new THREE.Mesh(new THREE.PlaneGeometry(1600, 1600), this.water);
    sea.rotation.x = -Math.PI / 2;
    sea.position.y = -1.4;
    this.scene.add(sea);
    this.scene.add(this.staticGroup);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();
    this.loop();
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.ro.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  private resize() {
    const w = this.host.clientWidth || 1, h = this.host.clientHeight || 1;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  setStatics(parts: StaticPart[]) {
    this.staticGroup.clear();
    const rects = this.water.uniforms.uRects.value as THREE.Vector4[];
    let r = 0;
    for (const s of parts) {
      const side = new THREE.MeshStandardMaterial({ color: s.ground ? '#0c141e' : '#121c29', roughness: 0.9 });
      const top = new THREE.MeshStandardMaterial({ color: s.ground ? '#586d85' : '#8497ad', roughness: 0.95 });
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(s.size[0], s.size[1], s.size[2]), [side, side, top, side, side, side]);
      mesh.position.set(s.center[0], s.center[1], s.center[2]);
      mesh.receiveShadow = true;
      mesh.castShadow = !s.ground;
      this.staticGroup.add(mesh);
      if (!s.ground) {
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), new THREE.LineBasicMaterial({ color: '#b7c6d8', transparent: true, opacity: 0.22 }));
        edges.position.copy(mesh.position);
        this.staticGroup.add(edges);
      } else if (r < 5) {
        rects[r++].set(s.center[0], s.center[2], s.size[0] / 2, s.size[2] / 2);
      }
    }
  }

  private makeObj(kind: string, shape?: string): THREE.Object3D {
    let mesh: THREE.Mesh;
    if (kind === 'cube') {
      mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: '#b4bcc6', roughness: 0.8 }));
      mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), new THREE.LineBasicMaterial({ color: '#e9eef4', transparent: true, opacity: 0.5 })));
    } else if (kind === 'rock' && shape !== 'ball') {
      mesh = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.4, 1.4), new THREE.MeshStandardMaterial({ color: '#27323f', roughness: 0.7 }));
      mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), new THREE.LineBasicMaterial({ color: '#9fb2c6', transparent: true, opacity: 0.45 })));
    } else if (kind === 'rock') {
      mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(0.76, 0), new THREE.MeshStandardMaterial({ color: '#27323f', roughness: 0.7, flatShading: true }));
    } else {
      mesh = new THREE.Mesh(new THREE.TorusGeometry(1.2, 0.18, 12, 40).rotateX(Math.PI / 2), new THREE.MeshStandardMaterial({ color: '#eef3f8', roughness: 0.4, emissive: '#5d7186', emissiveIntensity: 0.35 }));
    }
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  private makeLabel(name: string): THREE.Sprite {
    const cv = document.createElement('canvas');
    cv.width = 256; cv.height = 64;
    const g = cv.getContext('2d')!;
    g.font = '600 30px ui-monospace, SFMono-Regular, Menlo, monospace';
    g.textAlign = 'center';
    g.fillStyle = 'rgba(232,240,248,0.92)';
    g.fillText(name.toUpperCase().slice(0, 12), 128, 42);
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), depthTest: false, transparent: true }));
    sp.scale.set(4, 1, 1);
    sp.position.y = 2.7;
    return sp;
  }

  private makeAgent(a: Snap['agents'][number]): AgentNode {
    const g = new THREE.Group();
    const body = new THREE.MeshStandardMaterial({ color: a.color, roughness: 0.75 });
    const dark = new THREE.MeshStandardMaterial({ color: new THREE.Color(a.color).multiplyScalar(0.72), roughness: 0.8 });
    const box = (w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z = 0, pivotTop = false) => {
      const geo = new THREE.BoxGeometry(w, h, d);
      if (pivotTop) geo.translate(0, -h / 2, 0);
      const mesh = new THREE.Mesh(geo, m);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      g.add(mesh);
      return mesh;
    };
    const legs = [box(0.24, 0.7, 0.26, dark, -0.14, 0.7, 0, true), box(0.24, 0.7, 0.26, dark, 0.14, 0.7, 0, true)];
    box(0.56, 0.62, 0.32, body, 0, 1.01);
    const arms = [box(0.16, 0.58, 0.2, body, -0.37, 1.3, 0, true), box(0.16, 0.58, 0.2, body, 0.37, 1.3, 0, true)];
    box(0.5, 0.46, 0.46, body, 0, 1.56);
    const eye = new THREE.MeshBasicMaterial({ color: '#0a0f14' });
    box(0.08, 0.1, 0.02, eye, -0.11, 1.58, 0.235);
    box(0.08, 0.1, 0.02, eye, 0.11, 1.58, 0.235);
    const label = this.makeLabel(a.name);
    g.add(label);
    return { node: g, pos: new THREE.Vector3(), quat: new THREE.Quaternion(), seen: 0, yaw: a.yaw, moving: false, legs, arms, color: a.color, name: a.name, label };
  }

  apply(s: Snap) {
    this.stamp++;
    this.paused = s.paused;
    for (const o of s.objs) {
      let t = this.objs.get(o.id);
      const sig = o.kind + (o.s || '');
      if (t && t.sig !== sig) { this.scene.remove(t.node); t = undefined; }
      if (!t) {
        t = { sig, node: this.makeObj(o.kind, o.s), pos: new THREE.Vector3(), quat: new THREE.Quaternion(), seen: 0 };
        t.node.position.set(o.p[0], o.p[1], o.p[2]);
        this.scene.add(t.node);
        this.objs.set(o.id, t);
      }
      t.pos.set(o.p[0], o.p[1], o.p[2]);
      t.quat.set(o.q[0], o.q[1], o.q[2], o.q[3]).normalize();
      t.seen = this.stamp;
    }
    for (const [id, t] of this.objs) if (t.seen !== this.stamp) { this.scene.remove(t.node); this.objs.delete(id); }

    for (const a of s.agents) {
      let n = this.agents.get(a.id);
      if (n && (n.color !== a.color || n.name !== a.name)) { this.scene.remove(n.node); this.agents.delete(a.id); n = undefined; }
      if (!n) {
        n = this.makeAgent(a);
        n.node.position.set(a.p[0], a.p[1], a.p[2]);
        this.scene.add(n.node);
        this.agents.set(a.id, n);
      }
      n.pos.set(a.p[0], a.p[1], a.p[2]);
      n.yaw = a.yaw;
      n.moving = a.moving && a.grounded;
      n.arms.forEach((arm) => (arm.rotation.x = a.holding !== null ? Math.PI : arm.rotation.x > 3 ? 0 : arm.rotation.x));
      n.seen = this.stamp;
    }
    for (const [id, n] of this.agents) if (n.seen !== this.stamp) { this.scene.remove(n.node); this.agents.delete(id); }
  }

  /** Bildschirmposition knapp über dem Kopf eines Agenten, oder null, wenn er nicht im Bild ist. */
  project(id: string): { x: number; y: number } | null {
    const a = this.agents.get(id);
    if (!a) return null;
    const v = a.node.position.clone().setY(a.node.position.y + 3.05).project(this.camera);
    if (v.z > 1 || Math.abs(v.x) > 1.1 || Math.abs(v.y) > 1.1) return null;
    return { x: (v.x * 0.5 + 0.5) * this.host.clientWidth, y: (-v.y * 0.5 + 0.5) * this.host.clientHeight };
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const dt = Math.min(this.clock.getDelta(), 0.1);
    const t = this.clock.elapsedTime;
    const k = 1 - Math.exp(-dt * 16);
    for (const o of this.objs.values()) {
      if (o.node.position.distanceToSquared(o.pos) > 400) o.node.position.copy(o.pos);
      else o.node.position.lerp(o.pos, k);
      o.node.quaternion.slerp(o.quat, k);
    }
    for (const a of this.agents.values()) {
      if (a.node.position.distanceToSquared(a.pos) > 400) a.node.position.copy(a.pos);
      else a.node.position.lerp(a.pos, k);
      let d = a.yaw - a.node.rotation.y;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      a.node.rotation.y += d * k;
      const swing = a.moving && !this.paused ? Math.sin(t * 11) * 0.7 : 0;
      a.legs[0].rotation.x += (swing - a.legs[0].rotation.x) * 0.3;
      a.legs[1].rotation.x += (-swing - a.legs[1].rotation.x) * 0.3;
      a.arms.forEach((arm, i) => { if (arm.rotation.x < 3) arm.rotation.x += ((i ? swing : -swing) * 0.6 - arm.rotation.x) * 0.3; });
    }
    if (this.follow) {
      const a = this.agents.get(this.follow);
      if (a) {
        const tgt = a.node.position.clone().setY(a.node.position.y + 1);
        const delta = tgt.sub(this.controls.target).multiplyScalar(1 - Math.exp(-dt * 5));
        this.controls.target.add(delta);
        this.camera.position.add(delta);
      }
    }
    if (this.recenter && !this.follow) {
      // Drehpunkt und Kamera gemeinsam verschieben: Blickwinkel und Abstand bleiben
      const rest = this.home.clone().sub(this.controls.target);
      if (rest.lengthSq() < 0.0004) this.recenter = false;
      const delta = rest.multiplyScalar(1 - Math.exp(-dt * 7));
      this.controls.target.add(delta);
      this.camera.position.add(delta);
    }
    if (!this.paused) this.water.uniforms.uTime.value += dt;
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };
}
