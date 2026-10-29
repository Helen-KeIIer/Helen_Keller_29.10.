// =====================================================
// (0) FORCE START AT TOP
// =====================================================
(function () {
  try {
    if ("scrollRestoration" in history) history.scrollRestoration = "manual";
  } catch (e) {}

  function hardResetToTop() {
    try {
      if (location.hash) {
        history.replaceState(null, "", location.pathname + location.search);
      }
    } catch (e) {}

    try {
      window.scrollTo(0, 0);
    } catch (e) {}

    if (document.body) {
      document.body.classList.remove("is-light");
      document.body.classList.remove("is-scrolled");
    }

    try {
      document.documentElement.style.setProperty("--theoryWhite", "0");
      document.documentElement.style.setProperty("--theoryText", "0");
    } catch (e) {}
  }

  document.addEventListener("DOMContentLoaded", hardResetToTop);
  window.addEventListener("load", () => setTimeout(hardResetToTop, 0));
})();

// =====================================================
// DEVICE MODE
// Touch devices (phones, tablets) get finger interaction + hints.
// Desktop behaviour is untouched. "?touch=1" forces touch mode (phone preview).
// =====================================================
const IS_TOUCH = document.documentElement.classList.contains("is-touch");
const TOUCH_FORCED = document.documentElement.classList.contains("is-touch-forced");
function isPhoneLayout() {
  try { return window.matchMedia("(max-width: 600px)").matches; } catch (e) { return window.innerWidth <= 600; }
}

// =====================================================
// GLOBALS / HELPERS
// =====================================================
function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}
function easeSoft(t) {
  t = clamp01(t);
  return 0.5 - 0.5 * Math.cos(Math.PI * t);
}
function remap01(v, a, b) {
  return clamp01((v - a) / (b - a));
}

// Section geometry is cached (document-relative) so scroll handlers and the
// draw loop never force a layout. It is refreshed whenever the layout changes.
const sectionGeom = new Map();
function cacheSectionGeom(el) {
  if (!el) return;
  const r = el.getBoundingClientRect();
  sectionGeom.set(el, { top: r.top + (window.scrollY || 0), height: r.height });
}

function getPinnedProgress(sectionEl) {
  if (!sectionEl) return -1;
  let g = sectionGeom.get(sectionEl);
  if (!g) { cacheSectionGeom(sectionEl); g = sectionGeom.get(sectionEl); }
  const vh = window.innerHeight;
  const total = g.height - vh;
  if (total <= 0) return -1;
  const rectTop = g.top - (window.scrollY || 0);
  const scrolled = Math.min(Math.max(-rectTop, 0), total);
  return scrolled / total;
}

function applyRevealAbsCentered(el, amount) {
  if (!el) return;
  const t = easeSoft(amount);
  const y = (1 - t) * 18;
  const blur = (1 - t) * 1.6;
  setStyleIfChanged(el, String(t), `translate(-50%, -50%) translateY(${y}px)`, `blur(${blur}px)`);
}
function applyRevealCentered(el, amount) {
  if (!el) return;
  const t = easeSoft(amount);
  const y = (1 - t) * 18;
  const blur = (1 - t) * 1.6;
  setStyleIfChanged(el, String(t), `translateY(${y}px)`, `blur(${blur}px)`);
}
function applyRevealFlowCentered(el, amount) {
  if (!el) return;
  const t = easeSoft(amount);
  const y = (1 - t) * 18;
  const blur = (1 - t) * 1.6;
  setStyleIfChanged(el, String(t), `translateY(calc(${y}px + var(--quote-raise)))`, `blur(${blur}px)`);
}
// Only touch the DOM when a value really changes (avoids needless style recalcs).
function setStyleIfChanged(el, opacity, transform, filter) {
  const c = el.__rev || (el.__rev = {});
  if (c.o !== opacity) { el.style.opacity = opacity; c.o = opacity; }
  if (c.t !== transform) { el.style.transform = transform; c.t = transform; }
  if (c.f !== filter) { el.style.filter = filter; c.f = filter; }
}

function snapHalfPx(v) {
  return Math.round(v * 2) / 2;
}

// -----------------------------------------------------
// Fast 2D value noise — the exact algorithm of p5's noise() (4 octaves,
// falloff 0.5, cosine interpolation) specialised for 2 arguments.
// p5 also seeds its table with Math.random() on every load, so the look is identical.
// -----------------------------------------------------
const NOISE_SIZE = 4095;
const NOISE_T = new Float64Array(NOISE_SIZE + 1);
for (let i = 0; i <= NOISE_SIZE; i++) NOISE_T[i] = Math.random();
const SCOS_N = 8192;
const SCOS = new Float64Array(SCOS_N + 2);
for (let i = 0; i <= SCOS_N + 1; i++) SCOS[i] = 0.5 * (1 - Math.cos((i / SCOS_N) * Math.PI));
function scos(t) {
  const f = t * SCOS_N;
  const i = f | 0;
  const a = SCOS[i];
  return a + (SCOS[i + 1] - a) * (f - i);
}
function noise2(x, y) {
  if (x < 0) x = -x;
  if (y < 0) y = -y;
  let xi = Math.floor(x), yi = Math.floor(y);
  let xf = x - xi, yf = y - yi;
  let r = 0, ampl = 0.5;
  for (let o = 0; o < 4; o++) {
    const of = xi + (yi << 4);
    const rxf = scos(xf), ryf = scos(yf);
    let n1 = NOISE_T[of & NOISE_SIZE];
    n1 += rxf * (NOISE_T[(of + 1) & NOISE_SIZE] - n1);
    let n2 = NOISE_T[(of + 16) & NOISE_SIZE];
    n2 += rxf * (NOISE_T[(of + 17) & NOISE_SIZE] - n2);
    n1 += ryf * (n2 - n1);
    r += n1 * ampl;
    ampl *= 0.5;
    xi <<= 1; xf *= 2;
    yi <<= 1; yf *= 2;
    if (xf >= 1) { xi++; xf--; }
    if (yf >= 1) { yi++; yf--; }
  }
  return r;
}

// -----------------------------------------------------
// Square batcher: draws thousands of same-colour squares with individual alpha.
// Squares are grouped by 8-bit alpha level and drawn with fillRect, which gives the
// same picture as one fill()+rect() call per square (same-colour source-over is
// order independent) but is many times faster than going through p5 per dot.
// -----------------------------------------------------
function makeBatch() {
  return { n: 0, cap: 0, x: null, y: null, w: null, h: null, a: null, order: null, counts: new Uint32Array(257), styles: {} };
}
function batchEnsure(b, cap) {
  if (b.cap >= cap) return;
  b.cap = Math.max(cap, b.cap * 2, 1024);
  b.x = new Float32Array(b.cap); b.y = new Float32Array(b.cap);
  b.w = new Float32Array(b.cap); b.h = new Float32Array(b.cap);
  b.a = new Uint8Array(b.cap); b.order = new Uint32Array(b.cap);
}
function batchReset(b, cap) { batchEnsure(b, cap); b.n = 0; }
// (cx, cy) = centre of the square, like p5 rectMode(CENTER)
function batchPush(b, cx, cy, w, h, alpha) {
  let a = Math.round(alpha);
  if (a <= 0) return;
  if (a > 255) a = 255;
  if (b.n >= b.cap) batchEnsure(b, b.n + 1);
  const i = b.n++;
  b.x[i] = cx - w / 2; b.y[i] = cy - h / 2; b.w[i] = w; b.h[i] = h; b.a[i] = a;
}
function batchFlush(b, ctx, rgb) {
  const n = b.n;
  if (n === 0) return;
  const counts = b.counts;
  counts.fill(0);
  for (let i = 0; i < n; i++) counts[b.a[i] + 1]++;
  for (let k = 1; k < 257; k++) counts[k] += counts[k - 1];
  // counts[a] is now the start index of alpha level a
  const order = b.order;
  for (let i = 0; i < n; i++) order[counts[b.a[i]]++] = i;
  let styles = b.styles[rgb];
  if (!styles) styles = b.styles[rgb] = new Array(256);
  let cur = -1;
  for (let j = 0; j < n; j++) {
    const i = order[j];
    const a = b.a[i];
    if (a !== cur) {
      cur = a;
      ctx.fillStyle = styles[a] || (styles[a] = `rgba(${rgb},${a / 255})`);
    }
    ctx.fillRect(b.x[i], b.y[i], b.w[i], b.h[i]);
  }
  b.n = 0;
}
const bustBatch = makeBatch();
const waterBatch = makeBatch();
const cymBatch = makeBatch();
const chaosBatch = makeBatch();

// =====================================================
// DOM REFS
// =====================================================
let loaderEl, loaderTextEl;
let micGateEl, micEnableBtnEl, micSkipBtnEl, micStatusEl;

let dissolveZoneEl,
  silenceSectionEl,
  chaosSectionEl,
  waterSectionEl,
  vibeGapEl,
  vibeSectionEl,
  theorySectionEl,
  timelineSectionEl,
  periodsSectionEl;

let silenceQ1El, silenceQ2El, waterQuoteEl;
let vibeIntroEl, vibeCaptionEl;
let sketchWrapEl = null, phospheneWrapEl = null;

let timelineEl, stageEl, ellipseSvg, ellipseEl, tItems = [];

// chaos blurred layer canvas
let chaosWrapEl = null;
let chaosCanvas = null;
let chaosCtx = null;
let chaosDirty = false;

// =====================================================
// PHOSPHENE SYSTEM (Deep Blue Organic Lights)
// =====================================================
let phospheneCanvas = null;
let phospheneCtx = null;
let phospheneW = 0, phospheneH = 0;
let phospheneLights = [];
const MAX_PHOSPHENES = 6;
let phospheneRAF = 0;
let phospheneIdleFrames = 0;

// =====================================================
// SCROLL ANCHORS
// =====================================================
let DISSOLVE_RANGE_PX = 1;
let SILENCE_START_PX = 0;
let CHAOS_START_PX = 0;
let WATER_START_PX = 0;
let VIBE_GAP_START_PX = 0;
let VIBE_START_PX = 0;
let THEORY_START_PX = 0;

// =====================================================
// p5 STATE
// =====================================================
let img = null;
let bustDots = [];
let bustAssembledCount = 0;
let dissolveProgress = 0;
let imgCenterX = 0, imgCenterY = 0, maxDistFromCenter = 1;
let cellSize = 4;
const IMAGE_AREA_SCALE = 1.04;
const TARGET_CENTER_X = 0.72;
const TARGET_CENTER_Y = 0.54;

