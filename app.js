/* zh-sheets — single-file app logic.
   State lives on `state`; every control writes into it and calls render().
   Two modes: worksheet preview (print-friendly) and practice (animated
   stroke order via Hanzi Writer). */

const FONT_STACKS = {
  kai:  '"Kaiti SC", "KaiTi", "STKaiti", "LXGW WenKai", "Noto Serif SC", "Noto Sans SC", serif',
  song: '"Songti SC", "SimSun", "Noto Serif SC", serif',
  hei:  '"Noto Sans SC", "PingFang SC", "Heiti SC", "Microsoft YaHei", sans-serif',
  ma:   '"Ma Shan Zheng", "Noto Serif SC", cursive',
  long: '"Long Cang", "Noto Serif SC", cursive',
  liu:  '"Liu Jian Mao Cao", "Long Cang", "Noto Serif SC", cursive',
  xiao: '"ZCOOL XiaoWei", "Noto Serif SC", serif',
};

const state = {
  tab: "sheet",          // "sheet" | "practice"
  words: [],             // [{ w, p, g }]
  mode: "writing",       // "writing" | "strokes"
  grid: "mi",            // mi | tian | hui | blank
  cols: 10,
  reps: 10,
  showPinyinRow: true,
  showPinyinCell: false,
  showNumbers: false,
  showStrokeOrder: false, // small stroke-order strip above each writing row
  font: "kai",
  ghosts: 3,
  solids: 1,
  fillBlanks: true,
  glyph: 72,             // % of cell
  printFooter: true,     // show subtle wordmark at the bottom of each printed page
  printFooterText: "tokori.ai",
  practiceIdx: 0,
};

/* ── persistence ──────────────────────────────────────────
   All layout/style choices + word list are saved to
   localStorage so a refresh comes back to the same sheet.
   Persisted fields are listed explicitly — adding new state
   fields doesn't accidentally leak them into storage. */
const STORAGE_KEY = "zh-sheets:state";
const PERSIST_KEYS = [
  "words", "mode", "grid", "cols", "reps",
  "showPinyinRow", "showPinyinCell", "showNumbers", "showStrokeOrder",
  "font", "ghosts", "solids", "fillBlanks", "glyph",
  "printFooter", "printFooterText",
];
function saveState() {
  try {
    const snap = {};
    for (const k of PERSIST_KEYS) snap[k] = state[k];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(snap));
  } catch {}
}
function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const snap = JSON.parse(raw);
    if (!snap || typeof snap !== "object") return false;
    for (const k of PERSIST_KEYS) {
      if (k in snap) state[k] = snap[k];
    }
    sanitizeState();
    return true;
  } catch { return false; }
}

/* Clamp everything that came out of storage back into the ranges the
   controls allow — stale or hand-edited localStorage must never be
   able to break render(). */
const GRID_STYLES = ["mi", "tian", "hui", "blank"];
const SHEET_MODES = ["writing", "strokes"];
function sanitizeState() {
  const num = (v, min, max, fallback) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
  };
  state.words = Array.isArray(state.words)
    ? state.words
        .filter((x) => x && typeof x.w === "string" && x.w.trim())
        .map((x) => ({
          w: x.w,
          p: typeof x.p === "string" ? x.p : "",
          g: typeof x.g === "string" ? x.g : "",
        }))
    : [];
  if (!SHEET_MODES.includes(state.mode)) state.mode = "writing";
  if (!GRID_STYLES.includes(state.grid)) state.grid = "mi";
  if (!(state.font in FONT_STACKS)) state.font = "kai";
  state.cols = num(state.cols, 6, 16, 10);
  state.reps = num(state.reps, 1, 20, 10);
  state.ghosts = num(state.ghosts, 0, 14, 3);
  state.solids = num(state.solids, 0, 3, 1);
  state.glyph = num(state.glyph, 40, 95, 72);
  for (const k of ["showPinyinRow", "showPinyinCell", "showNumbers", "showStrokeOrder", "fillBlanks", "printFooter"]) {
    state[k] = Boolean(state[k]);
  }
  if (typeof state.printFooterText !== "string") state.printFooterText = "tokori.ai";
}

/* ── tiny CEDICT-lite fallback for pinyin lookup ─────────
   Anything not in HSK lists falls through to "—". Users
   who paste arbitrary characters can still get a worksheet
   without pinyin labels. */
const HSK_INDEX = (() => {
  const ix = new Map();
  const lists = window.HSK_LISTS || {};
  for (const level of Object.keys(lists)) {
    for (const item of lists[level]) {
      if (!ix.has(item.w)) ix.set(item.w, item);
    }
  }
  return ix;
})();

