pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

const SCALE = 1.5;            // screen pixels per PDF point (at 100% zoom)
const PAD = 2;                // left padding of text inputs, in screen px
const LINE_GAP = 1.25;        // line height of multi-line boxes, relative to the font size

// Google Fonts, served as files by Fontsource. The same bytes are used on screen and embedded in the PDF.
const FONTS = [
  { id: 'helvetica', name: 'Helvetica (built-in)', group: 'Sans serif' },
  { id: 'inter', name: 'Inter', group: 'Sans serif' },
  { id: 'roboto', name: 'Roboto', group: 'Sans serif' },
  { id: 'open-sans', name: 'Open Sans', group: 'Sans serif' },
  { id: 'lato', name: 'Lato', group: 'Sans serif' },
  { id: 'source-sans-3', name: 'Source Sans 3', group: 'Sans serif', version: '5.3.1' },
  { id: 'noto-sans', name: 'Noto Sans', group: 'Sans serif' },
  { id: 'roboto-mono', name: 'Roboto Mono', group: 'Monospace' },
  { id: 'caveat', name: 'Caveat', group: 'Handwriting' },
  { id: 'patrick-hand', name: 'Patrick Hand', group: 'Handwriting' },
];
const fontUrl = f => `https://cdn.jsdelivr.net/npm/@fontsource/${f.id}@${f.version || '5.3.0'}/files/${f.id}-latin-400-normal.woff`;

let pdfBytes = null;
let outName = 'filled.pdf';
let pageList = [];            // { div, wrap, vp, index }
let fields = [];              // real PDF form fields: { name, type, el, height, buttonValue }
let overlays = [];            // fillable areas we draw ourselves, see addOverlay
let images = [];              // placed signatures: { pageIndex, vp, el, left, top, width, height, png }
let flatten = false;
let zoom = 1;
let mode = 'type';            // type | draw | sign | date
let signature = null;         // PNG data URL
const settings = { size: 11, font: null, caps: false, mark: 'check' };
const fontCache = {};

try { signature = localStorage.getItem('signature'); } catch {}

// ---------- Fonts ----------

// k: where the baseline sits in a line box. With line-height = L, the browser puts the baseline at
// lineTop + L/2 + k * fontSize, where k = (ascent + descent) / 2 / unitsPerEm (descent < 0).
async function loadFont(id) {
  if (fontCache[id]) return fontCache[id];
  const def = FONTS.find(f => f.id === id);
  let font;
  if (id === 'helvetica') {
    const doc = await PDFLib.PDFDocument.create();
    font = { id, css: 'Arial, Helvetica, sans-serif', k: 0.3465, bytes: null,
             measure: await doc.embedFont(PDFLib.StandardFonts.Helvetica) };
  } else {
    const bytes = new Uint8Array(await (await fetch(fontUrl(def))).arrayBuffer());
    const face = new FontFace(`pdfw-${id}`, bytes);
    document.fonts.add(await face.load());
    const meta = fontkit.create(bytes);
    const doc = await PDFLib.PDFDocument.create();
    doc.registerFontkit(fontkit);
    font = { id, css: `"pdfw-${id}", sans-serif`, k: (meta.ascent + meta.descent) / 2 / meta.unitsPerEm, bytes,
             measure: await doc.embedFont(bytes) };
  }
  return (fontCache[id] = font);
}

function textWidthPx(text, fontPt) {
  try { return settings.font.measure.widthOfTextAtSize(text, fontPt) * SCALE; }
  catch { return text.length * fontPt * 0.55 * SCALE; }   // unsupported characters: rough estimate
}

// Greedy word wrap with the PDF font's widths, like a textarea does it
function wrapLines(text, fontPt, widthPx) {
  const lines = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      const next = line ? line + ' ' + word : word;
      if (textWidthPx(next, fontPt) <= widthPx) { line = next; continue; }
      if (line) lines.push(line);
      line = word;
      // A single word wider than the box breaks between characters
      while (textWidthPx(line, fontPt) > widthPx && line.length > 1) {
        let n = line.length - 1;
        while (n > 1 && textWidthPx(line.slice(0, n), fontPt) > widthPx) n--;
        lines.push(line.slice(0, n));
        line = line.slice(n);
      }
    }
    lines.push(line);
  }
  return lines;
}

async function setFont(id) {
  setStatus('Loading font…');
  try {
    settings.font = await loadFont(id);
  } catch {
    setStatus('Font failed to load');
    fontSelect.value = settings.font?.id || 'helvetica';
    return;
  }
  document.documentElement.style.setProperty('--field-font', settings.font.css);
  relayoutAll();
  setStatus(statusText());
}

function setSize(v) {
  const size = Math.min(24, Math.max(6, +v || 11));
  settings.size = size;
  sizeInput.value = size;
  sizeRange.value = size;
  relayoutAll();
}

