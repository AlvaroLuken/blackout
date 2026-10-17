// Blackout explained in 3D: an agent, Blackout as a guardian, the journal, your system,
// its receipts, and customers. Plays the crash story step by step, with or without Blackout.
import * as THREE from "three";

const host = document.getElementById("flow3d");
const cap = document.getElementById("flow-caption");
const stepEl = document.getElementById("flow-step");
const labelsEl = document.getElementById("flow-labels");
const btnMode = document.getElementById("flow-mode");
const btnPlay = document.getElementById("flow-play");
const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const C = { bg: 0x0b0d11, amber: 0xf59e0b, blue: 0x60a5fa, ok: 0x34d399, bad: 0xf87171, steel: 0x2a3140, steel2: 0x3a4356, white: 0xe8eaef, pink: 0xe879f9 };

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(C.bg);
host.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(C.bg, 22, 46);
const camera = new THREE.PerspectiveCamera(42, 2, 0.1, 100);
camera.position.set(0, 6.5, 15.5);
camera.lookAt(0, 1.2, 0.8);

scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x0b0d11, 0.9));
const key = new THREE.DirectionalLight(0xffffff, 1.4); key.position.set(6, 12, 8); scene.add(key);
const grid = new THREE.GridHelper(60, 60, 0x1c222c, 0x151a22); grid.position.y = -0.01; scene.add(grid);

const mat = (color, emissive = 0x000000, ei = 0) => new THREE.MeshStandardMaterial({ color, emissive, emissiveIntensity: ei, roughness: 0.45, metalness: 0.25 });
const labels = [];
function label(obj, text, sub, dy = 2.2) {
  const el = document.createElement("div"); el.className = "flabel";
  el.innerHTML = `<b>${text}</b><span>${sub ?? ""}</span>`;
  labelsEl.appendChild(el); labels.push({ obj, el, dy }); return el;
}

// --- Agent (robot) ---
function makeAgent(color) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.55, 0.9, 6, 16), mat(color, color, 0.15)); body.position.y = 1.05; g.add(body);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.62, 0.7), mat(C.steel2)); head.position.y = 2.15; g.add(head);
  const eyeM = mat(0xffffff, C.blue, 2.2);
  for (const x of [-0.2, 0.2]) { const e = new THREE.Mesh(new THREE.SphereGeometry(0.08, 12, 12), eyeM); e.position.set(x, 2.18, 0.36); g.add(e); }
  const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.4), mat(C.steel2)); ant.position.y = 2.65; g.add(ant);
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 12), mat(C.blue, C.blue, 2)); tip.position.y = 2.9; g.add(tip);
  g.userData = { body, eyeM, tip };
  return g;
}
const agent = makeAgent(0x4b5a75); agent.position.set(-8.2, 0, 0); scene.add(agent);
const agentLabel = label(agent, "AI agent", "Nemotron on Crusoe", 3.6);

// --- Blackout guardian ---
const guard = new THREE.Group(); guard.position.set(-3.2, 0, 0); scene.add(guard);
const core = new THREE.Mesh(new THREE.IcosahedronGeometry(0.85, 1), mat(0x1a1408, C.amber, 1.2)); core.position.y = 2.1; guard.add(core);
const ring1 = new THREE.Mesh(new THREE.TorusGeometry(1.45, 0.05, 8, 64), mat(C.amber, C.amber, 2)); ring1.position.y = 2.1; guard.add(ring1);
const ring2 = ring1.clone(); ring2.rotation.x = Math.PI / 2; guard.add(ring2);
const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.15, 0.5, 32), mat(C.steel)); pedestal.position.y = 0.25; guard.add(pedestal);
const gLight = new THREE.PointLight(C.amber, 6, 9); gLight.position.y = 2.1; guard.add(gLight);
const shield = new THREE.Mesh(new THREE.SphereGeometry(2.2, 32, 24), new THREE.MeshBasicMaterial({ color: C.amber, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }));
shield.position.y = 2.1; guard.add(shield);
const guardLabel = label(guard, "Blackout", "the guardian", 3.9);

// --- Database stacks ---
function makeDB(color) {
  const g = new THREE.Group(); const disks = [];
  for (let i = 0; i < 3; i++) { const d = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.75, 0.42, 32), mat(C.steel2, color, 0.05)); d.position.y = 0.3 + i * 0.5; g.add(d); disks.push(d); }
  g.userData.disks = disks; return g;
}
const journal = makeDB(C.amber); journal.position.set(-3.2, 0, 3.6); scene.add(journal);
label(journal, "Journal", "written before every action", -0.35);