// water
let waterField = null;
let ripples = [];
let trailParticles = [];
let gridStep = 5;
let wasInWater = false;

// chaos pixels
let chaosPts = [];
let chaosGrid = 12;

// cymatics
let cymDots = [];
let cymBuilt = false;
let modeA = { n: 2, m: 3, k: 1.0 };
let modeB = { n: 3, m: 5, k: 1.1 };
let modeBlend = 0;
let modeHold = 0;
let smoothMic = 0;

// mic
let mic = null, micEnabled = false, micDenied = false, micStarting = false, fft = null;

// theme
let enteredLight = false;
let curtainOpaque = false;

// layout bookkeeping (mobile toolbars resize the window constantly)
let lastLayoutW = 0, lastLayoutH = 0;

// =====================================================
// CYMATICS LAYOUT
// =====================================================
const CYM_CAPTION_SAFE_PX = 96;
function getCymArea() {
  const usableH = Math.max(1, height - CYM_CAPTION_SAFE_PX);
  const cx = width * 0.50;
  const cy = usableH * 0.52;
  const plateR = Math.min(width, usableH) * 0.49;
  return { cx, cy, plateR, usableH };
}

// =====================================================
// PARTICLE TUNING
// =====================================================
function updateParticleTuning() {
  const minSide = Math.min(window.innerWidth || 1, window.innerHeight || 1);
  const g = Math.round(minSide / 70);
  chaosGrid = Math.max(12, Math.min(18, g));
  const wStep = Math.round(minSide / 220);
  gridStep = Math.max(5, Math.min(8, wStep || 5));
}

// =====================================================
// LOADER & MIC
// =====================================================
function hideLoader() {
  if (!loaderEl) return;
  loaderEl.classList.add("is-hidden");
  loaderEl.setAttribute("aria-busy", "false");
}
function showLoaderError(msg) {
  if (loaderTextEl) loaderTextEl.textContent = msg;
}
function setMicStatus(msg) {
  if (!micStatusEl) return;
  micStatusEl.textContent = msg || "";
}
function getFriendlyMicError(err) {
  const name = (err && err.name) || "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError") return "MICROPHONE BLOCKED — ALLOW IT IN BROWSER SETTINGS.";
  if (name === "NotFoundError" || name === "DevicesNotFoundError") return "NO MICROPHONE DEVICE FOUND.";
  if (name === "NotReadableError" || name === "TrackStartError") return "MICROPHONE IN USE BY ANOTHER APP.";
  return "MICROPHONE FAILED TO START.";
}

async function ensureGUMPermission() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return null;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false,
  });
  return stream;
}

async function resumeP5AudioContext() {
  try { await userStartAudio(); } catch (e) {}
  try { const ctx = getAudioContext(); if (ctx && ctx.state !== "running") await ctx.resume(); } catch (e) {}
}

async function enableMic() {
  if (micEnabled || micDenied || micStarting) return;
  micStarting = true;
  setMicStatus("REQUESTING MICROPHONE…");
  let gumStream = null;
  try {
    await resumeP5AudioContext();
    gumStream = await ensureGUMPermission();
    setMicStatus("MICROPHONE ENABLED.");
    if (!mic) mic = new p5.AudioIn();
    await new Promise((r) => setTimeout(r, 50));
    mic.start(() => {
        micEnabled = true; micDenied = false;
        if (!fft) fft = new p5.FFT(0.82, 1024);
        fft.setInput(mic);
        setMicStatus("MICROPHONE ENABLED.");
        micStarting = false;
        try { if (gumStream) gumStream.getTracks().forEach((t) => t.stop()); } catch (e) {}
      },
      (err) => {
        micEnabled = false; micDenied = true; micStarting = false;
        setMicStatus(getFriendlyMicError(err));
        try { if (gumStream) gumStream.getTracks().forEach((t) => t.stop()); } catch (e) {}
      }
    );
  } catch (err) {
    micEnabled = false; micDenied = true; micStarting = false;
    setMicStatus(getFriendlyMicError(err));
    try { if (gumStream) gumStream.getTracks().forEach((t) => t.stop()); } catch (e) {}
  }
}

function getMicAmp() {
  if (!micEnabled || !mic) return 0;
  const lvl = mic.getLevel();
  const boosted = lvl * 175;
  const compressed = 1 - Math.exp(-boosted * 1.05);
  // UPRAVENO: Zvýšený noise floor (z 0.02 na 0.05), aby se filtroval tichý šum
  const floor = 0.05;
  return clamp01(Math.max(0, compressed - floor) / (1 - floor));
}

function getSpectralEnergy() {
  if (!micEnabled || !fft) return { centroid: 0.25, bass: 0, mid: 0, treble: 0 };
  const spectrum = fft.analyze();
  const centroid = clamp01(fft.getCentroid() / 8000);
  const n = spectrum.length;
  const band = (a, b) => {
    const ia = Math.floor(a * n), ib = Math.floor(b * n);
    let sum = 0;
    for (let i = ia; i < ib; i++) sum += spectrum[i];
    return clamp01((sum / Math.max(1, ib - ia)) / 255);
  };
  return { centroid, bass: band(0.0, 0.1), mid: band(0.1, 0.35), treble: band(0.35, 0.9) };
}

let micGateOpen = true;
function closeMicGate() {
  if (micGateEl) micGateEl.classList.add("is-hidden");
  micGateOpen = false;
  document.body.classList.remove("no-scroll");
  try { if (location.hash) history.replaceState(null, "", location.pathname + location.search); } catch (e) {}
  try { window.scrollTo(0, 0); } catch (e) {}
  requestUI();
}

// =====================================================
// ANCHORS / SCROLL STATE
// =====================================================
function computeStoryAnchors() {
  dissolveZoneEl = document.getElementById("dissolveZone");
  silenceSectionEl = document.getElementById("silenceSection");
  chaosSectionEl = document.getElementById("chaosSection");
  waterSectionEl = document.getElementById("waterSection");
  vibeGapEl = document.querySelector(".vibe-gap");
  vibeSectionEl = document.getElementById("vibeSection");
  theorySectionEl = document.getElementById("theorySection");
  timelineSectionEl = document.getElementById("timelineSection");
  periodsSectionEl = document.getElementById("periodsSection");

  try {
    if (silenceSectionEl && silenceSectionEl.style.height !== "420vh") silenceSectionEl.style.height = "420vh";
    if (waterSectionEl && waterSectionEl.style.height !== "360vh") waterSectionEl.style.height = "360vh";
  } catch (e) {}

  SILENCE_START_PX = silenceSectionEl ? silenceSectionEl.offsetTop : window.innerHeight * 2.2;
  CHAOS_START_PX = chaosSectionEl ? chaosSectionEl.offsetTop : SILENCE_START_PX + window.innerHeight * 1.2;
  WATER_START_PX = waterSectionEl ? waterSectionEl.offsetTop : CHAOS_START_PX + window.innerHeight * 1.2;
  VIBE_GAP_START_PX = vibeGapEl ? vibeGapEl.offsetTop : WATER_START_PX + window.innerHeight * 1.2;
  VIBE_START_PX = vibeSectionEl ? vibeSectionEl.offsetTop : WATER_START_PX + window.innerHeight * 1.2;
  THEORY_START_PX = theorySectionEl ? theorySectionEl.offsetTop : VIBE_START_PX + window.innerHeight * 4.0;
  DISSOLVE_RANGE_PX = Math.max(1, SILENCE_START_PX);

  [silenceSectionEl, waterSectionEl, vibeSectionEl, timelineSectionEl].forEach(cacheSectionGeom);
}

// =====================================================
// UI LOGIC
// =====================================================
function updateSilencePinned() {
  if (!silenceSectionEl) return;
  const p = getPinnedProgress(silenceSectionEl);
  if (p < 0) return;

  const q1In = remap01(p, 0.05, 0.14);
  const q1HoldStart = 0.14; const q1HoldEnd = 0.56;
  const q1Out = remap01(p, 0.56, 0.64);
  let q1 = p < q1HoldStart ? q1In : p < q1HoldEnd ? 1 : 1 - q1Out;

  const q2In = remap01(p, 0.66, 0.74);
  const q2HoldStart = 0.74; const q2HoldEnd = 0.965;
  const q2Out = remap01(p, 0.965, 0.995);
  let q2 = p < q2HoldStart ? q2In : p < q2HoldEnd ? 1 : 1 - q2Out;

  applyRevealAbsCentered(silenceQ1El, q1);
  applyRevealAbsCentered(silenceQ2El, q2);
}

function getWaterEffectStrength() {
  if (!waterSectionEl) return 0;
  const p = getPinnedProgress(waterSectionEl);
  if (p < 0) return 0;
  const inS = easeSoft(remap01(p, 0.08, 0.20));
  const outS = 1 - easeSoft(remap01(p, 0.88, 0.985));
  return clamp01(Math.min(1, inS) * Math.min(1, outS));
}

function updateWaterPinnedText() {
  if (!waterSectionEl || !waterQuoteEl) return;
  const p = getPinnedProgress(waterSectionEl);
  if (p < 0) return;
  const wIn = remap01(p, 0.10, 0.22);
  const wHoldEnd = 0.86;
  const wOut = remap01(p, 0.86, 0.97);
  let w = p < 0.22 ? wIn : p < wHoldEnd ? 1 : 1 - wOut;
  applyRevealFlowCentered(waterQuoteEl, w);
}

function updateVibePinned() {
  if (!vibeSectionEl) return;
  const p = getPinnedProgress(vibeSectionEl);
  if (p < 0) return;
  const inT = remap01(p, 0.10, 0.20);
  const outT = remap01(p, 0.36, 0.46);
  let introA = p < 0.20 ? inT : p < 0.36 ? 1 : 1 - outT;
  applyRevealCentered(vibeIntroEl, introA);

  const capIn = remap01(p, 0.52, 0.62);
  const capOut = remap01(p, 0.86, 0.94);
  let capA = p < 0.62 ? capIn : p < 0.86 ? 1 : 1 - capOut;

  if (vibeCaptionEl) {
    const t = easeSoft(capA);
    const blur = (1 - t) * 1.2;
    setStyleIfChanged(vibeCaptionEl, String(t), `translateX(-50%) translateY(${(1 - t) * 10}px)`, `blur(${blur}px)`);
  }
}

