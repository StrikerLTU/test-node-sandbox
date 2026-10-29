#!/usr/bin/env node
'use strict';

// Sandbox — a tiny falling-sand toy for your terminal. No dependencies.
// Run: node sandbox.js

const out = process.stdout;
const inp = process.stdin;

if (!out.isTTY || !inp.isTTY) {
  console.error('sandbox needs an interactive terminal (TTY).');
  process.exit(1);
}

const EMPTY = 0, SAND = 1, WATER = 2, STONE = 3, WOOD = 4, FIRE = 5, EMBER = 6;
const WALL = 255; // anything outside the grid

const MATERIALS = {
  [SAND]:  { name: 'Sand',  rgb: [222, 184, 98],  vary: 28 },
  [WATER]: { name: 'Water', rgb: [48, 118, 222],  vary: 18 },
  [STONE]: { name: 'Stone', rgb: [118, 118, 130], vary: 18 },
  [WOOD]:  { name: 'Wood',  rgb: [118, 76, 40],   vary: 14 },
  [FIRE]:  { name: 'Fire',  rgb: [255, 140, 30],  vary: 50 },
  [EMBER]: { name: 'Ember', rgb: [200, 60, 20],   vary: 40 },
};
const PALETTE = [SAND, WATER, STONE, WOOD, FIRE, EMPTY]; // keys 1-6
const BG = (14 << 16) | (14 << 8) | 22;
const MAX_BRUSH = 12;

const ENTER = '\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[?1003h\x1b[?1006h\x1b[2J';
const LEAVE = '\x1b[?1003l\x1b[?1006l\x1b[0m\x1b[?7h\x1b[?25h\x1b[?1049l';

let W = 0, H = 0;
let cell, shade, life, stamp;
let tick = 1;

let cursorX = 0, cursorY = 0;
let brush = 2;
let selected = SAND;
let pouring = false;  // toggled with space
let mouseButton = -1; // 0 = left (paint), 2 = right (erase)
let paused = false;

const rand = n => Math.floor(Math.random() * n);
const chance = p => Math.random() < p;
const clamp = (v, lo = 0, hi = 255) => (v < lo ? lo : v > hi ? hi : v);
const rgb = (r, g, b) => (clamp(r) << 16) | (clamp(g) << 8) | clamp(b);

// ---------- grid ----------

function resize() {
  const newW = Math.max(10, out.columns);
  const newH = Math.max(4, (out.rows - 2) * 2); // two pixels per character row
  const nCell = new Uint8Array(newW * newH);
  const nShade = new Int8Array(newW * newH);
  const nLife = new Uint8Array(newW * newH);
  const nStamp = new Uint8Array(newW * newH);

  if (cell) {
    // keep existing particles, anchored to the floor
    for (let k = 0; k < Math.min(H, newH); k++) {
      const sy = H - 1 - k, dy = newH - 1 - k;
      for (let x = 0; x < Math.min(W, newW); x++) {
        const s = sy * W + x, d = dy * newW + x;
        nCell[d] = cell[s]; nShade[d] = shade[s]; nLife[d] = life[s];
      }
    }
  }

  W = newW; H = newH;
  cell = nCell; shade = nShade; life = nLife; stamp = nStamp;
  cursorX = clamp(cursorX, 0, W - 1);
  cursorY = clamp(cursorY, 0, H - 1);
  out.write('\x1b[2J');
}

function at(x, y) {
  return x < 0 || x >= W || y < 0 || y >= H ? WALL : cell[y * W + x];
}

function set(i, type) {
  cell[i] = type;
  const vary = type === EMPTY ? 0 : MATERIALS[type].vary;
  shade[i] = vary ? rand(2 * vary + 1) - vary : 0;
  life[i] = type === FIRE ? 20 + rand(30) : type === EMBER ? 60 + rand(80) : 0;
  stamp[i] = tick;
}

function swap(a, b) {
  let t = cell[a]; cell[a] = cell[b]; cell[b] = t;
  t = shade[a]; shade[a] = shade[b]; shade[b] = t;
  t = life[a]; life[a] = life[b]; life[b] = t;
  stamp[a] = stamp[b] = tick;
}

const isEmpty = t => t === EMPTY;
const canSink = t => t === EMPTY || (t === WATER && chance(0.6));

function moveIf(i, x, y, test) {
  if (!test(at(x, y))) return false;
  swap(i, y * W + x);
  return true;
}

function touches(x, y, type) {
  return at(x, y - 1) === type || at(x, y + 1) === type ||
         at(x - 1, y) === type || at(x + 1, y) === type;
}