function relayoutAll() {
  overlays.forEach(layout);
  for (const f of fields) {
    if (f.type === 'text') f.el.style.fontSize = Math.min(f.height * 0.7, settings.size * SCALE) + 'px';
  }
}

// ---------- Sidebar ----------

for (const group of [...new Set(FONTS.map(f => f.group))]) {
  const og = document.createElement('optgroup');
  og.label = group;
  FONTS.filter(f => f.group === group).forEach(f => og.appendChild(new Option(f.name, f.id)));
  fontSelect.appendChild(og);
}
fontSelect.onchange = () => setFont(fontSelect.value);
sizeRange.oninput = () => setSize(sizeRange.value);
sizeInput.onchange = () => setSize(sizeInput.value);

function makeSwitch(btn, onChange) {
  btn.onclick = () => {
    const on = btn.getAttribute('aria-checked') !== 'true';
    const state = on ? 'checked' : 'unchecked';
    btn.setAttribute('aria-checked', on);
    btn.dataset.state = state;
    btn.firstElementChild.dataset.state = state;
    onChange(on);
  };
}
makeSwitch(flattenSwitch, on => { flatten = on; });
makeSwitch(capsSwitch, on => {
  settings.caps = on;
  if (!on) return;
  for (const t of overlays) if (t.kind !== 'check') { t.el.value = t.el.value.toUpperCase(); }
  for (const f of fields) if (f.type === 'text') f.el.value = f.el.value.toUpperCase();
  relayoutAll();
});

markGroup.addEventListener('click', e => {
  const btn = e.target.closest('[data-mark]');
  if (!btn) return;
  settings.mark = btn.dataset.mark;
  markGroup.querySelectorAll('[data-mark]').forEach(b => b.setAttribute('aria-checked', b === btn));
  overlays.filter(t => t.kind === 'check').forEach(renderCheck);
});

themeBtn.onclick = () => {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = dark ? 'light' : 'dark';
  try { localStorage.setItem('theme', root.dataset.theme); } catch {}
};

// ---------- Opening files ----------

openBtn.onclick = chooseBtn.onclick = () => fileInput.click();
fileInput.onchange = e => openFile(e.target.files[0]);

// Count enter/leave pairs: moving over the drop zone's icon or text fires leave/enter on children,
// and a plain toggle would make the drag state blink
let dragDepth = 0;
const setDrag = on => { dropzone.dataset.drag = on; };
const isFileDrag = e => [...e.dataTransfer.types].includes('Files');
main.addEventListener('dragenter', e => { if (isFileDrag(e)) { dragDepth++; setDrag(true); } });
main.addEventListener('dragleave', e => { if (isFileDrag(e) && --dragDepth <= 0) { dragDepth = 0; setDrag(false); } });
main.addEventListener('dragover', e => e.preventDefault());
main.addEventListener('drop', e => {
  e.preventDefault();
  dragDepth = 0;
  setDrag(false);
  const file = [...e.dataTransfer.files].find(f => f.type === 'application/pdf');
  if (file) openFile(file);
});

function setStatus(text) {
  statusBadge.textContent = text;
  statusBadge.classList.toggle('hidden', !text);
  statusBadge.classList.toggle('inline-flex', !!text);
}

function statusText() {
  if (!pdfBytes) return '';
  const n = fields.length + overlays.filter(t => t.kind !== 'free').length;
  return n ? `${n} fillable areas` : 'No fields found · click to type';
}

function setDownloadEnabled(on) {
  downloadBtn.disabled = !on;
  downloadTip.hidden = on;
}

const fontReady = setFont('helvetica');

async function openFile(file) {
  if (!file) return;
  outName = file.name.replace(/\.pdf$/i, '') + '-filled.pdf';
  fileName.textContent = file.name;
  empty.classList.add('hidden');
  for (const el of [pages, toolsBar]) { el.classList.remove('hidden'); el.classList.add('flex'); }
  pages.innerHTML = '';
  setMode('type');
  const ph = placeholder(595 * SCALE, 842 * SCALE);   // A4 until the real page size is known
  pages.appendChild(ph.el);
  pdfBytes = new Uint8Array(await file.arrayBuffer());
  await fontReady;
  await render(ph);
}

// Page-shaped shimmer shown where the next page will appear
function placeholder(w, h) {
  const el = document.createElement('div');
  el.className = 'flex flex-col items-center gap-3';
  el.innerHTML = `<div class="shimmer rounded-sm shadow-md ring-1 ring-black/5"></div>
                  <p class="text-sm text-muted-foreground">Reading PDF…</p>`;
  const page = el.firstElementChild, label = el.lastElementChild;
  const size = (w, h) => { page.style.width = w * zoom + 'px'; page.style.height = h * zoom + 'px'; };
  size(w, h);
  return { el, size, label };
}