function lookup(w) {
  return HSK_INDEX.get(w) || { w, p: "", g: "" };
}

/* ── parsing word input ──────────────────────────────── */
const HAN_RE = /\p{Script=Han}/u;
// Longest word in the HSK lists (in characters) — bounds the greedy matcher.
const MAX_WORD_LEN = (() => {
  let n = 1;
  for (const w of HSK_INDEX.keys()) n = Math.max(n, Array.from(w).length);
  return n;
})();

/* Split a sentence-length run of Han characters into words via greedy
   forward longest-match against the HSK index (正向最大匹配), falling
   back to single characters for anything not in the lists. So
   "我喜欢学习中文" → 我 / 喜欢 / 学习 / 中文 — each with pinyin/gloss. */
function segmentToken(token) {
  const chars = Array.from(token);
  // Exact dictionary hits and short tokens are kept whole — a 2–4 char
  // token is almost certainly a deliberate word/name/idiom, not a sentence.
  if (HSK_INDEX.has(token) || chars.length <= 4 || !HAN_RE.test(token)) return [token];
  const out = [];
  let i = 0;
  while (i < chars.length) {
    if (!HAN_RE.test(chars[i])) {
      // group consecutive non-Han chars (e.g. embedded pinyin) into one piece
      let j = i + 1;
      while (j < chars.length && !HAN_RE.test(chars[j])) j++;
      out.push(chars.slice(i, j).join(""));
      i = j;
      continue;
    }
    let match = null;
    for (let len = Math.min(MAX_WORD_LEN, chars.length - i); len >= 2; len--) {
      const cand = chars.slice(i, i + len).join("");
      if (HSK_INDEX.has(cand)) { match = cand; break; }
    }
    out.push(match || chars[i]);
    i += match ? Array.from(match).length : 1;
  }
  return out;
}

function parseInput(s) {
  if (!s) return [];
  // Split on anything that isn't a letter — whitespace plus all Western
  // AND Chinese punctuation (，。！？；、：""…) — then segment any
  // sentence-length runs of Han characters into words.
  return s
    .split(/[^\p{L}\p{M}]+/u)
    .map((t) => t.trim())
    .filter(Boolean)
    .flatMap(segmentToken);
}

/* ── Stroke-data cache (Make-Me-A-Hanzi via Hanzi Writer) ──
   We render small static stroke-order strips by drawing the
   raw SVG path data ourselves. HanziWriter ships the data
   loader and caches over the network on its end. We keep a
   local cache so re-renders are instant. */
const STROKE_CACHE = new Map(); // char -> { strokes: [paths] } | null
const STROKE_PENDING = new Set();
function fetchStrokeData(char) {
  if (STROKE_CACHE.has(char) || STROKE_PENDING.has(char)) return;
  if (typeof HanziWriter === "undefined") {
    // CDN script failed to load — resolve to "no data" so strips show
    // a dash instead of a loading placeholder forever.
    if (window.HANZI_WRITER_FAILED) STROKE_CACHE.set(char, null);
    return;
  }
  STROKE_PENDING.add(char);
  HanziWriter.loadCharacterData(char).then(
    (data) => {
      STROKE_PENDING.delete(char);
      STROKE_CACHE.set(char, data || null);
      // Re-render once new data arrives so the placeholder gets
      // replaced. Debounced so a burst of fetches batches into
      // one render pass.
      scheduleRender();
    },
    () => {
      STROKE_PENDING.delete(char);
      STROKE_CACHE.set(char, null);
      scheduleRender();
    },
  );
}
let _renderQueued = false;
function scheduleRender() {
  if (_renderQueued) return;
  _renderQueued = true;
  requestAnimationFrame(() => { _renderQueued = false; render(); });
}

/* Build a row of small SVGs — N boxes, each showing strokes 1..k
   highlighted with the earlier strokes faded. Used for the
   "stroke order above row" hint and the strokes-only worksheet. */
function strokeOrderStrip(char, { size, color = "#1a1a1a", faint = "#e0d8c5" } = {}) {
  const SVG_NS = "http://www.w3.org/2000/svg";
  const wrap = el("span", { class: "stroke-strip" });
  const data = STROKE_CACHE.get(char);
  if (data === undefined) {
    fetchStrokeData(char);
    // placeholder dot row so the layout doesn't jump
    wrap.appendChild(el("span", { class: "stroke-strip-loading" }, ""));
    return wrap;
  }
  if (data === null || !data.strokes) {
    wrap.appendChild(el("span", { class: "stroke-strip-missing" }, "—"));
    return wrap;
  }
  for (let k = 1; k <= data.strokes.length; k++) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 1024 1024");
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    svg.classList.add("stroke-svg");
    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("transform", "translate(0, 900) scale(1, -1)");
    for (let i = 0; i < data.strokes.length; i++) {
      const path = document.createElementNS(SVG_NS, "path");
      path.setAttribute("d", data.strokes[i]);
      path.setAttribute("fill", i < k - 1 ? faint : i === k - 1 ? color : "transparent");
      g.appendChild(path);
    }
    svg.appendChild(g);
    wrap.appendChild(svg);
  }
  return wrap;
}