function igniteAround(x, y, p) {
  for (const [nx, ny] of [[x, y - 1], [x, y + 1], [x - 1, y], [x + 1, y]]) {
    if (at(nx, ny) === WOOD && chance(p)) set(ny * W + nx, EMBER);
  }
}

// ---------- physics ----------

function updateSand(x, y, i) {
  if (moveIf(i, x, y + 1, canSink)) return;
  const d = chance(0.5) ? 1 : -1;
  moveIf(i, x + d, y + 1, canSink) || moveIf(i, x - d, y + 1, canSink);
}

function updateWater(x, y, i) {
  if (moveIf(i, x, y + 1, isEmpty)) return;
  const d = chance(0.5) ? 1 : -1;
  if (moveIf(i, x + d, y + 1, isEmpty) || moveIf(i, x - d, y + 1, isEmpty)) return;
  // flow sideways up to 3 cells so puddles level out quickly
  for (const s of [d, -d]) {
    let n = 0;
    while (n < 3 && at(x + s * (n + 1), y) === EMPTY) n++;
    if (n) { swap(i, y * W + x + s * n); return; }
  }
}

function updateFire(x, y, i) {
  if (--life[i] === 0 || touches(x, y, WATER)) { set(i, EMPTY); return; }
  igniteAround(x, y, 0.08);
  shade[i] = rand(101) - 50; // flicker
  if (chance(0.7)) moveIf(i, x + rand(3) - 1, y - 1, isEmpty);
}

function updateEmber(x, y, i) {
  if (touches(x, y, WATER)) { set(i, WOOD); return; } // doused
  if (--life[i] === 0) { set(i, EMPTY); return; }      // burnt away
  igniteAround(x, y, 0.03);
  shade[i] = rand(81) - 40;
  if (at(x, y - 1) === EMPTY && chance(0.3)) set((y - 1) * W + x, FIRE);
}

function step() {
  tick = tick === 255 ? 1 : tick + 1;
  for (let y = H - 1; y >= 0; y--) {
    const ltr = chance(0.5); // alternate scan direction to avoid drift
    for (let k = 0; k < W; k++) {
      const x = ltr ? k : W - 1 - k;
      const i = y * W + x;
      if (stamp[i] === tick) continue;
      switch (cell[i]) {
        case SAND: updateSand(x, y, i); break;
        case WATER: updateWater(x, y, i); break;
        case FIRE: updateFire(x, y, i); break;
        case EMBER: updateEmber(x, y, i); break;
      }
    }
  }
}

function paint(cx, cy, type) {
  const r2 = brush * brush;
  for (let dy = -brush; dy <= brush; dy++) {
    for (let dx = -brush; dx <= brush; dx++) {
      if (dx * dx + dy * dy > r2) continue;
      const x = cx + dx, y = cy + dy;
      if (x < 0 || x >= W || y < 0 || y >= H) continue;
      const i = y * W + x;
      if (type === EMPTY) { set(i, EMPTY); continue; }
      if (cell[i] !== EMPTY) continue;
      const grainy = type === SAND || type === WATER || type === FIRE;
      if (grainy && !chance(0.35)) continue;
      set(i, type);
    }
  }
}

function clearAll() {
  cell.fill(0); shade.fill(0); life.fill(0);
}

function seed() {
  const fill = (x0, x1, y0, y1, type) => {
    for (let y = Math.floor(y0); y <= y1; y++)
      for (let x = Math.floor(x0); x <= x1; x++)
        if (x >= 0 && x < W && y >= 0 && y < H) set(y * W + x, type);
  };
  fill(W * 0.12, W * 0.42, H * 0.35, H * 0.35 + 1, STONE);
  fill(W * 0.55, W * 0.88, H * 0.62, H * 0.62 + 1, STONE);
  fill(W * 0.62, W * 0.76, H * 0.62 - 8, H * 0.62 - 1, WOOD);
}

// ---------- rendering ----------

function colorOf(x, y) {
  const i = y * W + x;
  const t = cell[i], v = shade[i];
  let c;
  if (t === EMPTY) c = BG;
  else if (t === FIRE) c = rgb(255, 80 + life[i] * 4 + v, v);
  else if (t === EMBER) c = rgb(200 + v, 60 + v / 2, 20);
  else { const m = MATERIALS[t].rgb; c = rgb(m[0] + v, m[1] + v, m[2] + v); }

  // highlight the brush footprint
  const dx = x - cursorX, dy = y - cursorY;
  if (dx * dx + dy * dy <= brush * brush) {
    const r = c >> 16, g = (c >> 8) & 255, b = c & 255;
    c = rgb(r + (255 - r) * 0.22, g + (255 - g) * 0.22, b + (255 - b) * 0.22);
  }
  return c;
}