// --- Your system ---
const service = new THREE.Group(); service.position.set(3, 0, 0); scene.add(service);
const rack = new THREE.Mesh(new THREE.BoxGeometry(1.8, 3, 1.4), mat(C.steel)); rack.position.y = 1.5; service.add(rack);
const leds = [];
for (let i = 0; i < 4; i++) { const l = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.08, 0.02), mat(0x112, C.ok, 1.5)); l.position.set(0, 0.6 + i * 0.6, 0.71); service.add(l); leds.push(l); }
label(service, "Your system", "sends the messages", 3.9);
const receipts = makeDB(C.ok); receipts.position.set(3, 0, 3.6); scene.add(receipts);
label(receipts, "Receipts", "what really happened", -0.35);

// --- Customers ---
const customers = [];
for (let i = 0; i < 4; i++) {
  const g = new THREE.Group(); g.position.set(7.6, 0, -2.6 + i * 1.75); scene.add(g);
  const box = new THREE.Mesh(new THREE.BoxGeometry(1, 0.9, 0.9), mat(C.steel2)); box.position.y = 0.6; g.add(box);
  const flag = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.5, 0.25), mat(C.steel2)); flag.position.set(0.56, 1, 0); g.add(flag);
  g.userData = { box, flag, count: 0, envs: [] };
  customers.push(g);
}
label(customers[3], "Customers", "one message each", 1.9);
const c5 = customers[1];
const c5Label = label(c5, "Customer 5", "", 1.9);

// --- Packets ---
const packets = [];
function packet(from, to, color, ms, onArrive) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(0.22, 16, 16), mat(color, color, 2.5));
  const a = from.clone(), b = to.clone(); m.position.copy(a); scene.add(m);
  const p = { m, a, b, t0: performance.now(), ms: reduce ? 1 : ms, onArrive, light: new THREE.PointLight(color, 2.5, 3) };
  m.add(p.light); packets.push(p); return p;
}
const at = (obj, dy = 1.6, dx = 0, dz = 0) => obj.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(dx, dy, dz));

function envelope(c, bad) {
  const e = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.08, 0.5), mat(bad ? C.bad : C.white, bad ? C.bad : C.ok, bad ? 1.5 : 0.6));
  c.userData.count++; e.position.set(0, 1.12 + c.userData.envs.length * 0.14, 0); c.add(e); c.userData.envs.push(e);
  c.userData.box.material = mat(bad ? 0x3a1414 : C.steel2, bad ? C.bad : 0, bad ? 0.6 : 0);
}

// --- Story ---
let withBlackout = true, playing = !reduce, stepIdx = -1, timer = null, flash = { obj: null, until: 0, color: 0 };
function glow(obj, color, ms = 900) { flash = { obj, until: performance.now() + ms, color }; }
function setCaption(n, total, text) { stepEl.textContent = `${n}/${total}`; cap.textContent = text; }

function resetScene() {
  for (const p of packets.splice(0)) scene.remove(p.m);
  for (const c of customers) { for (const e of c.userData.envs) c.remove(e); c.userData.envs = []; c.userData.count = 0; c.userData.box.material = mat(C.steel2); }
  agent.visible = true; agent.position.set(-8.2, 0, 0); agent.rotation.set(0, 0, 0); agent.userData.body.material = mat(0x4b5a75, 0x4b5a75, 0.15);
  agentLabel.querySelector("b").textContent = "AI agent";
  guard.visible = withBlackout; journal.visible = withBlackout; shield.material.opacity = 0;
  for (const c of customers.filter((c) => c !== c5)) envelope(c, false);
  c5Label.querySelector("span").textContent = "0 messages";
}

const WITH = [
  ["The agent decides to message customer 5.", () => packet(at(agent, 2), at(guard, 2.1), C.blue, 1100)],
  ["Blackout writes it down first, with an ID: op-005.", () => packet(at(guard, 2.1), at(journal, 1.6), C.amber, 900, () => glow(journal, C.amber))],
  ["Then it lets the message through. Your system sends it and keeps a receipt.", () => packet(at(guard, 2.1), at(service, 2), C.amber, 900, () => {
    packet(at(service, 2), at(c5, 1.2), C.ok, 900, () => { envelope(c5, false); c5Label.querySelector("span").textContent = "1 message"; });
    packet(at(service, 1), at(receipts, 1.6), C.ok, 900, () => glow(receipts, C.ok));
  })],
  ["The agent crashes before it can note that it was sent.", () => crash()],
  ["A fresh agent takes over. It has no memory, so it tries to message customer 5 again.", () => { respawn(); setTimeout(() => packet(at(agent, 2), at(guard, 2.1), C.blue, 1100), 500); }],
  ["Blackout checks the journal, then asks your system about op-005. The receipt says: already sent.", () => packet(at(guard, 2.1), at(receipts, 1.6), C.amber, 900, () => { glow(receipts, C.ok); packet(at(receipts, 1.6), at(guard, 2.1), C.ok, 900); })],
  ["So Blackout blocks the repeat. Customer 5 got exactly one message, and code confirms it.", () => { shield.material.opacity = 0.22; glow(guard, C.amber, 1500); }],
];
const WITHOUT = [
  ["The agent decides to message customer 5. There is no journal.", () => packet(at(agent, 2), at(service, 2), C.blue, 1500)],
  ["Your system sends it.", () => packet(at(service, 2), at(c5, 1.2), C.ok, 900, () => { envelope(c5, false); c5Label.querySelector("span").textContent = "1 message"; })],
  ["The agent crashes before it can note that it was sent.", () => crash()],
  ["A fresh agent takes over. Customer 5 looks unsent, so it sends again.", () => { respawn(); setTimeout(() => packet(at(agent, 2), at(service, 2), C.blue, 1500), 500); }],
  ["Your system sends it again. Customer 5 got the same message twice.", () => packet(at(service, 2), at(c5, 1.2), C.bad, 900, () => { envelope(c5, true); c5Label.querySelector("span").textContent = "2 messages ✗"; glow(c5, C.bad, 1500); })],
  ["And the agent reports \"all done\". Nothing checked it.", () => {}],
];