async function render(ph) {
  pageList = [];
  fields = [];
  overlays = [];
  images = [];
  setDownloadEnabled(false);
  setStatus('Reading PDF…');
  // pdf.js takes ownership of the buffer it gets, so hand it a copy
  const doc = await pdfjsLib.getDocument({ data: pdfBytes.slice() }).promise;
  // At least 2 image px per screen px: thin box lines in scans vanish at lower resolution
  const ratio = Math.max(2, window.devicePixelRatio || 1);

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const vp = page.getViewport({ scale: SCALE });
    ph.size(vp.width, vp.height);
    ph.label.textContent = `Reading page ${i} of ${doc.numPages}`;
    setStatus(`Reading page ${i} of ${doc.numPages}`);

    // Built off-screen, then faded in where the placeholder is
    const wrap = document.createElement('div');
    wrap.className = 'page-wrap';
    const div = document.createElement('div');
    div.className = 'page loading rounded-sm shadow-md ring-1 ring-black/5';
    div.style.width = vp.width + 'px';
    div.style.height = vp.height + 'px';
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vp.width * ratio);
    canvas.height = Math.round(vp.height * ratio);
    canvas.style.width = vp.width + 'px';
    canvas.style.height = vp.height + 'px';
    div.appendChild(canvas);
    wrap.appendChild(div);
    const info = { div, wrap, vp, index: i - 1 };
    pageList.push(info);
    applyZoom(info);

    // Default annotation mode leaves form widgets out of the canvas; our HTML inputs replace them
    await page.render({
      canvasContext: canvas.getContext('2d'),
      viewport: vp,
      transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : null,
    }).promise;

    const widgets = (await page.getAnnotations()).filter(a => a.subtype === 'Widget' && a.fieldName && !a.readOnly);
    widgets.forEach(a => addField(div, vp, a));
    // Flat or scanned page: find dotted lines and boxes in the image
    if (!widgets.length) addDetected(div, vp, i - 1, canvas, ratio);

    wirePage(info, canvas);
    pages.insertBefore(wrap, ph.el);
    div.getBoundingClientRect();   // commit the hidden state so the fade runs
    div.classList.remove('loading');
  }

  ph.el.remove();
  sidebar.classList.replace('opacity-60', 'opacity-100');
  setDownloadEnabled(true);
  setStatus(statusText());
  pages.querySelector('.field, .overlay')?.focus();
}

// ---------- Zoom ----------

function applyZoom(p) {
  p.wrap.style.width = p.vp.width * zoom + 'px';
  p.wrap.style.height = p.vp.height * zoom + 'px';
  p.div.style.transform = `scale(${zoom})`;
}

function setZoom(z) {
  zoom = Math.round(Math.min(2, Math.max(0.5, z)) * 10) / 10;
  zoomReset.textContent = Math.round(zoom * 100) + '%';
  pageList.forEach(applyZoom);
}
zoomIn.onclick = () => setZoom(zoom + 0.1);
zoomOut.onclick = () => setZoom(zoom - 0.1);
zoomReset.onclick = () => setZoom(1);

// Pointer position in page layout px (undoes the zoom)
function pagePoint(div, e) {
  const r = div.getBoundingClientRect();
  return { x: (e.clientX - r.left) / zoom, y: (e.clientY - r.top) / zoom };
}

// ---------- Tools ----------

const HINTS = {
  draw: 'Drag on the page to add a field · Esc to finish',
  sign: 'Click where the signature goes · Esc to cancel',
  date: "Click where today's date goes · Esc to cancel",
};

function setMode(m) {
  mode = m;
  main.dataset.mode = m;
  toolsBar.querySelectorAll('[data-tool]').forEach(b => b.setAttribute('aria-pressed', b.dataset.tool === m));
  toolHint.textContent = HINTS[m] || '';
  toolHint.classList.toggle('hidden', !HINTS[m]);
}

toolsBar.addEventListener('click', e => {
  const tool = e.target.closest('[data-tool]')?.dataset.tool;
  if (!tool) return;
  if (tool === 'sign') return openSignature();
  setMode(mode === tool ? 'type' : tool);
});

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (!sigDialog.classList.contains('hidden')) closeSignature();
  else if (mode !== 'type') setMode('type');
});