let lastThemeWhite = null, lastThemeText = null;
function updateTheoryFadeAndTheme() {
  if (!vibeSectionEl) return;
  const p = getPinnedProgress(vibeSectionEl);
  if (p < 0) return;
  const TRANSITION_START = 0.82;
  const TRANSITION_END = 0.99;
  const totalSpan = TRANSITION_END - TRANSITION_START;
  const whiteEnd = TRANSITION_START + totalSpan * 0.62;
  const whiteT = easeSoft(remap01(p, TRANSITION_START, whiteEnd));
  const textT = easeSoft(remap01(p, whiteEnd, TRANSITION_END));

  try {
    // Changing a variable on <html> restyles the whole page, so only do it on change.
    const ws = String(whiteT), ts = String(textT);
    if (ws !== lastThemeWhite) { document.documentElement.style.setProperty("--theoryWhite", ws); lastThemeWhite = ws; }
    if (ts !== lastThemeText) { document.documentElement.style.setProperty("--theoryText", ts); lastThemeText = ts; }
  } catch (e) {}

  if (!enteredLight && whiteT > 0.02) {
    enteredLight = true;
    document.body.classList.add("is-light");
  }
  if (enteredLight && whiteT < 0.01) {
    enteredLight = false;
    document.body.classList.remove("is-light");
  }

  // Once the white curtain is fully opaque the dark canvases underneath can't be
  // seen at all — stop compositing them (no visual change, frees the GPU).
  const opaque = whiteT >= 0.9995;
  if (opaque !== curtainOpaque) {
    curtainOpaque = opaque;
    const v = opaque ? "hidden" : "";
    if (sketchWrapEl) sketchWrapEl.style.visibility = v;
    if (chaosWrapEl) chaosWrapEl.style.visibility = v;
    if (phospheneWrapEl) phospheneWrapEl.style.visibility = v;
  }
}

function updateUIStates() {
  const y = window.scrollY || 0;
  if (y > 10) document.body.classList.add("is-scrolled");
  else document.body.classList.remove("is-scrolled");
  dissolveProgress = clamp01(y / DISSOLVE_RANGE_PX);

  updateSilencePinned();
  updateWaterPinnedText();
  updateVibePinned();
  updateTheoryFadeAndTheme();
  updateTimelineByPinnedScroll();
  updateTouchUI(y);
}

// Scroll events can arrive several times per frame; the UI only needs one update per frame.
let uiRAF = 0;
function requestUI() {
  if (uiRAF) return;
  uiRAF = requestAnimationFrame(() => { uiRAF = 0; updateUIStates(); });
}

function setupScroll() {
  computeStoryAnchors();
  updateUIStates();
  window.addEventListener("scroll", requestUI, { passive: true });

  // Anything that changes the page height (fonts arriving, a chapter opening,
  // a mobile toolbar collapsing) refreshes the cached section positions.
  const refresh = () => { computeStoryAnchors(); computeTimelineAnchorsRobust(); requestUI(); };
  try {
    const ro = new ResizeObserver(() => refresh());
    const content = document.getElementById("content");
    if (content) ro.observe(content);
  } catch (e) {}
  try { if (document.fonts && document.fonts.ready) document.fonts.ready.then(refresh); } catch (e) {}
  window.addEventListener("load", refresh);
}

function loadBustImage() {
  loadImage("images/busta_helen.png",
    (loadedImg) => {
      img = loadedImg;
      updateParticleTuning();
      buildBustDots();
      buildChaosField();
      buildWaterDotsField();
      buildCymaticsDots();
      cymBuilt = true;
      requestAnimationFrame(() => hideLoader());
      try { if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { computeTimelineAnchorsRobust(); if (isPhoneLayout()) buildBustDots(); }); } catch (e) {}
    },
    () => showLoaderError("FAILED TO LOAD IMAGE")
  );
}

// =====================================================
// TIMELINE
// =====================================================
let timelineFlipped = true;
const TL_LINE_LENS = [280, 460, 380, 280];
const TL_BASE_STAGE_H = 560;
function setupTimeline() {
  timelineEl = document.getElementById("timeline");
  if (!timelineEl) return;
  stageEl = timelineEl.querySelector(".timeline__stage");
  ellipseSvg = timelineEl.querySelector(".timeline__ellipse");
  ellipseEl = timelineEl.querySelector(".timeline__ellipse ellipse");
  tItems = Array.from(timelineEl.querySelectorAll(".timeline__item"));

  const xPercents = [0.14, 0.38, 0.62, 0.86];

  tItems.forEach((it, i) => {
    it.style.setProperty("--x", `${xPercents[i] * 100}%`);
    it.style.setProperty("--lineLen", `${TL_LINE_LENS[i]}px`);
    it.style.setProperty("--lineProg", "0");
    it.style.setProperty("--labelOpacity", "0");
  });

  if (ellipseSvg) {
    ellipseSvg.style.transform = "translateX(-50%) scaleX(-1)";
    ellipseSvg.style.transformOrigin = "50% 50%";
  }
  if (ellipseEl) ellipseEl.style.strokeDashoffset = "3000";

  computeTimelineAnchorsRobust();
  installTimelineObservers();
}

function installTimelineObservers() {
  if (!stageEl) return;
  try {
    const ro = new ResizeObserver(() => computeTimelineAnchorsRobust());
    ro.observe(stageEl);
  } catch (e) {}
  setTimeout(computeTimelineAnchorsRobust, 150);
}

function computeTimelineAnchorsRobust() {
  if (!stageEl || !ellipseSvg || !tItems || tItems.length === 0) return;
  const stageRect = stageEl.getBoundingClientRect();
  const svgRect = ellipseSvg.getBoundingClientRect();
  const vbW = 1000, vbH = 360, cx0 = 500, cy0 = 180, rx = 460, ry = 150;

  // Smaller stages (phone) scale the vertical lines with the stage. Desktop: factor 1.
  const lenScale = stageRect.height > 0 ? Math.min(1, stageRect.height / TL_BASE_STAGE_H) : 1;

  // The SVG keeps its 1000 × 360 drawing proportional inside its box ("meet"), so on
  // a computer the drawing is inset a few px left and right; the box is also mirrored.
  const boxW = svgRect.width, boxH = svgRect.height;
  const sc = Math.min(boxW / vbW, boxH / vbH);
  const offX = (boxW - vbW * sc) / 2, offY = (boxH - vbH * sc) / 2;

  tItems.forEach((it, idx) => {
    const xPercent = parseFloat(getComputedStyle(it).getPropertyValue("--x")) / 100;
    const clientX = stageRect.left + xPercent * stageRect.width;
    const rel = clientX - svgRect.left;
    const xSvg = ((timelineFlipped ? boxW - rel : rel) - offX) / sc;

    const dx = (xSvg - cx0) / rx;
    const inside = 1 - dx * dx;
    let ySvg = inside <= 0 ? cy0 + ry : cy0 + ry * Math.sqrt(inside);

    const clientY = svgRect.top + offY + ySvg * sc;
    // the line ends exactly on the centre of the ellipse's stroke
    const anchorBottom = Math.max(0, stageRect.bottom - clientY);
    const ab = `${anchorBottom.toFixed(2)}px`;
    if (it.__ab !== ab) { it.style.setProperty("--anchorBottom", ab); it.__ab = ab; }
    const ll = `${lenScale === 1 ? TL_LINE_LENS[idx] : Math.round(TL_LINE_LENS[idx] * lenScale)}px`;
    if (it.__ll !== ll) { it.style.setProperty("--lineLen", ll); it.__ll = ll; }
  });
}

function updateTimelineByPinnedScroll() {
  if (!timelineSectionEl || !timelineEl || !ellipseEl || tItems.length === 0) return;
  const p = getPinnedProgress(timelineSectionEl);
  if (p < 0) return;

  if (!timelineEl.__on) { timelineEl.classList.add("is-on"); timelineEl.__on = true; }
  const eP = clamp01(p / 0.22);
  const off = String(3000 * (1 - eP));
  if (ellipseEl.__off !== off) { ellipseEl.style.strokeDashoffset = off; ellipseEl.__off = off; }

  const itemBlock = 0.17;
  const start0 = 0.26;
  tItems.forEach((it, idx) => {
    const start = start0 + idx * itemBlock;
    const t = clamp01((p - start) / itemBlock);
    const linePhase = 0.65;
    const lineProg = String(clamp01(t / linePhase));
    const textProg = String(clamp01((t - linePhase) / (1 - linePhase)));
    if (it.__lp !== lineProg) { it.style.setProperty("--lineProg", lineProg); it.__lp = lineProg; }
    if (it.__tp !== textProg) { it.style.setProperty("--labelOpacity", textProg); it.__tp = textProg; }
  });
}

// =====================================================
// PERIODS (chapters) — smooth open / close
// The panel animates to its real height (instead of a max-height guess, which
// made the motion jumpy), and the clicked chapter stays put on screen while a
// chapter above it closes.
// =====================================================
const PERIOD_OPEN_MS = 620;
const PERIOD_CLOSE_MS = 480;
const PERIOD_EASE = "cubic-bezier(0.22, 0.61, 0.36, 1)";

function setupPeriods() {
  const items = Array.from(document.querySelectorAll(".js-period"));
  if (items.length === 0) return;

  items.forEach((el) => {
    const c = el.querySelector(".period__content");
    if (c) { c.style.maxHeight = "none"; c.style.height = el.classList.contains("is-open") ? "auto" : "0px"; }
  });

  function animatePanel(el, open) {
    const c = el.querySelector(".period__content");
    if (!c) return;
    const from = c.getBoundingClientRect().height;
    const to = open ? c.scrollHeight : 0;
    const ms = open ? PERIOD_OPEN_MS : PERIOD_CLOSE_MS;
    c.style.transition = "none";
    c.style.height = `${from}px`;
    void c.offsetHeight;
    c.style.transition = `height ${ms}ms ${PERIOD_EASE}`;
    c.style.height = `${to}px`;
    clearTimeout(c.__done);
    const finish = () => {
      if (el.classList.contains("is-open")) { c.style.transition = "none"; c.style.height = "auto"; }
    };
    c.addEventListener("transitionend", function te(ev) {
      if (ev.target !== c || ev.propertyName !== "height") return;
      c.removeEventListener("transitionend", te);
      finish();
    });
    c.__done = setTimeout(finish, ms + 80);
  }

  let anchorRAF = 0;
  function keepInPlace(el, ms) {
    const bar = el.querySelector(".period__bar");
    if (!bar) return;
    cancelAnimationFrame(anchorRAF);
    const startTop = bar.getBoundingClientRect().top;
    const t0 = performance.now();
    const step = () => {
      const drift = bar.getBoundingClientRect().top - startTop;
      if (Math.abs(drift) > 0.5) window.scrollTo({ top: window.scrollY + drift, behavior: "instant" });
      if (performance.now() - t0 < ms + 120) anchorRAF = requestAnimationFrame(step);
    };
    anchorRAF = requestAnimationFrame(step);
  }

  const toggle = (el) => {
    const isOpen = el.classList.contains("is-open");
    let closingAbove = false;
    items.forEach((i) => {
      if (i !== el && i.classList.contains("is-open")) {
        if (i.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) closingAbove = true;
        i.classList.remove("is-open");
        animatePanel(i, false);
      }
    });
    if (isOpen) {
      el.classList.remove("is-open");
      animatePanel(el, false);
    } else {
      el.classList.add("is-open");
      animatePanel(el, true);
      if (closingAbove) keepInPlace(el, PERIOD_CLOSE_MS);
    }
  };

  items.forEach((el) => {
    const bar = el.querySelector(".period__bar");
    if (bar) {
      bar.style.cursor = "pointer";
      bar.addEventListener("click", () => toggle(el));
    }
  });
}