/* ── DOM helpers ─────────────────────────────────────── */
const $ = (id) => document.getElementById(id);
function el(tag, props = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") e.className = v;
    else if (k === "style") e.setAttribute("style", v);
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "html") e.innerHTML = v;
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return e;
}

/* ── controls wiring ─────────────────────────────────── */
function initControls() {
  // tabs
  $("tab-sheet").addEventListener("click", () => setTab("sheet"));
  $("tab-practice").addEventListener("click", () => setTab("practice"));

  // print
  const print = () => window.print();
  $("btn-print").addEventListener("click", print);
  $("btn-print2").addEventListener("click", print);

  // collapse sidebar — single ← / → toggle
  const shell = $("shell");
  const toggleCollapse = () => {
    const next = shell.dataset.collapsed === "true" ? "false" : "true";
    shell.dataset.collapsed = next;
    try { localStorage.setItem("zh-sheets:collapsed", next); } catch {}
  };
  $("btn-collapse").addEventListener("click", toggleCollapse);
  $("btn-peek").addEventListener("click", toggleCollapse);
  try {
    const saved = localStorage.getItem("zh-sheets:collapsed");
    // No saved preference on a small screen → start with the drawer
    // closed so the worksheet is visible first.
    if (saved === "true" || (saved === null && window.matchMedia("(max-width: 900px)").matches)) {
      shell.dataset.collapsed = "true";
    }
  } catch {}

  // word input
  $("btn-add").addEventListener("click", () => {
    const tokens = parseInput($("input-chars").value);
    addWords(tokens);
    $("input-chars").value = "";
  });
  $("input-chars").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      $("btn-add").click();
    }
  });
  // Clear wipes both the input box and the current word list/worksheet.
  $("btn-clear").addEventListener("click", () => {
    $("input-chars").value = "";
    state.words = [];
    render();
  });
  $("btn-remove-all").addEventListener("click", () => { state.words = []; render(); });

  // HSK quick add
  const grid = $("hsk-grid");
  const levels = Object.keys(window.HSK_LISTS || {});
  for (const lvl of levels) {
    const num = lvl.replace(/[^\d]/g, "");
    grid.appendChild(
      el("button", {
        class: "hsk-btn",
        onclick: () => addHsk(lvl),
        title: `${lvl} · ${(window.HSK_LISTS[lvl] || []).length} words`,
      }, [
        el("span", { style: "color: hsl(var(--muted-foreground)); font-size: 10px; letter-spacing: 0.04em;" }, "HSK "),
        el("span", { class: "lvl" }, num),
      ]),
    );
  }

  // grid style
  $("seg-grid").querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => {
      $("seg-grid").querySelectorAll("button").forEach((x) => x.classList.remove("on"));
      b.classList.add("on");
      state.grid = b.dataset.v;
      render();
    });
  });

  // sheet mode (writing rows vs stroke order chart)
  $("seg-mode").querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => {
      $("seg-mode").querySelectorAll("button").forEach((x) => x.classList.remove("on"));
      b.classList.add("on");
      state.mode = b.dataset.v;
      render();
    });
  });

  // sliders
  const bindSlider = (id, key, suffix = "") => {
    $(id).addEventListener("input", (e) => {
      state[key] = Number(e.target.value);
      const v = $(id + "-v"); if (v) v.textContent = state[key] + suffix;
      render();
    });
  };
  bindSlider("cols", "cols");
  bindSlider("reps", "reps");
  bindSlider("ghosts", "ghosts");
  bindSlider("solids", "solids");
  bindSlider("glyph", "glyph", "%");

  // toggles
  const bindToggle = (id, key) => {
    $(id).addEventListener("change", (e) => {
      state[key] = e.target.checked;
      render();
    });
  };
  bindToggle("show-pinyin", "showPinyinRow");
  bindToggle("show-pinyin-cell", "showPinyinCell");
  bindToggle("show-numbers", "showNumbers");
  bindToggle("show-stroke", "showStrokeOrder");
  bindToggle("fill-blanks", "fillBlanks");
  bindToggle("print-footer", "printFooter");

  // Footer text (free-text input — persisted, falls back to "tokori.ai").
  // Full render so the footer baked into each sheet updates live while
  // typing; scheduleRender batches keystrokes into one paint.
  $("print-footer-text").addEventListener("input", (e) => {
    state.printFooterText = e.target.value;
    scheduleRender();
  });

  // font
  $("font").addEventListener("change", (e) => {
    state.font = e.target.value;
    render();
  });
}