const sgr = (kind, c) => `\x1b[${kind};2;${c >> 16};${(c >> 8) & 255};${c & 255}m`;

function render() {
  let s = '';
  let lastFg = -1, lastBg = -1;
  const rows = H / 2;
  for (let row = 0; row < rows; row++) {
    s += `\x1b[${row + 1};1H`;
    for (let x = 0; x < W; x++) {
      const fg = colorOf(x, row * 2), bg = colorOf(x, row * 2 + 1);
      if (fg !== lastFg) { s += sgr(38, fg); lastFg = fg; }
      if (bg !== lastBg) { s += sgr(48, bg); lastBg = bg; }
      s += '▀';
    }
  }

  const palette = PALETTE.map((t, k) => {
    const label = ` ${k + 1} ${t === EMPTY ? 'Eraser' : MATERIALS[t].name} `;
    return t === selected ? `\x1b[1;7m${label}\x1b[22;27m` : label;
  }).join('');
  const flags = (pouring ? '  \x1b[33mPOURING\x1b[39m' : '') + (paused ? '  \x1b[31mPAUSED\x1b[39m' : '');
  s += `\x1b[0m\x1b[${rows + 1};1H\x1b[K${palette}  brush ${brush}${flags}`;
  s += `\x1b[${rows + 2};1H\x1b[K\x1b[2mmouse: left paint · right erase · wheel brush   ` +
       `keys: arrows move · space pour · +/- brush · p pause · c clear · q quit\x1b[0m`;
  out.write(s);
}

// ---------- input ----------

const MOUSE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
const ARROW = /\x1b[[O]([ABCD])/g;

function onMouse(b, col, row, kind) {
  if (b & 64) { // wheel
    brush = clamp(brush + (b & 1 ? -1 : 1), 0, MAX_BRUSH);
    return;
  }
  if (row - 1 >= H / 2) { mouseButton = -1; return; } // on the status bar
  cursorX = clamp(col - 1, 0, W - 1);
  cursorY = clamp((row - 1) * 2, 0, H - 1);
  if (b & 32) return; // motion only
  mouseButton = kind === 'm' ? -1 : b & 3;
}

function onArrow(k) {
  if (k === 'A') cursorY = clamp(cursorY - 2, 0, H - 1);
  if (k === 'B') cursorY = clamp(cursorY + 2, 0, H - 1);
  if (k === 'C') cursorX = clamp(cursorX + 1, 0, W - 1);
  if (k === 'D') cursorX = clamp(cursorX - 1, 0, W - 1);
}

function onKey(ch) {
  if (ch === 'q' || ch === '\x03') return quit();
  if (ch === ' ') pouring = !pouring;
  else if (ch === 'p') paused = !paused;
  else if (ch === 'c') clearAll();
  else if (ch === '+' || ch === '=') brush = Math.min(MAX_BRUSH, brush + 1);
  else if (ch === '-' || ch === '_') brush = Math.max(0, brush - 1);
  else if (ch >= '1' && ch <= String(PALETTE.length)) selected = PALETTE[+ch - 1];
}

inp.on('data', data => {
  const s = data.toString('utf8')
    .replace(MOUSE, (_, b, x, y, kind) => { onMouse(+b, +x, +y, kind); return ''; })
    .replace(ARROW, (_, k) => { onArrow(k); return ''; });
  for (const ch of s) onKey(ch);
});

// ---------- main loop ----------

function frame() {
  if (mouseButton === 0 || pouring) paint(cursorX, cursorY, selected);
  else if (mouseButton === 2) paint(cursorX, cursorY, EMPTY);
  if (!paused) step();
  render();
}

let timer;
let cleanedUp = false;
function cleanup() {
  if (cleanedUp) return;
  cleanedUp = true;
  clearInterval(timer);
  out.write(LEAVE);
  try { inp.setRawMode(false); } catch {}
}
function quit() {
  cleanup();
  console.log('Thanks for playing in the sandbox!');
  process.exit(0);
}

process.on('exit', cleanup);
process.on('SIGTERM', quit);
process.on('SIGHUP', quit);
process.on('uncaughtException', err => { cleanup(); console.error(err); process.exit(1); });
out.on('resize', resize);

inp.setRawMode(true);
inp.resume();
out.write(ENTER);
resize();
cursorX = Math.floor(W * 0.27);
cursorY = Math.floor(H * 0.1);
seed();
timer = setInterval(frame, 33);