// =====================================================
// CHAOS CANVAS
// =====================================================
function setupChaosCanvas() {
  chaosWrapEl = document.getElementById("chaosWrap");
  if (!chaosWrapEl) return;
  chaosWrapEl.style.zIndex = "0";
  chaosWrapEl.style.pointerEvents = "none";
  chaosCanvas = document.createElement("canvas");
  chaosCanvas.setAttribute("aria-hidden", "true");
  chaosCanvas.style.width = "100%";
  chaosCanvas.style.height = "100%";
  chaosCanvas.style.display = "block";
  chaosWrapEl.appendChild(chaosCanvas);
  chaosCtx = chaosCanvas.getContext("2d", { alpha: true, desynchronized: true });
  resizeChaosCanvas();
}

function resizeChaosCanvas() {
  if (!chaosCanvas) return;
  chaosCanvas.width = window.innerWidth;
  chaosCanvas.height = window.innerHeight;
  chaosDirty = false;
}

// =====================================================
// PHOSPHENE SYSTEM (Dark Mode Lights)
// =====================================================
function setupPhosphenes() {
  phospheneWrapEl = document.getElementById("phospheneWrap");
  phospheneCanvas = document.getElementById("phospheneCanvas");
  if (!phospheneWrapEl || !phospheneCanvas) return;
  phospheneCtx = phospheneCanvas.getContext("2d");
  resizePhospheneCanvas();
  animatePhosphenes();
}

function resizePhospheneCanvas() {
  if (!phospheneCanvas) return;
  phospheneW = phospheneCanvas.width = window.innerWidth;
  phospheneH = phospheneCanvas.height = window.innerHeight;
  phospheneIdleFrames = 0;
}

function shouldShowPhosphenes() {
  if (document.body.classList.contains("is-light")) return false;

  // UPRAVENO: Efekt je aktivní před vodou A TAKÉ v mezeře mezi vodou a zvukem
  const y = window.scrollY || 0;
  const inZone1 = (y > SILENCE_START_PX && y < WATER_START_PX);
  const inZone2 = (y > VIBE_GAP_START_PX && y < VIBE_START_PX);
  return (inZone1 || inZone2);
}

class Phosphene {
  constructor() {
    this.init();
  }

  init() {
    const type = Math.random();
    this.x = Math.random() * phospheneW;
    this.y = Math.random() * phospheneH;

    const hue = 230 + Math.random() * 20;
    const lightness = 30 + Math.random() * 15;

    // ZMENA: Nizsi sytost (ze 100% na 70%)
    this.color = `hsla(${hue}, 70%, ${lightness}%,`;

    this.life = 0;
    this.active = true;

    // Random phase for pulsing
    this.pulsePhase = Math.random() * Math.PI * 2;
    this.pulseSpeed = 0.05 + Math.random() * 0.1;

    if (type < 0.7) {
      // Zjemnění "Breath" typu (kulaté záblesky)
      this.radius = Math.min(phospheneW, phospheneH) * (0.35 + Math.random() * 0.45);
      this.maxAlpha = 0.015 + Math.random() * 0.035;
      this.maxLife = 200 + Math.random() * 200;
      this.vx = (Math.random() - 0.5) * 0.5;
      this.vy = (Math.random() - 0.5) * 0.5;
    } else {
      // Blob (více nepravidelné)
      this.radius = 50 + Math.random() * 150;
      // ZMENA: Nizsi alpha (z 0.15 na 0.08)
      this.maxAlpha = 0.08 + Math.random() * 0.15;
      this.maxLife = 100 + Math.random() * 150;
      this.vx = (Math.random() - 0.5) * 4;
      this.vy = (Math.random() - 0.5) * 4;
    }
  }

  update() {
    this.life++;
    this.x += this.vx;
    this.y += this.vy;

    if (this.x < -200 || this.x > phospheneW + 200) this.vx *= -1;
    if (this.y < -200 || this.y > phospheneH + 200) this.vy *= -1;

    const progress = this.life / this.maxLife;

    // Base breath
    let alpha = Math.sin(progress * Math.PI) * this.maxAlpha;

    // Pulse effect (modulate alpha)
    const pulse = 1 + 0.3 * Math.sin(this.life * this.pulseSpeed + this.pulsePhase);
    this.alpha = alpha * pulse;

    if (this.life >= this.maxLife) {
      this.active = false;
    }
  }