function setTab(t) {
  state.tab = t;
  $("tab-sheet").classList.toggle("on", t === "sheet");
  $("tab-practice").classList.toggle("on", t === "practice");
  $("tab-sheet").setAttribute("aria-selected", t === "sheet");
  $("tab-practice").setAttribute("aria-selected", t === "practice");
  render();
}

function addWords(tokens) {
  for (const t of tokens) {
    if (state.words.find((w) => w.w === t)) continue;
    state.words.push(lookup(t));
  }
  render();
}
function addHsk(level) {
  const n = Math.max(1, Math.min(200, Number($("hsk-count").value) || 20));
  const list = (window.HSK_LISTS || {})[level] || [];
  // de-dup, take first n that aren't already in
  let added = 0;
  for (const item of list) {
    if (added >= n) break;
    if (state.words.find((w) => w.w === item.w)) continue;
    state.words.push(item);
    added++;
  }
  render();
}
function removeWord(w) {
  state.words = state.words.filter((x) => x.w !== w);
  render();
}

/* ── render: chips ────────────────────────────────────── */
function renderChips() {
  const c = $("chips");
  c.innerHTML = "";
  $("sel-count").textContent = `(${state.words.length})`;
  if (!state.words.length) {
    c.appendChild(el("div", { class: "chip-empty" }, "No words yet — add some above."));
    return;
  }
  for (const w of state.words) {
    c.appendChild(
      el("span", { class: "chip", title: (w.p ? w.p : "") + (w.g ? " · " + w.g : "") }, [
        w.w,
        el("button", { class: "x", onclick: () => removeWord(w.w), title: "Remove" }, "×"),
      ]),
    );
  }
}

/* ── render: worksheet preview ────────────────────────── */
const PAGE_INNER_W_MM = 210 - 16 * 2; // 178mm usable width
function renderSheets() {
  const preview = $("preview");
  preview.innerHTML = "";

  if (!state.words.length) {
    preview.appendChild(
      el("div", { class: "practice-empty", style: "margin-top:80px" }, [
        el("div", { style: "font-size:36px; font-family:'Noto Serif SC',serif; color:hsl(var(--muted-foreground))" }, "字"),
        el("div", { style: "margin-top:12px" }, "Add some characters on the left to start."),
      ]),
    );
    return;
  }

  if (state.mode === "strokes") {
    renderStrokesSheets();
    return;
  }

  // build a flat sequence of rows, each row = one word repeated across `cols`
  // following the ghost+solid+blank pattern.
  const rows = [];
  for (const w of state.words) {
    for (let r = 0; r < state.reps; r++) {
      rows.push({ word: w, repIndex: r });
    }
  }

  // pack rows into pages. Cell side = (PAGE_INNER_W_MM / cols) mm. We can fit
  // floor(pageInnerH / cellSide) rows. Page inner height = 297 - 18*2 - some
  // header. Keep it simple: paginate to 14 rows per page max, with the actual
  // visible row height auto from the grid template.
  const cellMm = PAGE_INNER_W_MM / state.cols;
  // Available content height after a small header (8mm) and bottom safety margin.
  // The stroke-order strip eats ~7mm extra per row when shown.
  const extraPerRow =
    (state.showPinyinRow ? 5 : 0) +
    (state.showStrokeOrder ? 7 : 0);
  const contentMm = 297 - 18 * 2 - 12;
  const rowsPerPage = Math.max(1, Math.floor(contentMm / (cellMm + extraPerRow)));

  // sheet meta strip (on-screen only)
  preview.appendChild(buildMetaStrip(rows.length, rowsPerPage));

  for (let i = 0; i < rows.length; i += rowsPerPage) {
    const slice = rows.slice(i, i + rowsPerPage);
    preview.appendChild(buildSheet(slice, i, cellMm));
  }
}

/* Stroke-order-only sheet: each character gets a row of BIG grid cells
   (same size as the writing-mode cells), each cell shows strokes 1..k
   drawn inside the grid guides. Wraps to multiple rows when the
   character has more strokes than columns. */