function crash() {
  agent.userData.body.material = mat(0x7f1d1d, C.bad, 1.5);
  glow(agent, C.bad, 1200);
  setTimeout(() => { agent.rotation.z = -1.35; agent.position.y = 0.3; }, 400);
  setTimeout(() => { agent.visible = false; }, 1500);
}
function respawn() {
  agent.visible = true; agent.rotation.set(0, 0, 0); agent.position.set(-8.2, 0, 0);
  agent.userData.body.material = mat(0x4b5a75, 0x4b5a75, 0.15);
  agentLabel.querySelector("b").textContent = "New AI agent";
}

function script() { return withBlackout ? WITH : WITHOUT; }
function next() {
  const s = script();
  stepIdx = (stepIdx + 1) % (s.length + 1);
  if (stepIdx === s.length) { timer = playing ? setTimeout(() => { stepIdx = -1; resetScene(); next(); }, 2600) : null; return; }
  if (stepIdx === 0) resetScene();
  setCaption(stepIdx + 1, s.length, s[stepIdx][0]);
  s[stepIdx][1]();
  if (playing) timer = setTimeout(next, 3400);
}
function restart() { clearTimeout(timer); stepIdx = -1; resetScene(); next(); }

btnMode.addEventListener("click", () => {
  withBlackout = !withBlackout;
  btnMode.textContent = withBlackout ? "Show it without Blackout" : "Show it with Blackout";
  btnMode.setAttribute("aria-pressed", String(!withBlackout));
  restart();
});
btnPlay.addEventListener("click", () => {
  if (playing) { playing = false; clearTimeout(timer); btnPlay.textContent = "▶ Next step"; }
  else { next(); }
});
btnPlay.textContent = reduce ? "▶ Next step" : "Pause";
btnPlay.addEventListener("dblclick", () => { playing = true; btnPlay.textContent = "Pause"; next(); });

function resize() {
  const w = host.clientWidth, h = host.clientHeight;
  renderer.setSize(w, h, false); camera.aspect = w / h;
  camera.position.z = w < 640 ? 27 : 15.5; camera.position.y = w < 640 ? 11 : 6.5;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(host); resize();

const v = new THREE.Vector3();
function frame(t) {
  requestAnimationFrame(frame);
  if (!reduce) { core.rotation.y = t / 1600; core.rotation.x = t / 2600; ring1.rotation.z = t / 900; ring2.rotation.y = t / 1300; }
  if (!reduce) agent.userData.tip.position.y = 2.9 + Math.sin(t / 300) * 0.04;
  shield.material.opacity *= 0.985;
  for (let i = packets.length - 1; i >= 0; i--) {
    const p = packets[i]; const k = Math.min(1, (t - p.t0) / p.ms);
    p.m.position.lerpVectors(p.a, p.b, k); p.m.position.y += Math.sin(k * Math.PI) * 1.2;
    if (k >= 1) { scene.remove(p.m); packets.splice(i, 1); p.onArrive?.(); }
  }
  if (flash.obj && t < flash.until) flash.obj.scale.setScalar(1 + Math.sin(t / 60) * 0.04); else if (flash.obj) { flash.obj.scale.setScalar(1); flash.obj = null; }
  renderer.render(scene, camera);
  const r = renderer.domElement.getBoundingClientRect();
  for (const l of labels) {
    if (!l.obj.visible) { l.el.style.opacity = "0"; continue; }
    l.obj.getWorldPosition(v); v.y += l.dy; v.project(camera);
    l.el.style.opacity = "1";
    l.el.style.transform = `translate(-50%, -100%) translate(${(v.x * 0.5 + 0.5) * r.width}px, ${(-v.y * 0.5 + 0.5) * r.height}px)`;
  }
}
requestAnimationFrame(frame);
restart();