  draw(ctx) {
    ctx.globalCompositeOperation = 'lighter';
    const gradient = ctx.createRadialGradient(this.x, this.y, 0, this.x, this.y, this.radius);
    gradient.addColorStop(0, this.color + this.alpha + ')');
    gradient.addColorStop(1, this.color + '0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = 'source-over';
  }
}

function animatePhosphenes() {
  if (!phospheneCtx) return;
  const show = shouldShowPhosphenes();

  // With no lights left the trail fade converges to a static image after ~2s
  // (8-bit pixels stop changing). Redrawing it after that changes nothing on
  // screen but forces the 60px blur to be recomputed every frame — skip it.
  const idle = !show && phospheneLights.length === 0;
  if (idle && phospheneIdleFrames > 150) {
    phospheneRAF = requestAnimationFrame(animatePhosphenes);
    return;
  }
  phospheneIdleFrames = idle ? phospheneIdleFrames + 1 : 0;

  phospheneCtx.fillStyle = 'rgba(0, 0, 0, 0.1)';
  phospheneCtx.fillRect(0, 0, phospheneW, phospheneH);

  if (show) {
      if (phospheneLights.length < MAX_PHOSPHENES && Math.random() < 0.02) {
          phospheneLights.push(new Phosphene());
      }
  }

  for (let i = phospheneLights.length - 1; i >= 0; i--) {
      const light = phospheneLights[i];
      light.update();
      light.draw(phospheneCtx);
      if (!light.active) phospheneLights.splice(i, 1);
  }

  phospheneRAF = requestAnimationFrame(animatePhosphenes);
}

// =====================================================
// p5 SETUP (Updated to include new setups)
// =====================================================
function setup() {
  document.body.classList.remove("is-light");
  document.body.classList.remove("is-scrolled");
  enteredLight = false;
  try {
    document.documentElement.style.setProperty("--theoryWhite", "0");
    document.documentElement.style.setProperty("--theoryText", "0");
  } catch (e) {}

  loaderEl = document.getElementById("loader");
  loaderTextEl = document.getElementById("loaderText");
  micGateEl = document.getElementById("micGate");
  micEnableBtnEl = document.getElementById("micEnableBtn");
  micSkipBtnEl = document.getElementById("micSkipBtn");
  micStatusEl = document.getElementById("micStatus");
  sketchWrapEl = document.getElementById("sketchWrap");
  setMicStatus("");

  if (micGateEl) micGateEl.classList.remove("is-hidden");
  document.body.classList.add("no-scroll");

  silenceQ1El = document.getElementById("silenceQuote1");
  silenceQ2El = document.getElementById("silenceQuote2");
  waterQuoteEl = document.getElementById("waterQuote");
  vibeIntroEl = document.getElementById("vibeIntro");
  vibeCaptionEl = document.getElementById("vibeCaption");
  if (vibeCaptionEl) vibeCaptionEl.textContent = "SOUNDS BECAME SIGNALS - VIBRATIONS I\u00a0COULD READ WITH MY SKIN.";

  if (micEnableBtnEl) micEnableBtnEl.addEventListener("click", async () => {
    await enableMic();
    closeMicGate();
  });
  if (micSkipBtnEl) micSkipBtnEl.addEventListener("click", () => closeMicGate());

  createCanvas(windowWidth, windowHeight).parent("sketchWrap");
  pixelDensity(1);
  noStroke();
  lastLayoutW = window.innerWidth;
  lastLayoutH = window.innerHeight;

  // p5 binds touchstart/touchmove/touchend to window as non-passive listeners.
  // Nothing here uses them, but their mere presence makes mobile browsers wait for
  // JavaScript before every scroll gesture, which made scrolling stutter. Remove them.
  releaseP5TouchListeners();

  updateParticleTuning();
  setupChaosCanvas();
  setupPhosphenes(); // Dark mode lights
  setupTimeline();
  setupPeriods();
  setupTouch();
  applyPhoneTypesetting();
  setupScroll();
  loadBustImage();
}

function releaseP5TouchListeners() {
  try {
    const inst = p5.instance;
    if (!inst || !inst._events) return;
    ["touchstart", "touchmove", "touchend"].forEach((type) => {
      const fn = inst._events[type];
      if (fn) { window.removeEventListener(type, fn, { passive: false }); window.removeEventListener(type, fn); inst._events[type] = null; }
    });
  } catch (e) {}
}

function windowResized() {
  const w = window.innerWidth, h = window.innerHeight;

  // Mobile browsers resize the window whenever their address bar slides in or out.
  // Rebuilding every particle field then would reset the bust and make things jump,
  // so for height-only changes just grow the canvases if needed and refresh positions.
  if (IS_TOUCH && w === lastLayoutW && lastLayoutH > 0 && Math.abs(h - lastLayoutH) < Math.max(160, lastLayoutH * 0.22)) {
    if (h > height) {
      resizeCanvas(w, h);
      resizeChaosCanvas();
      resizePhospheneCanvas();
    }
    computeStoryAnchors();
    computeTimelineAnchorsRobust();
    requestUI();
    return;
  }
  lastLayoutW = w;
  lastLayoutH = h;

  applyPhoneTypesetting();
  resizeCanvas(windowWidth, windowHeight);
  updateParticleTuning();
  computeStoryAnchors();
  if (img) buildBustDots();
  buildChaosField();
  buildWaterDotsField();
  buildCymaticsDots();
  computeTimelineAnchorsRobust();
  resizeChaosCanvas();
  resizePhospheneCanvas();
  updateUIStates();
}

// =====================================================
// PHONE TYPESETTING
// On the phone's short lines: a one-letter word (A, I) never ends a line, and the
// last two words of a paragraph stay together. The computer keeps its own breaks.
// =====================================================
const TYPESET_SELECTOR = ".hero__subtitle, .theory-subhl, .theory-body p, .period__cols p, .links-subhl, .colophon";
const typesetOriginal = new Map();
let typesetOn = false;
function applyPhoneTypesetting() {
  const want = isPhoneLayout();
  if (want === typesetOn) return;
  typesetOn = want;
  if (!want) { typesetOriginal.forEach((orig, node) => { node.nodeValue = orig; }); return; }
  document.querySelectorAll(TYPESET_SELECTOR).forEach((block) => {
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach((n) => {
      if (!typesetOriginal.has(n)) typesetOriginal.set(n, n.nodeValue);
      n.nodeValue = typesetOriginal.get(n)
        // a one-letter word is joined to the next word with a no-break space
        .replace(/(^|[\s\u00a0(\u201c"\u2014\u2013-])([AaIi])[ \t\n\r]+(?=\S)/g, "$1$2\u00a0")
        // a line never starts with a dash: it stays with the word before it
        .replace(/(\S)\u2014/g, "$1\u2060\u2014")
        // a spelled-out word (w-a-t-e-r) is never split
        .replace(/(\b[a-z])-(?=[a-z]\b)/gi, "$1-\u2060");
    });
    // keep the last two words together
    for (let k = nodes.length - 1; k >= 0; k--) {
      const n = nodes[k];
      const t = n.nodeValue;
      const end = t.replace(/\s+$/, "");
      if (!end) continue;
      const lastSpace = end.search(/[ \t\n\r]+\S+$/);
      if (lastSpace > 0 && end.length - lastSpace < 14) {
        n.nodeValue = end.slice(0, lastSpace) + "\u00a0" + end.slice(lastSpace).replace(/^[ \t\n\r]+/, "") + t.slice(end.length);
      }
      break;
    }
  });
}

// =====================================================
// TOUCH (phones / tablets only)
// =====================================================
let bustTouchEl = null, bustHintEl = null, waterHintEl = null;
const bustTouch = { active: false, x: -9999, y: -9999, id: null };
// Once most of the face is found, the hero scrolls normally again (nothing left to draw).
const BUST_COMPLETE_RATIO = 0.82;
// A finger is wider and less precise than a cursor: on touch a dot joins the face
// a little further from the fingertip (desktop keeps its original 0.8).
const BUST_TOUCH_JOIN = 0.55;
let bustComplete = false;
let waterTouches = 0;

function inWaterZone() {
  const y = window.scrollY || 0;
  return y >= WATER_START_PX && y < VIBE_GAP_START_PX;
}

function setupTouch() {
  bustTouchEl = document.getElementById("bustTouch");
  bustHintEl = document.getElementById("bustHint");
  waterHintEl = document.getElementById("waterHint");
  if (!IS_TOUCH) return;

  // --- BUST: the zone around the face takes the finger (no scrolling while you draw).
  //     Touches on the title/subtitle text scroll the page as usual.
  if (bustTouchEl) {
    bustTouchEl.addEventListener("pointerdown", (ev) => {
      if (micGateOpen || bustComplete) return;
      if (ev.pointerType === "mouse" && !TOUCH_FORCED) return;
      bustTouch.active = true;
      bustTouch.id = ev.pointerId;
      bustTouch.x = ev.clientX; bustTouch.y = ev.clientY;
      try { bustTouchEl.setPointerCapture(ev.pointerId); } catch (e) {}
      ev.preventDefault();
    });
    bustTouchEl.addEventListener("pointermove", (ev) => {
      if (!bustTouch.active || ev.pointerId !== bustTouch.id) return;
      bustTouch.x = ev.clientX; bustTouch.y = ev.clientY;
      ev.preventDefault();
    });
    const end = (ev) => {
      if (ev.pointerId !== bustTouch.id) return;
      bustTouch.active = false;
      bustTouch.id = null;
      checkBustComplete();
    };
    bustTouchEl.addEventListener("pointerup", end);
    bustTouchEl.addEventListener("pointercancel", end);
    bustTouchEl.addEventListener("lostpointercapture", end);
    // iOS: stop the page from rubber-banding while drawing
    bustTouchEl.addEventListener("touchmove", (ev) => { if (bustTouch.active) ev.preventDefault(); }, { passive: false });
  }

  // --- WATER: tap = rings, drag = rings + spray (scrolling still works).
  window.addEventListener("touchstart", (ev) => {
    if (micGateOpen || !inWaterZone()) return;
    const t = ev.touches[0];
    if (!t) return;
    waterPointerDown(t.clientX, t.clientY);
  }, { passive: true });
  window.addEventListener("touchmove", (ev) => {
    const t = ev.touches[0];
    if (!t || micGateOpen) return;
    waterPointer(t.clientX, t.clientY);
  }, { passive: true });
  window.addEventListener("touchend", (ev) => { if (!ev.touches.length) waterPointerUp(); }, { passive: true });
  window.addEventListener("touchcancel", () => waterPointerUp(), { passive: true });

  // Phone preview on a computer: the mouse button acts as a finger.
  if (TOUCH_FORCED) {
    let down = false;
    window.addEventListener("pointerdown", (ev) => {
      if (ev.pointerType !== "mouse" || micGateOpen || !inWaterZone()) return;
      down = true;
      waterPointerDown(ev.clientX, ev.clientY);
    });
    window.addEventListener("pointermove", (ev) => {
      if (ev.pointerType !== "mouse" || !down) return;
      waterPointer(ev.clientX, ev.clientY);
    });
    window.addEventListener("pointerup", () => { if (down) { down = false; waterPointerUp(); } });
  }
}

function checkBustComplete() {
  if (bustComplete || !bustDots.length) return;
  if (bustAssembledCount / bustDots.length >= BUST_COMPLETE_RATIO) {
    bustComplete = true;
    bustTouch.active = false;
    if (bustTouchEl) bustTouchEl.classList.add("is-released");
  }
}

// The bust hint fades away while the face is being found and never returns.
let lastBustHintA = null;
function updateBustHint() {
  if (!IS_TOUCH || !bustHintEl || !bustDots.length) return;
  const ratio = bustAssembledCount / bustDots.length;
  const a = 1 - easeSoft(remap01(ratio, 0.03, 0.72));
  const v = (Math.round(a * 100) / 100).toString();
  if (v !== lastBustHintA) { bustHintEl.style.setProperty("--hint-a", v); lastBustHintA = v; }
}

// Hint visibility follows the story (touch devices only).
let lastBustZoneOn = null, lastWaterHint = null;
function updateTouchUI(y) {
  if (!IS_TOUCH) return;
  // the drawing zone only exists while the hero is at rest at the very top
  const zoneOn = !bustComplete && !micGateOpen && y < 4;
  if (zoneOn !== lastBustZoneOn && bustTouchEl) {
    bustTouchEl.classList.toggle("is-off", !zoneOn);
    lastBustZoneOn = zoneOn;
    if (!zoneOn) bustTouch.active = false;
  }
  if (waterHintEl) {
    const s = getWaterEffectStrength();
    const fadeAfterUse = waterTouches > 40 ? 0 : 1;
    const v = (Math.round(s * fadeAfterUse * 100) / 100).toString();
    if (v !== lastWaterHint) { waterHintEl.style.opacity = v; lastWaterHint = v; }
  }
}

// Bust placement. Desktop: unchanged. Phone portrait: centred in the space
// between the top bar and the title, so the face sits above the text.
function getBustLayout(tw, th) {
  if (isPhoneLayout()) {
    const heroContent = document.querySelector(".hero__content");
    const topbar = document.querySelector(".topbar__inner");
    let top = topbar ? topbar.getBoundingClientRect().bottom + 10 : height * 0.08;
    let bottom = heroContent ? heroContent.getBoundingClientRect().top + (window.scrollY || 0) - 6 : height * 0.6;
    if (bottom - top < height * 0.3) { top = height * 0.06; bottom = height * 0.62; }
    const maxW = width * 0.96;
    const maxH = (bottom - top) * 1.02;
    const scaleFactor = Math.min(maxW / tw, maxH / th) * IMAGE_AREA_SCALE;
    return { scaleFactor, cx: width * 0.5, cy: (top + bottom) / 2 };
  }
  const maxW = width * 0.92;
  const maxH = height * 0.92;
  const scaleFactor = Math.min(maxW / tw, maxH / th) * IMAGE_AREA_SCALE;
  return { scaleFactor, cx: width * TARGET_CENTER_X, cy: height * TARGET_CENTER_Y };
}

// =====================================================
// BUST
// =====================================================
// Which parts of the face have been found, kept for the whole visit (in image
// coordinates), so the face stays found when the layout is rebuilt — e.g. when a
// phone is turned. A new page load starts from scratch.
const BUST_MASK_N = 163;
const bustMask = new Uint8Array(BUST_MASK_N * BUST_MASK_N);
function markBustFound(d) {
  for (let my = d.m0y; my <= d.m1y; my++) for (let mx = d.m0x; mx <= d.m1x; mx++) bustMask[my * BUST_MASK_N + mx] = 1;
}

// On a phone the face is drawn much smaller than on a computer. Sampling the
// photo just as finely would pack the dots ~5× tighter than on the computer, so
// the photo is first reduced so that the dots keep the computer's spacing.
const BUST_DESKTOP_SPACING = 5.3;   // px between dots on a 1440 × 900 screen
function getBustSourcePixels() {
  const src = img;
  let tw = src.width, th = src.height;
  const maxSize = 650;
  if (tw > th && tw > maxSize) { th = Math.round(th * maxSize / tw); tw = maxSize; }
  else if (th >= tw && th > maxSize) { tw = Math.round(tw * maxSize / th); th = maxSize; }
  if (!isPhoneLayout()) {
    // desktop: exactly the original sampling
    const temp = img.get();
    if (temp.width > temp.height && temp.width > maxSize) temp.resize(maxSize, 0);
    else if (temp.height >= temp.width && temp.height > maxSize) temp.resize(0, maxSize);
    temp.loadPixels();
    return { width: temp.width, height: temp.height, pixels: temp.pixels };
  }
  const probe = getBustLayout(tw, th);
  const dispW = tw * probe.scaleFactor;
  const k = Math.min(1, (cellSize * dispW / BUST_DESKTOP_SPACING) / tw);
  const W = Math.max(40, Math.round(tw * k)), H = Math.max(40, Math.round(th * k));
  // reduce in halves for a clean, averaged result on every browser
  let cur = src.canvas || src.elt;
  let cw = src.width, ch = src.height;
  while (cw / 2 >= W && ch / 2 >= H) {
    const c = document.createElement("canvas");
    c.width = Math.round(cw / 2); c.height = Math.round(ch / 2);
    const g = c.getContext("2d");
    g.imageSmoothingEnabled = true; g.imageSmoothingQuality = "high";
    g.drawImage(cur, 0, 0, c.width, c.height);
    cur = c; cw = c.width; ch = c.height;
  }
  const out = document.createElement("canvas");
  out.width = W; out.height = H;
  const og = out.getContext("2d", { willReadFrequently: true });
  og.imageSmoothingEnabled = true; og.imageSmoothingQuality = "high";
  og.drawImage(cur, 0, 0, W, H);
  return { width: W, height: H, pixels: og.getImageData(0, 0, W, H).data };
}

function buildBustDots() {
  if (!img) return;
  bustDots = [];
  bustAssembledCount = 0;
  const temp = getBustSourcePixels();

  const layout = getBustLayout(temp.width, temp.height);
  let scaleFactor = layout.scaleFactor;
  const dispW = temp.width * scaleFactor;
  const dispH = temp.height * scaleFactor;
  const targetCx = layout.cx;
  const targetCy = layout.cy;
  const offsetX = targetCx - dispW / 2;
  const offsetY = targetCy - dispH / 2;

  imgCenterX = offsetX + dispW / 2;
  imgCenterY = offsetY + dispH / 2;
  maxDistFromCenter = 0;

  const initialSpread = Math.min(width, height) * 0.34;
  const dissolveSpread = Math.max(width, height) * 0.95;
  const MN = BUST_MASK_N;

  for (let y = 0; y < temp.height; y += cellSize) {
    for (let x = 0; x < temp.width; x += cellSize) {
      const idx = 4 * (y * temp.width + x);
      if (temp.pixels[idx + 3] < 10) continue;
      const bright = (temp.pixels[idx] + temp.pixels[idx + 1] + temp.pixels[idx + 2]) / 3;
      const strength = 1 - bright / 255.0;
      if (strength < 0.02) continue;

      const bx = offsetX + x * scaleFactor;
      const by = offsetY + y * scaleFactor;
      const size = map(strength, 0, 1, 1.2, cellSize * 1.15);
      const a1 = random(TWO_PI);
      const ix = bx + cos(a1) * initialSpread;
      const iy = by + sin(a1) * initialSpread;
      const a2 = random(TWO_PI);
      const dx = bx + cos(a2) * dissolveSpread * (0.8 + random(0.5));
      const dy = by + sin(a2) * dissolveSpread * (0.8 + random(0.5));

      const distToCenter = dist(bx, by, imgCenterX, imgCenterY);
      if (distToCenter > maxDistFromCenter) maxDistFromCenter = distToCenter;

      // this dot's footprint in the found-parts mask
      const m0x = Math.min(MN - 1, Math.floor(x / temp.width * MN)), m1x = Math.min(MN - 1, Math.max(m0x, Math.ceil((x + cellSize) / temp.width * MN) - 1));
      const m0y = Math.min(MN - 1, Math.floor(y / temp.height * MN)), m1y = Math.min(MN - 1, Math.max(m0y, Math.ceil((y + cellSize) / temp.height * MN) - 1));
      const found = bustMask[(((m0y + m1y) >> 1) * MN) + ((m0x + m1x) >> 1)] === 1;
      if (found) bustAssembledCount++;

      bustDots.push({ bx, by, ix, iy, dx, dy, cx: ix, cy: iy, size, state: found ? "assembled" : "scattered", jitterSeed: random(1000), distToCenter, m0x, m1x, m0y, m1y });
    }
  }
  if (IS_TOUCH) { checkBustComplete(); updateBustHint(); }
}

function drawBust(ctx) {
  if (!img || bustDots.length === 0) return;
  let hovering, mx, my;
  if (IS_TOUCH) {
    // a finger only "hovers" while it touches the glass
    hovering = bustTouch.active;
    mx = bustTouch.x; my = bustTouch.y;
  } else {
    mx = mouseX; my = mouseY;
    hovering = mx >= 0 && mx <= width && my >= 0 && my <= height;
  }
  const allowHoverAssemble = dissolveProgress === 0;
  const radius = Math.min(width, height) * 0.3;
  const radius2 = radius * radius;
  const joinAt = IS_TOUCH ? BUST_TOUCH_JOIN : 0.8;
  const fc = frameCount;
  const dp = dissolveProgress;
  const b = bustBatch;
  batchReset(b, bustDots.length);

  for (let i = 0, n = bustDots.length; i < n; i++) {
    const d = bustDots[i];
    let targetX = d.ix;
    let targetY = d.iy;

    if (d.state === "scattered") {
      const amp = 2.2;
      const tt = fc * 0.03 + d.jitterSeed;
      targetX = d.ix + Math.sin(tt) * amp;
      targetY = d.iy + Math.cos(tt * 1.2) * amp;
    }

    if (allowHoverAssemble && hovering) {
      const ddx = mx - d.bx, ddy = my - d.by;
      const d2 = ddx * ddx + ddy * ddy;
      if (d2 < radius2) {
        const f = 1 - Math.sqrt(d2) / radius;
        targetX = (d.bx - d.ix) * f + d.ix;
        targetY = (d.by - d.iy) * f + d.iy;
        if (f > joinAt) { if (d.state !== "assembled") { bustAssembledCount++; markBustFound(d); } d.state = "assembled"; }
        else if (d.state !== "assembled") d.state = "assembling";
      }
    }

    if (d.state === "assembled" && dp === 0) {
      const amp = 1.5;
      const tt = fc * 0.05 + d.jitterSeed;
      targetX = d.bx + Math.sin(tt) * amp;
      targetY = d.by + Math.cos(tt * 1.3) * amp;
    }

    if (dp > 0) {
      const edgeFactor = d.distToCenter / maxDistFromCenter;
      const start = (1 - edgeFactor) * 0.55;
      let local = (dp - start) / (1 - start);
      local = local < 0 ? 0 : local > 1 ? 1 : local;
      targetX = (d.dx - d.bx) * local + d.bx;
      targetY = (d.dy - d.by) * local + d.by;
      const alpha = 255 * (1 - local);
      d.cx = (targetX - d.cx) * 0.03 + d.cx;
      d.cy = (targetY - d.cy) * 0.03 + d.cy;
      if (alpha > 0.8) {
        const s = d.size * (0.12 + 0.88 * (1 - local));
        batchPush(b, d.cx, d.cy, s, s, alpha);
      }
      continue;
    }

    const speed = d.state === "assembled" || d.state === "assembling" ? 0.28 : 0.03;
    d.cx = (targetX - d.cx) * speed + d.cx;
    d.cy = (targetY - d.cy) * speed + d.cy;
    batchPush(b, d.cx, d.cy, d.size, d.size, 255);
  }
  batchFlush(b, ctx, "245,245,245");
  if (IS_TOUCH && hovering) { updateBustHint(); checkBustComplete(); }
}

// =====================================================
// CHAOS DRAW
// =====================================================
function buildChaosField() {
  chaosPts = [];
  for (let y = 0; y < height; y += chaosGrid) {
    for (let x = 0; x < width; x += chaosGrid) {
      chaosPts.push({ x, y, seed: random(1000) });
    }
  }
}

function drawChaosPixelsToCtx(strength) {
  if (!chaosCtx || !chaosCanvas) return;
  const visible = !(chaosPts.length === 0 || strength <= 0.001 || document.body.classList.contains("is-light"));
  if (!visible) {
    // nothing to show: clear once, then leave the (blurred) layer alone
    if (chaosDirty) { chaosCtx.clearRect(0, 0, chaosCanvas.width, chaosCanvas.height); chaosDirty = false; }
    return;
  }
  chaosCtx.clearRect(0, 0, chaosCanvas.width, chaosCanvas.height);
  chaosDirty = true;

  const fc = frameCount;
  const tt = fc * 0.020;
  const density = 0.42;
  const g = chaosGrid;
  const b = chaosBatch;
  batchReset(b, chaosPts.length);

  for (let i = 0; i < chaosPts.length; i++) {
    const p = chaosPts[i];
    const n = noise2(p.seed * 0.05, tt);
    const pulse = (0.55 + 0.45 * Math.sin(p.seed * 0.8 + fc * 0.055)) * 0.55 + n * 0.45;
    if (Math.random() > density * (0.40 + 0.60 * pulse)) continue;
    const a = (38 + 88 * (0.55 + 0.45 * pulse)) * strength;
    if (a < 2) continue;
    batchPush(b, p.x + g / 2, p.y + g / 2, g, g, a);
  }
  batchFlush(b, chaosCtx, "18,18,18");
}

function getGlobalChaosOverlayStrength() {
  if (document.body.classList.contains("is-light")) return 0;
  const y = window.scrollY || 0;
  if (y < SILENCE_START_PX) return 0;
  const base = 0.78;
  const fadeOutStart = THEORY_START_PX - window.innerHeight * 0.85;
  const fadeOutEnd = THEORY_START_PX - window.innerHeight * 0.10;
  const fade = 1 - easeSoft(remap01(y, fadeOutStart, fadeOutEnd));
  return clamp01(base * fade);
}

// =====================================================
// WATER
// Dots live on a regular grid, so each ripple only visits the dots inside its
// own radius instead of every dot on screen (same maths, far less work).
// =====================================================
function buildWaterDotsField() {
  const step = gridStep;
  const centerX = width / 2;
  const centerY = height / 2;
  const waterRadius = Math.min(width, height) * 1.5;
  const cols = Math.ceil(width / step);
  const rows = Math.ceil(height / step);
  const idx = new Int32Array(cols * rows).fill(-1);
  const bx = [], by = [], size = [];
  for (let r = 0, y = 0; y < height; y += step, r++) {
    for (let c = 0, x = 0; x < width; x += step, c++) {
      if (dist(x, y, centerX, centerY) > waterRadius) continue;
      idx[r * cols + c] = bx.length;
      bx.push(x); by.push(y); size.push(random(step * 0.4, step * 0.9));
    }
  }
  const n = bx.length;
  waterField = {
    step, cols, rows, idx, n,
    bx: Float32Array.from(bx), by: Float32Array.from(by),
    cx: Float32Array.from(bx), cy: Float32Array.from(by),
    size: Float32Array.from(size),
    ox: new Float32Array(n), oy: new Float32Array(n), s: new Float32Array(n),
    mark: new Uint32Array(n), touched: new Int32Array(n), frame: 0,
  };
}

// ---- WATER CLOCK ----------------------------------------------------------
// The water was designed while it ran at about 25 frames a second, and its look
// depended on that speed: one ring is born per frame, the last 20 rings make the
// wake, the spray drifts a little every frame. Drawn at 60 frames a second the
// wake became short and knotted. So the water now "lives" on that same clock —
// 25 steps a second — while the picture in between is drawn smoothly.
const WATER_TICK_MS = 40;
let waterAcc = 0;
let waterClockT = -1;
const waterPtr = { x: 0, y: 0, px: 0, py: 0, has: false, moved: false };

function waterPointer(x, y) {
  if (!waterPtr.has) { waterPtr.px = x; waterPtr.py = y; waterPtr.has = true; }
  waterPtr.x = x; waterPtr.y = y; waterPtr.moved = true;
}
function waterPointerDown(x, y) {
  waterPtr.has = false;
  waterPointer(x, y);
  waterPtr.moved = false;
  emitWater(x, y, x, y, true);   // a tap makes rings straight away
}
function waterPointerUp() { waterPtr.has = false; waterPtr.moved = false; }

// One step of the clock: what one mouse event per frame did originally.
function waterTick(inWater) {
  if (!waterPtr.has) return;
  if (inWater && waterPtr.moved) emitWater(waterPtr.x, waterPtr.y, waterPtr.px, waterPtr.py, false);
  waterPtr.moved = false;
  waterPtr.px = waterPtr.x; waterPtr.py = waterPtr.y;
}

// The original mouseMoved() body (rings + spray), unchanged.
function emitWater(x, y, px, py, isTap) {
  if (!inWaterZone()) return;
  const strength = getWaterEffectStrength();
  if (strength < 0.12) return;

  const now = millis();
  ripples.push({ x, y, born: now });
  if (ripples.length > 20) ripples.shift();

  let dirX = x - px;
  let dirY = y - py;
  const moved = Math.sqrt(dirX * dirX + dirY * dirY);
  const len = moved || 1;
  dirX /= len; dirY /= len;
  const count = isTap ? 5 : Math.floor(map(moved, 0, 40, 1, 6, true));

  for (let i = 0; i < count; i++) {
    const baseV = random(1.0, 3.0);
    let vx = dirX * baseV + random(-0.3, 0.3), vy = dirY * baseV + random(-0.3, 0.3);
    if (isTap) { const a = Math.random() * Math.PI * 2; vx = Math.cos(a) * baseV; vy = Math.sin(a) * baseV; }
    trailParticles.push({
      x: x + random(-6, 6), y: y + random(-6, 6),
      vx, vy,
      life: 0, maxLife: random(30, 70), size: random(2, 4)
    });
  }
  if (trailParticles.length > 250) trailParticles.splice(0, trailParticles.length - 250);
  if (IS_TOUCH) waterTouches++;
}

function mouseMoved() {
  if (IS_TOUCH) return;
  waterPointer(mouseX, mouseY);
}

// sine table (8192 samples, linear interpolation, error < 1e-7)
const SIN_N = 8192;
const SIN_LUT = new Float64Array(SIN_N + 1);
for (let i = 0; i <= SIN_N; i++) SIN_LUT[i] = Math.sin((i / SIN_N) * Math.PI * 2);
const SIN_SCALE = SIN_N / (Math.PI * 2);
function fastSin(x) {
  const t = x * SIN_SCALE;
  const f = Math.floor(t);
  const i = f & (SIN_N - 1);
  const a = SIN_LUT[i];
  return a + (SIN_LUT[i + 1] - a) * (t - f);
}

function drawRippleDots(ctx, strength, q) {
  const F = waterField;
  if (!F || F.n === 0 || ripples.length === 0) return;
  const now = millis();
  const maxRippleAge = 1500;
  ripples = ripples.filter((r) => now - r.born < maxRippleAge);
  if (ripples.length === 0) return;

  const { step, cols, rows, idx, bx, by, ox, oy, s, mark, touched } = F;
  const frame = ++F.frame;
  let nT = 0;
  const maxRadius = Math.min(width, height) * 0.45;
  const maxR2 = maxRadius * maxRadius;

  for (let k = 0; k < ripples.length; k++) {
    const r = ripples[k];
    const age = now - r.born;
    const ageNorm = age / maxRippleAge;
    const fade = 1 - ageNorm;
    const phaseT = age * 0.025;
    const c0 = Math.max(0, Math.floor((r.x - maxRadius) / step));
    const c1 = Math.min(cols - 1, Math.ceil((r.x + maxRadius) / step));
    const r0 = Math.max(0, Math.floor((r.y - maxRadius) / step));
    const r1 = Math.min(rows - 1, Math.ceil((r.y + maxRadius) / step));
    for (let row = r0; row <= r1; row++) {
      const base = row * cols;
      for (let col = c0; col <= c1; col++) {
        const i = idx[base + col];
        if (i < 0) continue;
        const dx = bx[i] - r.x, dy = by[i] - r.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > maxR2) continue;
        const distToCenter = Math.sqrt(d2);
        const wave = fastSin(distToCenter * 0.045 - phaseT) * (1 - distToCenter / maxRadius) * fade;
        const len = distToCenter || 1;
        if (mark[i] !== frame) { mark[i] = frame; ox[i] = 0; oy[i] = 0; s[i] = 0; touched[nT++] = i; }
        ox[i] += (dx / len) * wave * 22;
        oy[i] += (dy / len) * wave * 22;
        const sv = Math.abs(wave) * fade;
        if (sv > s[i]) s[i] = sv;
      }
    }
  }

  const { cx, cy, size } = F;
  const b = waterBatch;
  // 0.3 per clock step, spread over the frames actually drawn
  const follow = 1 - Math.pow(0.7, q);
  batchReset(b, nT);
  for (let j = 0; j < nT; j++) {
    const i = touched[j];
    const sv = s[i];
    if (sv < 0.15) continue;
    cx[i] = (bx[i] + ox[i] - cx[i]) * follow + cx[i];
    cy[i] = (by[i] + oy[i] - cy[i]) * follow + cy[i];
    const tn = Math.min(1, (sv - 0.15) / 0.85);
    const alpha = (80 + tn * 175) * strength;
    if (alpha < 2) continue;
    const finalSize = size[i] * (0.6 + tn * 0.8);
    batchPush(b, cx[i], cy[i], finalSize, finalSize, alpha);
  }
  batchFlush(b, ctx, "255,255,255");
}

function drawTrailParticles(ctx, strength, q) {
  // speed, life and wobble are per clock step; q = clock steps in this frame
  const wob = Math.sqrt(q);
  for (let i = trailParticles.length - 1; i >= 0; i--) {
    const p = trailParticles[i];
    p.life += q;
    const lifeNorm = p.life / p.maxLife;
    if (lifeNorm >= 1) { trailParticles.splice(i, 1); continue; }
    p.x += p.vx * q + (Math.random() * 1.4 - 0.7) * (1 - lifeNorm) * wob;
    p.y += p.vy * q + (Math.random() * 1.4 - 0.7) * (1 - lifeNorm) * wob;
    const alpha = 255 * (1 - lifeNorm) * strength;
    if (alpha < 2) { if (strength < 0.2) trailParticles.splice(i, 1); continue; }
    const bright = Math.round(210 + 45 * (1 - lifeNorm));
    ctx.fillStyle = `rgba(${bright},${bright},${bright},${Math.min(1, alpha / 255)})`;
    ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
  }
}

// =====================================================
// CYMATICS
// =====================================================
function buildCymaticsDots() {
  cymDots = [];
  const area = getCymArea();
  const count = Math.floor(Math.min(32000, Math.max(6500, Math.max(1, width * area.usableH) / 45)));
  const scatter = Math.max(width, area.usableH) * 1.08;
  for (let i = 0; i < count; i++) {
    const ang = random(TWO_PI);
    const rad = area.plateR * Math.sqrt(random());
    const bx = area.cx + Math.cos(ang) * rad + random(-4, 4);
    const by = area.cy + Math.sin(ang) * rad + random(-4, 4);
    const a2 = random(TWO_PI);
    cymDots.push({
      bx, by, cx: bx, cy: by,
      dx: bx + Math.cos(a2) * scatter * (0.55 + random(0.55)),
      dy: by + Math.sin(a2) * scatter * (0.55 + random(0.55)),
      size: random(1.0, 3.0), seed: random(10000)
    });
  }
}

// Field value; A = precomputed area constants for this frame (same formula as before).
function cymField(x, y, n, m, k, phase, A) {
  const dx = x - A.cx, dy = y - A.cy;
  const r = Math.sqrt(dx * dx + dy * dy) * A.invR;
  const a = Math.atan2(dy, dx);
  const v1 = Math.sin(n * a + phase) * 0.95;
  const v2 = Math.cos(m * a - phase * 0.6) * 0.8;
  const v3 = Math.sin((n + m) * a * 0.5 + phase * 0.22) * 0.38;
  const vr1 = Math.cos(k * 7.1 * r + phase * 0.4);
  const vr2 = Math.cos(k * 3.6 * r - phase * 0.18) * 0.48;
  return (v1 + v2 + v3) * vr1 + vr2;
}

// The field splits into an angular part g(a) and two radial parts R1(r), R2(r):
// f = g(a) * R1(r) + R2(r). Each frame these are tabulated once (4096 samples,
// linear interpolation, error < 1e-4) so 32 000 dots × 3 evaluations no longer
// cost ~100 000 trig calls per frame.
const CYM_ANG_N = 4096;
const CYM_RAD_N = 4096;
const CYM_RAD_MAX = 2.5;
const cymAngLUT = new Float64Array(CYM_ANG_N + 2);
const cymR1LUT = new Float64Array(CYM_RAD_N + 2);
const cymR2LUT = new Float64Array(CYM_RAD_N + 2);
const CYM_ANG_SCALE = CYM_ANG_N / (Math.PI * 2);
const CYM_RAD_SCALE = CYM_RAD_N / CYM_RAD_MAX;
let cymLUTn = 0, cymLUTm = 0, cymLUTk = 0, cymLUTphase = 0;
function buildCymLUT(n, m, k, phase) {
  cymLUTn = n; cymLUTm = m; cymLUTk = k; cymLUTphase = phase;
  for (let j = 0; j <= CYM_ANG_N + 1; j++) {
    const a = -Math.PI + j / CYM_ANG_SCALE;
    cymAngLUT[j] = Math.sin(n * a + phase) * 0.95 + Math.cos(m * a - phase * 0.6) * 0.8 + Math.sin((n + m) * a * 0.5 + phase * 0.22) * 0.38;
  }
  for (let j = 0; j <= CYM_RAD_N + 1; j++) {
    const r = j / CYM_RAD_SCALE;
    cymR1LUT[j] = Math.cos(k * 7.1 * r + phase * 0.4);
    cymR2LUT[j] = Math.cos(k * 3.6 * r - phase * 0.18) * 0.48;
  }
}
// atan2 approximation (max error ≈ 1e-5 rad)
function fastAtan2(y, x) {
  const ax = x < 0 ? -x : x, ay = y < 0 ? -y : y;
  const mx = ax > ay ? ax : ay, mn = ax > ay ? ay : ax;
  if (mx === 0) return 0;
  const a = mn / mx;
  const s = a * a;
  let r = (((-0.0134804 * s + 0.0574773) * s - 0.1212390) * s + 0.1956359) * s;
  r = ((r - 0.3329946) * s + 0.9999993) * a;
  if (ay > ax) r = 1.5707963267948966 - r;
  if (x < 0) r = 3.141592653589793 - r;
  return y < 0 ? -r : r;
}
function cymFieldFast(x, y, A) {
  const dx = x - A.cx, dy = y - A.cy;
  const r = Math.sqrt(dx * dx + dy * dy) * A.invR;
  if (r >= CYM_RAD_MAX) return cymField(x, y, cymLUTn, cymLUTm, cymLUTk, cymLUTphase, A);
  let t = (fastAtan2(dy, dx) + Math.PI) * CYM_ANG_SCALE;
  let i = t | 0;
  const ga = cymAngLUT[i] + (cymAngLUT[i + 1] - cymAngLUT[i]) * (t - i);
  t = r * CYM_RAD_SCALE;
  i = t | 0;
  const fr = t - i;
  const r1 = cymR1LUT[i] + (cymR1LUT[i + 1] - cymR1LUT[i]) * fr;
  const r2 = cymR2LUT[i] + (cymR2LUT[i + 1] - cymR2LUT[i]) * fr;
  return ga * r1 + r2;
}

function cymFieldPx(x, y, n, m, k, phase) {
  const area = getCymArea();
  return cymField(x, y, n, m, k, phase, { cx: area.cx, cy: area.cy, invR: 1 / (Math.min(width, area.usableH) * 0.36) });
}

function updateCymaticsMode() {
  const amp = getMicAmp();
  // UPRAVENO: Nižší lerp faktor (0.12) = jemnější, pomalejší reakce
  smoothMic = lerp(smoothMic, amp, 0.12);
  const spec = micEnabled ? getSpectralEnergy() : { centroid: 0.26, bass: 0.12, mid: 0.1, treble: 0.08 };

  if (modeHold <= 0) {
    modeA = { ...modeB };
    const c = spec.centroid;
    const base = c < 0.18 ? 2 : c < 0.32 ? 3 : c < 0.48 ? 4 : c < 0.62 ? 5 : c < 0.78 ? 6 : 7;
    const boost = amp > 0.55 ? 3 : amp > 0.28 ? 2 : amp > 0.12 ? 1 : 0;
    modeB = {
      n: Math.max(2, Math.min(11, base + (spec.bass > 0.18 ? 1 : 0) + boost)),
      m: Math.max(3, Math.min(14, base + 1 + (spec.treble > 0.14 ? 2 : 0) + boost)),
      k: Math.max(0.9, Math.min(2.9, 0.92 + spec.bass * 1.05 + amp * 1.10))
    };
    modeBlend = 0;
    modeHold = Math.floor(lerp(52, 6, smoothMic));
  } else {
    modeHold--;
    modeBlend = clamp01(modeBlend + 0.034 + smoothMic * 0.11);
  }
}

function drawCymaticsDots(ctx) {
  if (!vibeSectionEl || !cymBuilt || cymDots.length === 0) return;
  const p = getPinnedProgress(vibeSectionEl);
  if (p < 0) return;
  const on = easeSoft(remap01(p, 0.50, 0.62));
  if (on <= 0.001) return;

  const dP = easeSoft(remap01(p, 0.935, 0.995));
  const whiteFade = easeSoft(remap01(p, 0.82, 0.90));
  const globalAlpha = (1 - whiteFade) * (1 - dP) * on;
  if (globalAlpha <= 0.001) return;

  updateCymaticsMode();
  const n = Math.round(lerp(modeA.n, modeB.n, modeBlend));
  const m = Math.round(lerp(modeA.m, modeB.m, modeBlend));
  const k = lerp(modeA.k, modeB.k, modeBlend);
  const fc = frameCount;
  const phase = fc * (0.011 + smoothMic * 0.22);
  const area = getCymArea();
  const A = { cx: area.cx, cy: area.cy, invR: 1 / (Math.min(width, area.usableH) * 0.36) };
  const plateR = area.plateR, usableH = area.usableH;

  const stepBase = 0.65 + smoothMic * 10.5;
  // UPRAVENO: Méně chaotický jitter (sníženo násobení)
  const jitter = 0.45 + smoothMic * 2.4;

  const sh = smoothMic * 16.0;
  const sx = (noise2(fc * 0.06, 0) - 0.5) * sh;
  const sy = (noise2(999 + fc * 0.06, 0) - 0.5) * sh;

  const b = cymBatch;
  batchReset(b, cymDots.length + 128);

  // sparkles
  for (let i = 0; i < Math.floor(12 + smoothMic * 78); i++) {
    const ang = Math.random() * Math.PI * 2, rad = plateR * Math.sqrt(Math.random());
    const x = A.cx + Math.cos(ang) * rad + sx * 0.25, y = A.cy + Math.sin(ang) * rad + sy * 0.25;
    if (y > 0 && y < usableH) {
      const a = (24 + 135 * smoothMic) * globalAlpha;
      if (a > 2) batchPush(b, x, y, 1.6 + Math.random() * 1.8, 1.6 + Math.random() * 1.8, a);
    }
  }

  const tA = fc * 0.01, tJ = fc * 0.085;
  const sharp = 1.25 + smoothMic * 9.8;
  const alphaMul = globalAlpha * (0.92 + smoothMic * 0.62);
  const moving = dP < 0.985;
  const keepChance = 0.14 + smoothMic * 0.26;
  const TWO_PI_2 = Math.PI * 4;

  buildCymLUT(n, m, k, phase);

  for (let i = 0, N = cymDots.length; i < N; i++) {
    const d = cymDots[i];
    if (moving) {
      const ang = noise2(d.seed * 0.001, tA) * TWO_PI_2;
      const ax = Math.cos(ang) * (stepBase + (Math.random() * 0.9 - 0.45)), ay = Math.sin(ang) * (stepBase + (Math.random() * 0.9 - 0.45));
      const v0 = Math.abs(cymFieldFast(d.cx, d.cy, A));
      const x1 = d.cx + ax, y1 = d.cy + ay;
      const v1 = Math.abs(cymFieldFast(x1, y1, A));

      if (v1 < v0 || Math.random() < keepChance) { d.cx = (x1 - d.cx) * 0.90 + d.cx; d.cy = (y1 - d.cy) * 0.90 + d.cy; }
      else { d.cx = ax * 0.22 * 0.40 + d.cx; d.cy = ay * 0.22 * 0.40 + d.cy; }

      d.cx += (noise2(d.seed * 0.01, tJ) - 0.5) * jitter;
      d.cy += (noise2(d.seed * 0.01 + 50, tJ) - 0.5) * jitter;

      const ddx = d.cx - A.cx, ddy = d.cy - A.cy;
      const rr = Math.sqrt(ddx * ddx + ddy * ddy);
      if (rr > plateR) { const s = plateR / Math.max(1, rr); d.cx = A.cx + ddx * s; d.cy = A.cy + ddy * s; }
      d.cy = d.cy < 0 ? 0 : d.cy > usableH ? usableH : d.cy;
    }

    const drawX = (d.dx - d.cx) * dP + d.cx + sx;
    const drawY = (d.dy - d.cy) * dP + d.cy + sy;
    if (drawY < 0 || drawY > usableH) continue;

    const f = Math.abs(cymFieldFast(d.cx, d.cy, A));
    const closeness = Math.exp(-f * sharp);
    if (closeness < 0.040) continue;
    const a = (24 + 260 * closeness * closeness) * alphaMul;
    if (a < 2) continue;
    batchPush(b, drawX, drawY, d.size, d.size, a);
  }
  batchFlush(b, ctx, "255,255,255");
}

// =====================================================
// DRAW MAIN
// =====================================================
let mainCanvasBlank = false;
function draw() {
  const ctx = drawingContext;
  const y = window.scrollY || 0;

  // Fully covered by the white curtain: nothing on this canvas can be seen.
  if (curtainOpaque) {
    drawChaosPixelsToCtx(0);
    return;
  }

  // background(21, 21, 21)
  ctx.globalAlpha = 1;
  ctx.fillStyle = "rgb(21,21,21)";
  ctx.fillRect(0, 0, width, height);

  const inWater = y >= WATER_START_PX && y < VIBE_GAP_START_PX;
  if (wasInWater && !inWater) { ripples = []; trailParticles = []; }
  wasInWater = inWater;

  // water clock (see WATER CLOCK)
  const tNow = millis();
  let dt = waterClockT < 0 ? WATER_TICK_MS : tNow - waterClockT;
  waterClockT = tNow;
  if (!(dt >= 0)) dt = 0;
  if (dt > 100) dt = 100;
  waterAcc += dt;
  let steps = 0;
  while (waterAcc >= WATER_TICK_MS) { waterAcc -= WATER_TICK_MS; if (steps++ < 3) waterTick(inWater); }
  const q = dt / WATER_TICK_MS;

  drawChaosPixelsToCtx(getGlobalChaosOverlayStrength());

  if (y < SILENCE_START_PX) { drawBust(ctx); return; }
  if (y < WATER_START_PX) return; // Phosphenes active in background
  if (y < VIBE_GAP_START_PX) {
    const strength = getWaterEffectStrength();
    if (strength > 0.01) {
      drawRippleDots(ctx, strength, q);
      drawTrailParticles(ctx, strength, q);
      if (strength < 0.25) { ripples = ripples.slice(-8); trailParticles = trailParticles.slice(-120); }
    }
    return;
  }
  if (y < THEORY_START_PX) { drawCymaticsDots(ctx); return; }
}