function renderStrokesSheets() {
  const preview = $("preview");

  // flatten words → unique chars (keep original word context for pinyin/gloss)
  const items = [];
  const seen = new Set();
  for (const w of state.words) {
    const chars = Array.from(w.w);
    for (let i = 0; i < chars.length; i++) {
      if (seen.has(chars[i])) continue;
      seen.add(chars[i]);
      items.push({
        char: chars[i],
        p: i === 0 ? w.p : "",
        g: i === 0 ? w.g : "",
        word: w.w,
      });
    }
  }

  const cellMm = PAGE_INNER_W_MM / state.cols;
  const contentMm = 297 - 18 * 2 - 12;
  // Each character needs ceil(strokes/cols) rows of grid cells plus a
  // label line. Stroke counts arrive async — until a char's data is
  // cached we assume one row; the sheet re-renders as data lands, so
  // pagination converges on the true heights.
  const blockMm = (it) => {
    const d = STROKE_CACHE.get(it.char);
    const rows = d && d.strokes ? Math.ceil(d.strokes.length / state.cols) : 1;
    return rows * cellMm + 6; // + pinyin/gloss line
  };
  const pages = [];
  let cur = [];
  let used = 0;
  for (const it of items) {
    const h = blockMm(it);
    if (cur.length && used + h > contentMm) { pages.push(cur); cur = []; used = 0; }
    cur.push(it);
    used += h;
  }
  if (cur.length) pages.push(cur);

  preview.appendChild(
    el("div", { class: "sheet-meta no-print" }, [
      el("div", {}, [
        el("span", { class: "pill pill-dot" }, [
          el("strong", {}, String(items.length)),
          ` character${items.length === 1 ? "" : "s"} · `,
          el("strong", {}, String(pages.length)),
          ` page${pages.length === 1 ? "" : "s"}`,
        ]),
      ]),
      el("div", { class: "pill" }, `Stroke chart · ${state.cols} cells · ${labelForFont(state.font)}`),
    ]),
  );

  for (const pageItems of pages) {
    const sheet = el("div", { class: "sheet" });
    const foot = buildSheetFooter();
    if (foot) sheet.appendChild(foot);
    for (const it of pageItems) sheet.appendChild(buildStrokeCharBlock(it, cellMm));
    preview.appendChild(sheet);
  }
}

/* One character → pinyin/gloss label + a grid of big stroke cells.
   Each cell shows the character with strokes 1..k drawn in. */
function buildStrokeCharBlock(item, cellMm) {
  const block = el("div", { class: "stroke-block" });

  // label row: pinyin · gloss (mirrors the writing mode label)
  block.appendChild(
    el("div", { class: "row-label" }, [
      el("span", { class: "py" }, item.p || ""),
      item.g ? el("span", { class: "gl" }, item.g) : null,
      el("span", { class: "row-strokes-inline-label" }, item.char),
    ]),
  );

  const data = STROKE_CACHE.get(item.char);
  if (data === undefined) {
    fetchStrokeData(item.char);
    block.appendChild(el("div", { class: "stroke-loading" }, "Loading stroke data…"));
    return block;
  }
  if (data === null || !data.strokes) {
    block.appendChild(el("div", { class: "stroke-loading" }, `No stroke data for ${item.char}.`));
    return block;
  }

  const total = data.strokes.length;
  const grid = el("div", {
    class: "grid stroke-grid",
    style: `grid-template-columns: repeat(${state.cols}, 1fr); width: ${PAGE_INNER_W_MM}mm; grid-auto-rows: ${cellMm}mm;`,
  });
  for (let k = 1; k <= total; k++) {
    grid.appendChild(buildStrokeCell(data, k, cellMm));
  }
  // Pad the last row so trailing cells still draw the grid guides
  // (keeps the sheet visually consistent — empty cells with the chosen
  // mi/tian/hui background).
  const leftover = (state.cols - (total % state.cols)) % state.cols;
  for (let i = 0; i < leftover; i++) {
    grid.appendChild(el("div", { class: `cell l-${state.grid} empty` }));
  }
  block.appendChild(grid);
  return block;
}

function buildStrokeCell(data, k, cellMm) {
  const SVG_NS = "http://www.w3.org/2000/svg";
  const cell = el("div", { class: `cell l-${state.grid} stroke-cell` });

  // little step number in the corner
  cell.appendChild(el("div", { class: "stroke-step-num" }, String(k)));

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 1024 1024");
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
  svg.classList.add("stroke-cell-svg");
  const g = document.createElementNS(SVG_NS, "g");
  g.setAttribute("transform", "translate(0, 900) scale(1, -1)");
  for (let i = 0; i < data.strokes.length; i++) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", data.strokes[i]);
    if (i < k - 1) path.setAttribute("fill", "#cbc3b0");   // earlier strokes: faded
    else if (i === k - 1) path.setAttribute("fill", "#e04e1f"); // current stroke: brand orange so it pops
    else path.setAttribute("fill", "transparent");          // future strokes: hidden
    g.appendChild(path);
  }
  svg.appendChild(g);
  cell.appendChild(svg);
  return cell;
}