function wirePage(p, canvas) {
  const { div, vp, index } = p;
  div.addEventListener('click', e => {
    if (e.target !== canvas) return;
    const pt = pagePoint(div, e);
    if (mode === 'type') addFreeText(div, vp, index, pt);
    else if (mode === 'date') { addFreeText(div, vp, index, pt, new Date().toLocaleDateString()); setMode('type'); }
    else if (mode === 'sign' && signature) { addImage(div, vp, index, pt, signature); setMode('type'); }
  });

  // Add field: drag a rectangle
  div.addEventListener('pointerdown', e => {
    if (mode !== 'draw' || e.target !== canvas || e.button !== 0) return;
    e.preventDefault();
    const start = pagePoint(div, e);
    const draft = document.createElement('div');
    draft.className = 'draft';
    div.appendChild(draft);
    let rect = null;
    const move = ev => {
      const p = pagePoint(div, ev);
      rect = { left: Math.min(start.x, p.x), top: Math.min(start.y, p.y),
               width: Math.abs(p.x - start.x), height: Math.abs(p.y - start.y) };
      Object.assign(draft.style, { left: rect.left + 'px', top: rect.top + 'px', width: rect.width + 'px', height: rect.height + 'px' });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      draft.remove();
      if (rect && rect.width > 6 && rect.height > 6) addCustomField(div, vp, index, rect);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}

// A drawn rectangle becomes a checkbox (small square), a multi-line box (tall) or a one-line box
function addCustomField(div, vp, pageIndex, r) {
  const wPt = r.width / SCALE, hPt = r.height / SCALE;
  let kind = 'box';
  if (wPt < 30 && hPt < 30 && wPt / hPt > 0.6 && wPt / hPt < 1.6) kind = 'check';
  else if (hPt >= settings.size * LINE_GAP * 2.5) kind = 'area';
  const t = addOverlay(div, vp, pageIndex, { kind, ...r, align: 'left' });
  if (kind !== 'check') t.el.focus();
  setStatus(statusText());
}

// ---------- Real PDF form fields ----------

function addField(div, vp, a) {
  const [x1, y1, x2, y2] = vp.convertToViewportRectangle(a.rect);
  const left = Math.min(x1, x2), top = Math.min(y1, y2);
  const w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
  let el, type;

  if (a.fieldType === 'Tx') {
    el = document.createElement(a.multiLine ? 'textarea' : 'input');
    el.value = a.fieldValue || '';
    if (a.maxLen) el.maxLength = a.maxLen;
    el.addEventListener('input', () => applyCaps(el));
    type = 'text';
  } else if (a.fieldType === 'Btn' && (a.checkBox || a.radioButton)) {
    el = document.createElement('input');
    el.type = a.checkBox ? 'checkbox' : 'radio';
    if (a.radioButton) el.name = 'radio_' + a.fieldName;
    el.checked = a.checkBox ? !!a.fieldValue && a.fieldValue !== 'Off' : a.fieldValue === a.buttonValue;
    type = el.type;
  } else if (a.fieldType === 'Ch') {
    el = document.createElement('select');
    el.add(new Option('', ''));
    for (const o of a.options || []) el.add(new Option(o.displayValue, o.exportValue));
    el.value = (Array.isArray(a.fieldValue) ? a.fieldValue[0] : a.fieldValue) || '';
    type = 'choice';
  } else {
    return; // push buttons, signatures: not handled
  }

  el.className = 'field';
  el.title = a.fieldName;
  Object.assign(el.style, {
    left: left + 'px', top: top + 'px', width: w + 'px', height: h + 'px',
    fontSize: Math.min(h * 0.7, settings.size * SCALE) + 'px',
  });
  div.appendChild(el);
  fields.push({ name: a.fieldName, type, el, height: h, buttonValue: a.buttonValue });
}

function applyCaps(el) {
  if (!settings.caps || el.value === el.value.toUpperCase()) return;
  const { selectionStart: s, selectionEnd: e } = el;
  el.value = el.value.toUpperCase();
  el.setSelectionRange(s, e);
}

// ---------- Detected areas on flat / scanned pages ----------

function addDetected(div, vp, pageIndex, canvas, ratio) {
  const img = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  const { lines, cells, order } = detectFields(img.data, canvas.width, canvas.height, SCALE * ratio);
  const specs = [];

  for (const l of lines) {
    // Text sits on the dotted line: baseline just above the dots
    specs.push({ kind: 'line', left: l.x1 / ratio, width: (l.x2 - l.x1) / ratio, baseline: l.y / ratio - SCALE, align: 'left' });
  }

  const boxes = cells.map(c => ({
    left: c.x1 / ratio, top: c.y1 / ratio, width: (c.x2 + 1 - c.x1) / ratio, height: (c.y2 + 1 - c.y1) / ratio,
  }));
  // Square boxes that touch a neighbor form a row for one character each (ID numbers);
  // a square on its own is a checkbox
  const touches = (a, b) => a !== b && Math.abs(a.top - b.top) < a.height * 0.3 &&
    Math.min(Math.abs(b.left - (a.left + a.width)), Math.abs(a.left - (b.left + b.width))) < a.height * 0.4;
  for (const b of boxes) {
    const square = b.width <= b.height * 1.4;
    if (square) {
      const inRow = boxes.some(o => o.width <= o.height * 1.4 && touches(b, o));
      specs.push({ kind: inRow ? 'cell' : 'check', ...b, align: 'center' });
    } else if (b.width <= b.height * 3) {
      // Short wide cell (yes / no columns in a checklist): a centered mark
      specs.push({ kind: 'mark', ...b, align: 'center' });
    } else if (b.height / SCALE >= 41) {
      // Tall box (address, notes): several lines of text
      specs.push({ kind: 'area', ...b, align: 'left' });
    } else {
      // Long box or table cell: a line of text from the left
      specs.push({ kind: 'box', ...b, align: 'left' });
    }
  }

  // Reading order (row by row, or column by column on multi-column layouts) drives Tab and auto-advance
  const box = s => s.kind === 'line'
    ? { x1: s.left, y1: s.baseline - 14 * SCALE, x2: s.left + s.width, y2: s.baseline + 2 * SCALE }
    : { x1: s.left, y1: s.top, x2: s.left + s.width, y2: s.top + s.height };
  const ordered = order(specs.map(s => {
    const b = box(s);
    return { x1: b.x1 * ratio, y1: b.y1 * ratio, x2: b.x2 * ratio, y2: b.y2 * ratio, s };
  })).map(o => o.s);

  const items = ordered.map(s => addOverlay(div, vp, pageIndex, s));
  const combs = items.filter(t => t.kind === 'cell');
  combs.forEach((t, i) => wireCell(t, combs[i - 1], combs[i + 1], combs.slice(i + 1)));
}

// ---------- Overlays ----------

// An overlay is one fillable area on the page:
//   line  – text on a dotted / solid line; follows the text size
//   box   – one line of text inside a box      area – several lines inside a tall box
//   cell  – one character in a row of boxes    mark – a short centered entry in a small cell
//   check – a checkbox, ticked by click        free – text placed anywhere by clicking
function addOverlay(div, vp, pageIndex, s) {
  const el = s.kind === 'check' ? document.createElement('button')
           : document.createElement(s.kind === 'area' ? 'textarea' : 'input');
  el.className = 'overlay ' + s.kind;
  const item = { pageIndex, vp, el, ...s };
  if (s.kind === 'check') {
    el.type = 'button';
    el.setAttribute('aria-label', 'Checkbox');
    item.checked = false;
    el.addEventListener('click', () => { item.checked = !item.checked; renderCheck(item); });
  } else {
    el.autocomplete = 'off';
    el.spellcheck = false;
    el.addEventListener('input', () => { applyCaps(el); fitText(item); });
  }
  el.addEventListener('focus', () => showControls(item));
  div.appendChild(el);
  overlays.push(item);
  layout(item);
  return item;
}

function layout(t) {
  const size = settings.size;
  if (t.kind === 'line' || t.kind === 'free') {
    t.baseFontPt = size;
    t.height = size * SCALE * 1.45;
    t.top = t.kind === 'line'
      ? t.baseline - t.height / 2 - settings.font.k * size * SCALE
      : t.centerY - t.height / 2;
  } else if (t.kind === 'area') {
    t.baseFontPt = size;
  } else {
    // Text in a box is capped by the box height; single characters read better a little larger
    t.baseFontPt = Math.min(t.height * 0.6 / SCALE, t.kind === 'cell' ? size * 1.25 : size);
  }
  Object.assign(t.el.style, { left: t.left + 'px', top: t.top + 'px', height: t.height + 'px' });
  if (t.kind === 'check') {
    t.el.style.width = t.width + 'px';
    renderCheck(t);
  } else {
    if (t.kind !== 'area') t.el.style.lineHeight = t.height + 'px';
    fitText(t);
  }
  if (active === t) placeControls();
}

// Shrink text so it never spills past the end of its line or box (measured with the PDF font).
// Free text grows its box instead. Multi-line boxes shrink until every line fits the height.
function fitText(t) {
  let pt = t.baseFontPt;
  const room = t.width - PAD * 2;
  if (t.kind === 'free') {
    t.width = Math.max(40, textWidthPx(t.el.value, pt) + PAD * 2 + 8);
  } else if (t.kind === 'area') {
    while (pt > 6 && wrapLines(t.el.value, pt, room).length * pt * LINE_GAP * SCALE > t.height) pt -= 0.5;
    t.el.style.lineHeight = pt * LINE_GAP * SCALE + 'px';
  } else if (t.kind !== 'cell') {
    while (pt > 6 && textWidthPx(t.el.value, pt) > room) pt -= 0.5;
  }
  t.fontPt = pt;
  t.el.style.width = t.width + 'px';
  t.el.style.fontSize = pt * SCALE + 'px';
  if (active === t) placeControls();
}

// Tick mark geometry in box units (0..1), shared by the screen and the PDF
const MARKS = {
  check: [[[0.22, 0.54], [0.42, 0.74], [0.8, 0.3]]],
  cross: [[[0.24, 0.24], [0.76, 0.76]], [[0.76, 0.24], [0.24, 0.76]]],
};
const markStroke = t => Math.max(1.2, Math.min(t.width, t.height) * 0.1);

function renderCheck(t) {
  t.el.setAttribute('aria-pressed', t.checked);
  if (!t.checked) { t.el.innerHTML = ''; return; }
  const paths = MARKS[settings.mark].map(pts =>
    `<polyline points="${pts.map(([x, y]) => `${x * t.width},${y * t.height}`).join(' ')}"/>`).join('');
  t.el.innerHTML = `<svg width="${t.width}" height="${t.height}" fill="none" stroke="#000" stroke-width="${markStroke(t)}"
    stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}

// One character per box. Typing moves forward, Backspace on an empty box moves back,
// pasting spreads the characters over the following boxes.
function wireCell(t, prev, next, rest) {
  const el = t.el;
  el.addEventListener('focus', () => el.select());
  el.addEventListener('input', () => {
    const chars = [...el.value.replace(/\s/g, '')];
    el.value = chars[0] || '';
    let last = t;
    chars.slice(1).forEach((ch, i) => { if (rest[i]) { rest[i].el.value = ch; last = rest[i]; } });
    if (!chars.length) return;
    const after = last === t ? next : rest[rest.indexOf(last) + 1];
    (after || last).el.focus();
  });
  el.addEventListener('keydown', e => {
    if (e.key === 'Backspace' && !el.value && prev) { e.preventDefault(); prev.el.value = ''; prev.el.focus(); }
    else if (e.key === 'ArrowLeft' && prev) { e.preventDefault(); prev.el.focus(); }
    else if (e.key === 'ArrowRight' && next) { e.preventDefault(); next.el.focus(); }
  });
}

function addFreeText(div, vp, pageIndex, pt, value = '') {
  const item = addOverlay(div, vp, pageIndex, { kind: 'free', left: pt.x, centerY: pt.y, width: 40, align: 'left' });
  const el = item.el;
  el.value = settings.caps ? value.toUpperCase() : value;
  fitText(item);
  el.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === 'Escape') el.blur(); });
  el.addEventListener('blur', () => {
    if (el.value.trim()) return;
    if (active === item) hideControls();
    removeItem(item);
  });
  el.focus();
}

// ---------- Delete / resize handles ----------

// One pair of handles follows the focused overlay or signature: × deletes it, the corner square resizes it.
let active = null;
const delBtn = document.createElement('button');
delBtn.className = 'ctl-del';
delBtn.type = 'button';
delBtn.tabIndex = -1;          // not a Tab stop between fields
delBtn.title = 'Delete';
delBtn.setAttribute('aria-label', 'Delete');
delBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';
const sizeHandle = document.createElement('div');
sizeHandle.className = 'ctl-size';
sizeHandle.title = 'Drag to resize';

// Handles appear only when an item is clicked, not when Tab or page load focuses it
let pointerFocus = false;
document.addEventListener('pointerdown', () => { pointerFocus = true; }, true);
document.addEventListener('keydown', () => { pointerFocus = false; }, true);

function showControls(item) {
  if (!pointerFocus) return;
  active = item;
  const div = item.el.parentNode;
  div.appendChild(delBtn);
  if (item.kind === 'free') sizeHandle.remove(); else div.appendChild(sizeHandle);
  placeControls();
}

function placeControls() {
  if (!active) return;
  const right = active.left + active.width, bottom = active.top + active.height;
  Object.assign(delBtn.style, { left: right - 9 + 'px', top: active.top - 9 + 'px' });
  Object.assign(sizeHandle.style, { left: right - 5 + 'px', top: bottom - 5 + 'px' });
}

function hideControls() {
  active = null;
  delBtn.remove();
  sizeHandle.remove();
}

// Clicking a handle must not blur the field it belongs to
for (const h of [delBtn, sizeHandle]) h.addEventListener('pointerdown', e => e.preventDefault());

document.addEventListener('focusin', e => {
  if (active && e.target !== active.el) hideControls();
});
pages.addEventListener('pointerdown', e => {
  if (active && e.target !== active.el && e.target !== delBtn && e.target !== sizeHandle &&
      !delBtn.contains(e.target) && !active.el.contains(e.target)) hideControls();
});

delBtn.addEventListener('click', () => {
  const item = active;
  hideControls();
  removeItem(item);
  setStatus(statusText());
});

function removeItem(item) {
  item.el.remove();
  overlays = overlays.filter(t => t !== item);
  images = images.filter(t => t !== item);
}

sizeHandle.addEventListener('pointerdown', e => {
  const item = active;
  const div = item.el.parentNode;
  const ratio = item.height / item.width;
  const move = ev => {
    const p = pagePoint(div, ev);
    const width = Math.max(12, p.x - item.left);
    if (item.kind === 'sig') {
      Object.assign(item, { width, height: width * ratio });
      placeImage(item);
    } else {
      item.width = width;
      if (item.kind !== 'line') item.height = Math.max(10, p.y - item.top);
      layout(item);
    }
    placeControls();
  };
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
});

// ---------- Signature ----------

const sigCtx = sigCanvas.getContext('2d');
let sigDirty = false;

function openSignature() {
  sigDialog.classList.remove('hidden');
  sigDialog.classList.add('flex');
  const r = sigCanvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  sigCanvas.width = r.width * dpr;
  sigCanvas.height = r.height * dpr;
  sigCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  setSigDirty(false);
  // Start from the saved signature, so "Place signature" is one click away
  if (signature) {
    const img = new Image();
    img.onload = () => { drawFitted(img); setSigDirty(true); };
    img.src = signature;
  }
  sigUse.focus();
}

function closeSignature() {
  sigDialog.classList.add('hidden');
  sigDialog.classList.remove('flex');
}

function setSigDirty(on) {
  sigDirty = on;
  sigEmpty.classList.toggle('hidden', on);
  sigUse.disabled = !on;
}

function clearSig() {
  sigCtx.clearRect(0, 0, sigCanvas.width, sigCanvas.height);
  setSigDirty(false);
}

function drawFitted(img) {
  clearSig();
  const r = sigCanvas.getBoundingClientRect();
  const s = Math.min((r.width - 24) / img.width, (r.height - 24) / img.height, 1);
  const w = img.width * s, h = img.height * s;
  sigCtx.drawImage(img, (r.width - w) / 2, (r.height - h) / 2, w, h);
}

sigCanvas.addEventListener('pointerdown', e => {
  sigCanvas.setPointerCapture(e.pointerId);
  const r = sigCanvas.getBoundingClientRect();
  sigCtx.lineWidth = 2.5;
  sigCtx.lineCap = sigCtx.lineJoin = 'round';
  sigCtx.strokeStyle = '#111827';
  sigCtx.beginPath();
  sigCtx.moveTo(e.clientX - r.left, e.clientY - r.top);
  const move = ev => {
    sigCtx.lineTo(ev.clientX - r.left, ev.clientY - r.top);
    sigCtx.stroke();
    if (!sigDirty) setSigDirty(true);
  };
  const up = () => { sigCanvas.removeEventListener('pointermove', move); sigCanvas.removeEventListener('pointerup', up); };
  sigCanvas.addEventListener('pointermove', move);
  sigCanvas.addEventListener('pointerup', up);
});

sigClear.onclick = clearSig;
sigCancel.onclick = closeSignature;
sigDialog.addEventListener('pointerdown', e => { if (e.target === sigDialog) closeSignature(); });
sigUpload.onclick = () => sigFile.click();
sigFile.onchange = () => {
  const file = sigFile.files[0];
  if (!file) return;
  const img = new Image();
  img.onload = () => { drawFitted(img); setSigDirty(true); URL.revokeObjectURL(img.src); };
  img.src = URL.createObjectURL(file);
  sigFile.value = '';
};

sigUse.onclick = () => {
  signature = trimmedSignature();
  try { localStorage.setItem('signature', signature); } catch {}
  closeSignature();
  setMode('sign');
};

// Crop the drawing to its ink, with a small margin
function trimmedSignature() {
  const { width: W, height: H } = sigCanvas;
  const data = sigCtx.getImageData(0, 0, W, H).data;
  let x1 = W, y1 = H, x2 = 0, y2 = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (data[(y * W + x) * 4 + 3] > 10) {
        if (x < x1) x1 = x; if (x > x2) x2 = x;
        if (y < y1) y1 = y; if (y > y2) y2 = y;
      }
    }
  }
  if (x2 < x1) return sigCanvas.toDataURL('image/png');
  const m = 6;
  x1 = Math.max(0, x1 - m); y1 = Math.max(0, y1 - m);
  x2 = Math.min(W - 1, x2 + m); y2 = Math.min(H - 1, y2 + m);
  const out = document.createElement('canvas');
  out.width = x2 - x1 + 1;
  out.height = y2 - y1 + 1;
  out.getContext('2d').drawImage(sigCanvas, x1, y1, out.width, out.height, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}

// A placed signature: drag to move, corner handle to resize (keeps its proportions)
function addImage(div, vp, pageIndex, pt, png) {
  const el = document.createElement('div');
  el.className = 'sig';
  el.tabIndex = 0;
  el.setAttribute('aria-label', 'Signature');
  const img = document.createElement('img');
  img.alt = '';
  el.appendChild(img);
  const item = { kind: 'sig', pageIndex, vp, el, png, left: 0, top: 0, width: 0, height: 0 };
  img.onload = () => {
    item.width = 120 * SCALE;                                  // about 4 cm wide
    item.height = item.width * img.naturalHeight / img.naturalWidth;
    item.left = pt.x - item.width / 2;
    item.top = pt.y - item.height / 2;
    placeImage(item);
    el.focus();
  };
  img.src = png;
  el.addEventListener('focus', () => showControls(item));
  el.addEventListener('keydown', e => { if (e.key === 'Delete' || e.key === 'Backspace') { hideControls(); removeItem(item); } });
  el.addEventListener('pointerdown', e => {
    e.preventDefault();
    el.focus();
    const start = pagePoint(div, e), from = { left: item.left, top: item.top };
    const move = ev => {
      const p = pagePoint(div, ev);
      item.left = from.left + p.x - start.x;
      item.top = from.top + p.y - start.y;
      placeImage(item);
      placeControls();
    };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  div.appendChild(el);
  images.push(item);
}

function placeImage(t) {
  Object.assign(t.el.style, { left: t.left + 'px', top: t.top + 'px', width: t.width + 'px', height: t.height + 'px' });
}

// ---------- Save ----------

downloadBtn.onclick = async () => {
  const doc = await PDFLib.PDFDocument.load(pdfBytes);
  const form = doc.getForm();
  let font;
  if (settings.font.bytes) {
    doc.registerFontkit(fontkit);
    font = await doc.embedFont(settings.font.bytes, { subset: true });
  } else {
    font = await doc.embedFont(PDFLib.StandardFonts.Helvetica);
  }

  for (const f of fields) {
    try {
      if (f.type === 'text') {
        const tf = form.getTextField(f.name);
        tf.setText(f.el.value);
        tf.setFontSize(settings.size);
      }
      else if (f.type === 'checkbox') f.el.checked ? form.getCheckBox(f.name).check() : form.getCheckBox(f.name).uncheck();
      else if (f.type === 'radio' && f.el.checked) form.getRadioGroup(f.name).select(f.buttonValue);
      else if (f.type === 'choice' && f.el.value) form.getField(f.name).select(f.el.value);
    } catch (err) {
      console.warn('Skipped field', f.name, err.message);
    }
  }
  if (fields.length && settings.font.bytes) form.updateFieldAppearances(font);

  const pdfPages = doc.getPages();
  const toPdf = (t, x, y) => { const [px, py] = t.vp.convertToPdfPoint(x, y); return { x: px, y: py }; };
  const baseline = (t, lineTop, lineH) => lineTop + lineH / 2 + settings.font.k * t.fontPt * SCALE;

  for (const t of overlays) {
    const page = pdfPages[t.pageIndex];
    if (t.kind === 'check') {
      if (!t.checked) continue;
      for (const pts of MARKS[settings.mark]) {
        for (let i = 0; i + 1 < pts.length; i++) {
          page.drawLine({
            start: toPdf(t, t.left + pts[i][0] * t.width, t.top + pts[i][1] * t.height),
            end: toPdf(t, t.left + pts[i + 1][0] * t.width, t.top + pts[i + 1][1] * t.height),
            thickness: markStroke(t) / SCALE, lineCap: PDFLib.LineCapStyle.Round,
          });
        }
      }
      continue;
    }
    const text = t.kind === 'area' ? t.el.value.replace(/\s+$/, '') : t.el.value.trim();
    if (!text) continue;
    try {
      if (t.kind === 'area') {
        const lineH = t.fontPt * LINE_GAP * SCALE;
        wrapLines(text, t.fontPt, t.width - PAD * 2).forEach((line, i) => {
          if (line) page.drawText(line, { ...toPdf(t, t.left + PAD, baseline(t, t.top + i * lineH, lineH)), size: t.fontPt, font });
        });
        continue;
      }
      const w = font.widthOfTextAtSize(text, t.fontPt) * SCALE;
      const x = t.align === 'center' ? t.left + (t.width - w) / 2 : t.left + PAD;
      page.drawText(text, { ...toPdf(t, x, baseline(t, t.top, t.height)), size: t.fontPt, font });
    } catch (err) {
      alert(`Could not write "${text}": ${err.message}\n(Try a different font for these characters.)`);
      return;
    }
  }

  const embedded = {};
  for (const t of images) {
    embedded[t.png] ||= await doc.embedPng(t.png);
    pdfPages[t.pageIndex].drawImage(embedded[t.png], {
      ...toPdf(t, t.left, t.top + t.height), width: t.width / SCALE, height: t.height / SCALE,
    });
  }

  if (flatten) form.flatten();
  const out = await doc.save();
  const url = URL.createObjectURL(new Blob([out], { type: 'application/pdf' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = outName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