function buildMetaStrip(totalRows, rowsPerPage) {
  const pages = Math.max(1, Math.ceil(totalRows / rowsPerPage));
  return el("div", { class: "sheet-meta no-print" }, [
    el("div", {}, [
      el("span", { class: "pill pill-dot" }, [
        el("strong", {}, String(state.words.length)),
        ` word${state.words.length === 1 ? "" : "s"} · `,
        el("strong", {}, String(totalRows)),
        ` row${totalRows === 1 ? "" : "s"} · `,
        el("strong", {}, String(pages)),
        ` page${pages === 1 ? "" : "s"}`,
      ]),
    ]),
    el("div", { class: "pill" }, `${state.cols} cells × ${state.reps} reps · ${labelForFont(state.font)}`),
  ]);
}

function buildSheet(rowsForPage, startIdx, cellMm) {
  const sheet = el("div", { class: "sheet" });
  const foot = buildSheetFooter();
  if (foot) sheet.appendChild(foot);

  // (intentionally no in-sheet header — keeps the print output clean)

  // each "row" is its own mini-grid so we can prepend the optional pinyin line
  for (let r = 0; r < rowsForPage.length; r++) {
    const { word, repIndex } = rowsForPage[r];
    const visibleRowIdx = startIdx + r;

    // Pinyin + gloss + stroke-order strip all share one line, so the
    // stroke chart sits inline with the meaning instead of stealing a
    // row of its own.
    if (state.showPinyinRow || state.showStrokeOrder) {
      const label = el("div", { class: "row-label" });
      if (state.showPinyinRow) {
        label.appendChild(el("span", { class: "py" }, word.p || ""));
        if (word.g) label.appendChild(el("span", { class: "gl" }, word.g));
      }
      if (state.showStrokeOrder) {
        const strips = el("span", { class: "row-strokes-inline" });
        const chars = Array.from(word.w);
        chars.forEach((ch, i) => {
          if (i > 0) strips.appendChild(el("span", { class: "row-strokes-sep" }, ""));
          strips.appendChild(strokeOrderStrip(ch, { size: 14 }));
        });
        label.appendChild(strips);
      }
      sheet.appendChild(label);
    }

    const grid = el("div", {
      class: "grid",
      style: `grid-template-columns: repeat(${state.cols}, 1fr); width: ${PAGE_INNER_W_MM}mm; height: ${cellMm}mm;`,
    });

    // Each multi-char word gets one cell per character. The solid/ghost/blank
    // pattern is applied at the COMPOUND-INSTANCE level so a 2-char word like
    // 你好 occupies two cells per instance and the row reads
    //   [你 solid][好 solid][你 ghost][好 ghost][你 ghost][好 ghost] …
    const wordChars = Array.from(word.w);
    const charsPerInstance = wordChars.length;
    // A word wider than the grid still gets one (truncated) instance —
    // otherwise instancesPerRow becomes 0 and the whole row renders empty.
    const instancesPerRow = Math.max(1, Math.floor(state.cols / charsPerInstance));

    for (let c = 0; c < state.cols; c++) {
      const instanceIdx = Math.floor(c / charsPerInstance);
      const charInInstance = c % charsPerInstance;
      const isTrailing = instanceIdx >= instancesPerRow; // leftover cells past the last full instance
      const ch = isTrailing ? null : wordChars[charInInstance];

      let kind = "empty";
      if (!isTrailing) {
        if (instanceIdx < state.solids) kind = "solid";
        else if (instanceIdx < state.solids + state.ghosts) kind = "ghost";
      }
      grid.appendChild(buildCell({
        ch, word, cIdx: c, rowIdx: visibleRowIdx, cellMm, kind,
        charInInstance, charsPerInstance,
      }));
    }
    sheet.appendChild(grid);
  }
  return sheet;
}

function buildCell({ ch, word, cIdx, rowIdx, cellMm, kind, charInInstance, charsPerInstance }) {
  const cell = el("div", { class: `cell l-${state.grid} ${kind}` });

  // Pinyin inside the cell: only show on the first character of each
  // compound, and only on the first instance (cIdx === charInInstance === 0).
  if (state.showPinyinCell && cIdx === 0 && word.p) {
    cell.appendChild(el("div", { class: "pinyin" }, word.p));
  }
  if (state.showNumbers && ch) {
    cell.appendChild(el("div", { class: "stroke-num" }, String(cIdx + 1)));
  }

  // Each cell holds exactly one character now, so the glyph fills the cell
  // at the user's chosen percentage (no compound-squeeze math).
  const sizeMm = (state.glyph / 100) * cellMm;

  if (!ch) return cell;

  if (kind === "solid" || kind === "ghost") {
    cell.appendChild(el("div", {
      class: "glyph",
      style:
        `font-family: ${FONT_STACKS[state.font]}; ` +
        `font-size: ${sizeMm.toFixed(2)}mm;` +
        (kind === "ghost" ? " opacity: 0.32;" : ""),
    }, ch));
  } else if (!state.fillBlanks) {
    cell.appendChild(el("div", {
      class: "glyph",
      style: `font-family: ${FONT_STACKS[state.font]}; font-size: ${sizeMm.toFixed(2)}mm; opacity: 0.15;`,
    }, ch));
  }

  return cell;
}

function labelForFont(f) {
  const m = {
    kai: "Kai", song: "Song", hei: "Hei",
    ma: "Ma Shan Zheng", long: "Long Cang",
    liu: "Liu Jian Mao Cao", xiao: "ZCOOL XiaoWei",
  };
  return m[f] || f;
}

/* ── practice mode ────────────────────────────────────── */
let activeWriter = null;
let writerWord = "";

function renderPractice() {
  const preview = $("preview");
  preview.innerHTML = "";

  if (!state.words.length) {
    preview.appendChild(
      el("div", { class: "practice-empty", style: "margin-top:80px" }, [
        el("div", { style: "font-size:36px; font-family:'Noto Serif SC',serif; color:hsl(var(--muted-foreground))" }, "练"),
        el("div", { style: "margin-top:12px" }, "Add words on the left, then come back to practice them."),
      ]),
    );
    return;
  }

  // build the single-character pool — split multi-char words into chars,
  // keep the original word's pinyin/gloss for the first char.
  const pool = [];
  for (const w of state.words) {
    const chars = Array.from(w.w);
    for (let i = 0; i < chars.length; i++) {
      pool.push({
        char: chars[i],
        p: i === 0 ? w.p : "",
        g: i === 0 ? w.g : "",
        ofWord: w.w,
      });
    }
  }
  if (state.practiceIdx >= pool.length) state.practiceIdx = 0;
  const current = pool[state.practiceIdx];

  const wrap = el("div", { class: "practice-wrap" });

  const card = el("div", { class: "practice-card" });
  card.appendChild(el("div", { class: "pinyin-big" }, current.p || ""));

  const stageId = "practice-stage-" + Date.now();
  const stage = el("div", { class: "practice-stage" }, [
    el("div", { id: stageId, style: "width: 100%; height: 100%;" }),
  ]);
  card.appendChild(stage);

  card.appendChild(el("div", { class: "gloss-big" }, current.g || ""));

  card.appendChild(
    el("div", { class: "practice-actions" }, [
      el("button", { class: "btn btn-outline btn-sm", onclick: () => animate() }, "▶ Animate strokes"),
      el("button", { class: "btn btn-outline btn-sm", onclick: () => quiz(true) }, "✎ Quiz (with outline)"),
      el("button", { class: "btn btn-outline btn-sm", onclick: () => quiz(false) }, "👁︎ Blind quiz"),
      el("button", { class: "btn btn-ghost btn-sm", onclick: () => prev() }, "← Prev"),
      el("button", { class: "btn btn-ghost btn-sm", onclick: () => next() }, "Next →"),
    ]),
  );

  wrap.appendChild(card);

  // character switcher
  const list = el("div", { class: "practice-list" });
  pool.forEach((p, i) => {
    list.appendChild(
      el("button", {
        class: i === state.practiceIdx ? "on" : "",
        onclick: () => { state.practiceIdx = i; renderPractice(); },
        title: p.ofWord,
        style: `font-family: ${FONT_STACKS[state.font]};`,
      }, p.char),
    );
  });
  wrap.appendChild(list);

  preview.appendChild(wrap);

  // mount Hanzi Writer
  function mount(attempt = 0) {
    if (typeof HanziWriter === "undefined") {
      const target = stage.querySelector("#" + stageId);
      // ~10s of retries, or an outright script error → give up politely.
      if (window.HANZI_WRITER_FAILED || attempt > 50) {
        target.textContent = "Couldn't load the stroke-order library — check your connection and reload.";
        return;
      }
      target.textContent = "Loading stroke data…";
      setTimeout(() => mount(attempt + 1), 200);
      return;
    }
    writerWord = current.char;
    try {
      activeWriter = HanziWriter.create(stageId, current.char, {
        width: 320,
        height: 320,
        padding: 10,
        showOutline: true,
        showCharacter: true,
        strokeAnimationSpeed: 1,
        delayBetweenStrokes: 120,
        strokeColor: "#1a1a1a",
        outlineColor: "#d9d2c2",
        radicalColor: "#e04e1f",
      });
    } catch (err) {
      stage.querySelector("#" + stageId).textContent =
        "Stroke data not available for " + current.char;
    }
  }
  mount();

  function animate() {
    if (!activeWriter) return;
    activeWriter.cancelQuiz();
    activeWriter.showOutline();
    activeWriter.showCharacter();
    activeWriter.animateCharacter();
  }
  function quiz(showOutline) {
    if (!activeWriter) return;
    activeWriter.cancelQuiz();
    activeWriter.hideCharacter();
    if (showOutline) activeWriter.showOutline();
    else activeWriter.hideOutline();
    activeWriter.quiz({ showHintAfterMisses: showOutline ? 3 : 99 });
  }
  function prev() { state.practiceIdx = (state.practiceIdx - 1 + pool.length) % pool.length; renderPractice(); }
  function next() { state.practiceIdx = (state.practiceIdx + 1) % pool.length; renderPractice(); }
}

/* Push the print-footer toggle into a body class. The actual footer
   element is now rendered as a real <a> inside each .sheet so PDF
   renderers preserve it as a clickable annotation — pseudo-elements
   can't be hyperlinks. */
function applyPrintFooter() {
  document.body.classList.toggle("no-print-footer", !state.printFooter);
}

/* Derive a sensible href from the footer text. Lets the user just
   type "tokori.ai" and get a real clickable link in the PDF, while
   still supporting full URLs and pure plain-text footers. */
function footerHref(text) {
  const t = (text || "").trim();
  if (!t) return null;
  if (/^https?:\/\//i.test(t)) return t;
  // looks like a domain (has a dot, no spaces) → prepend https://
  if (/^[^\s]+\.[^\s]+$/.test(t)) return "https://" + t;
  return null; // plain text — render without an <a>
}

function buildSheetFooter() {
  if (!state.printFooter) return null;
  const text = (state.printFooterText || "").trim() || "tokori.ai";
  const href = footerHref(text);
  if (href) {
    return el("a", {
      class: "sheet-foot",
      href,
      target: "_blank",
      rel: "noopener noreferrer",
    }, text);
  }
  return el("span", { class: "sheet-foot" }, text);
}

/* ── master render ────────────────────────────────────── */
function render() {
  renderChips();
  if (state.tab === "sheet") renderSheets();
  else renderPractice();
  applyPrintFooter();
  saveState();
}

/* Push the current state values back into the DOM controls so a
   localStorage restore actually shows up in the sidebar. Called once
   at startup after loadState(). */
function syncControls() {
  $("cols").value = state.cols;          $("cols-v").textContent = state.cols;
  $("reps").value = state.reps;          $("reps-v").textContent = state.reps;
  $("ghosts").value = state.ghosts;      $("ghosts-v").textContent = state.ghosts;
  $("solids").value = state.solids;      $("solids-v").textContent = state.solids;
  $("glyph").value = state.glyph;        $("glyph-v").textContent = state.glyph + "%";
  $("show-pinyin").checked = state.showPinyinRow;
  $("show-pinyin-cell").checked = state.showPinyinCell;
  $("show-numbers").checked = state.showNumbers;
  $("show-stroke").checked = state.showStrokeOrder;
  $("fill-blanks").checked = state.fillBlanks;
  $("print-footer").checked = state.printFooter;
  $("print-footer-text").value = state.printFooterText || "";
  $("font").value = state.font;
  $("seg-grid").querySelectorAll("button").forEach((b) => {
    b.classList.toggle("on", b.dataset.v === state.grid);
  });
  $("seg-mode").querySelectorAll("button").forEach((b) => {
    b.classList.toggle("on", b.dataset.v === state.mode);
  });
}

document.addEventListener("DOMContentLoaded", () => {
  initControls();
  const restored = loadState();
  if (!restored) {
    // First visit — seed with 5 HSK 1 words so the preview is non-empty.
    const seed = (window.HSK_LISTS?.["HSK 1"] || []).slice(0, 5);
    state.words = seed.map((x) => ({ w: x.w, p: x.p, g: x.g }));
  }
  syncControls();
  render();
});
