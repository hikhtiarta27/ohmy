// Finds fillable areas on a rendered page image (scanned / flat PDFs).
//   detectFields(rgba, W, H, u) -> { lines: [{x1, x2, y}], cells: [{x1, y1, x2, y2}], order(fields) }
// rgba is canvas ImageData.data, u is image pixels per PDF point. All results are in image pixels.
(function () {
  function binarize(rgba, W, H) {
    const dark = new Uint8Array(W * H);
    for (let i = 0, j = 0; i < dark.length; i++, j += 4) {
      dark[i] = rgba[j] * 0.299 + rgba[j + 1] * 0.587 + rgba[j + 2] * 0.114 < 150 ? 1 : 0;
    }
    return dark;
  }

  // 8-connected components with bounding boxes. label[p] = component index + 1
  function components(dark, W, H) {
    const label = new Int32Array(W * H);
    const stack = new Int32Array(W * H);
    const out = [];
    for (let s = 0; s < W * H; s++) {
      if (!dark[s] || label[s]) continue;
      const id = out.length + 1;
      let sp = 0, x1 = W, y1 = H, x2 = 0, y2 = 0, count = 0;
      stack[sp++] = s;
      label[s] = id;
      while (sp) {
        const p = stack[--sp];
        const x = p % W, y = (p - x) / W;
        count++;
        if (x < x1) x1 = x; if (x > x2) x2 = x;
        if (y < y1) y1 = y; if (y > y2) y2 = y;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= H) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= W) continue;
            const q = yy * W + xx;
            if (dark[q] && !label[q]) { label[q] = id; stack[sp++] = q; }
          }
        }
      }
      out.push({ id, x1, y1, x2, y2, w: x2 - x1 + 1, h: y2 - y1 + 1, count });
    }
    return { comps: out, label };
  }

  const median = a => { const s = [...a].sort((p, q) => p - q); return s[s.length >> 1]; };

  // Dotted leader lines ("Label : ..........") and solid underlines
  function findLines(comps, u) {
    const maxDot = Math.max(3, 3 * u);
    const dots = comps
      .filter(c => c.w <= maxDot && c.h <= maxDot && c.w <= c.h * 3 && c.h <= c.w * 3)
      .map(c => ({ x1: c.x1, x2: c.x2, cy: (c.y1 + c.y2) / 2 }))
      .sort((a, b) => a.x1 - b.x1);

    const chains = [];
    for (const d of dots) {
      const ch = chains.find(ch => {
        const last = ch[ch.length - 1];
        const gap = d.x1 - last.x2;
        return gap > 0 && gap <= 6 * u && Math.abs(d.cy - last.cy) <= 1.2 * u;
      });
      ch ? ch.push(d) : chains.push([d]);
    }

    const lines = [];
    for (let ch of chains) {
      if (ch.length < 8) continue;
      // Drop stray end dots (e.g. the colon before the leader) that break the regular spacing
      const gap = median(ch.slice(1).map((d, i) => d.x1 - ch[i].x1));
      while (ch.length > 2 && ch[1].x1 - ch[0].x1 > gap * 1.8) ch = ch.slice(1);
      while (ch.length > 2 && ch[ch.length - 1].x1 - ch[ch.length - 2].x1 > gap * 1.8) ch = ch.slice(0, -1);
      const x1 = ch[0].x1, x2 = ch[ch.length - 1].x2;
      if (x2 - x1 >= 30 * u) lines.push({ x1, x2, y: median(ch.map(d => d.cy)) });
    }
    // A solid line is a fill-in underline only when a label sits right before it on the same baseline.
    // Long rules with nothing before them are section separators.
    const labelBefore = l => comps.some(o =>
      o.h >= 3 * u && o.h <= 30 * u && o.x2 <= l.x1 + 1 && o.x2 >= l.x1 - 20 * u &&
      o.y2 >= l.y - 15 * u && o.y1 <= l.y + 2 * u);
    for (const c of comps) {
      if (c.h > 2 * u || c.w < 30 * u) continue;
      const l = { x1: c.x1, x2: c.x2, y: (c.y1 + c.y2) / 2 };
      if (labelBefore(l)) lines.push(l);
    }
    // Drop a line that mostly repeats another one (e.g. dots that touch a ruled line)
    return lines.filter((l, i) => !lines.some((o, j) => j < i &&
      Math.abs(o.y - l.y) <= 3 * u &&
      Math.min(o.x2, l.x2) - Math.max(o.x1, l.x1) > 0.8 * Math.min(o.x2 - o.x1, l.x2 - l.x1)));
  }

  // Empty boxes: rectangular holes enclosed by one ruled component (box rows, table cells).
  // A hole with other print inside (labels, text, nested boxes, dotted lines) is a frame, not a field.
  function findCells(comps, label, W, u) {
    const minH = 7 * u, minW = 6 * u;
    const speck = 4 * u * u;  // scanner dust smaller than this (in pixels) doesn't count as print
    const cells = [];

    for (const c of comps) {
      if (c.w < minW + 2 || c.h < minH + 2) continue;
      const bw = c.w, bh = c.h, n = bw * bh;
      // 0 = unvisited, -1 = outside, k > 0 = hole k
      const mark = new Int32Array(n);
      const stack = new Int32Array(n);
      const isWall = i => label[(c.y1 + ((i / bw) | 0)) * W + c.x1 + (i % bw)] === c.id;

      const flood = (start, value) => {
        let sp = 0, count = 0, x1 = bw, y1 = bh, x2 = 0, y2 = 0;
        stack[sp++] = start;
        mark[start] = value;
        while (sp) {
          const p = stack[--sp];
          const x = p % bw, y = (p - x) / bw;
          count++;
          if (x < x1) x1 = x; if (x > x2) x2 = x;
          if (y < y1) y1 = y; if (y > y2) y2 = y;
          // 4-connected fill: diagonal gaps in an 8-connected wall can't leak
          const nb = [x > 0 ? p - 1 : -1, x < bw - 1 ? p + 1 : -1, y > 0 ? p - bw : -1, y < bh - 1 ? p + bw : -1];
          for (const q of nb) {
            if (q >= 0 && !mark[q] && !isWall(q)) { mark[q] = value; stack[sp++] = q; }
          }
        }
        return { count, x1, y1, x2, y2 };
      };

      for (let x = 0; x < bw; x++) {
        for (const i of [x, (bh - 1) * bw + x]) if (!mark[i] && !isWall(i)) flood(i, -1);
      }
      for (let y = 0; y < bh; y++) {
        for (const i of [y * bw, y * bw + bw - 1]) if (!mark[i] && !isWall(i)) flood(i, -1);
      }

      const holes = [];
      for (let i = 0; i < n; i++) {
        if (!mark[i] && !isWall(i)) holes.push(flood(i, holes.length + 1));
      }
      // Thick strokes around small gaps are letters (like D or P), not boxes drawn with thin lines
      if (c.count > holes.reduce((s, r) => s + r.count, 0) * 0.7) continue;

      const boxes = [];
      for (let k = 1; k <= holes.length; k++) {
        const r = holes[k - 1];
        const w = r.x2 - r.x1 + 1, h = r.y2 - r.y1 + 1;
        if (w < minW || h < minH || w < h * 0.5) continue;
        if (r.count / (w * h) < 0.88) continue;   // not a rectangle (letter shapes, round marks)

        // Anything printed inside the hole?
        const seen = new Set();
        let filled = false;
        for (let y = r.y1; y <= r.y2 && !filled; y++) {
          for (let x = r.x1; x <= r.x2; x++) {
            if (mark[y * bw + x] !== k) continue;
            const l = label[(c.y1 + y) * W + c.x1 + x];
            if (!l || l === c.id || seen.has(l)) continue;
            seen.add(l);
            if (comps[l - 1].count >= speck) { filled = true; break; }
          }
        }
        boxes.push({ x1: c.x1 + r.x1, y1: c.y1 + r.y1, x2: c.x1 + r.x2, y2: c.y1 + r.y2, filled });
      }

      // An empty cell whose row is otherwise all printed text is a header corner, not a field
      for (const b of boxes) {
        if (b.filled) continue;
        const row = boxes.filter(o => o !== b && o.y1 < b.y2 && o.y2 > b.y1);
        if (row.length >= 2 && row.every(o => o.filled)) continue;
        cells.push({ x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2 });
      }
    }
    return cells;
  }

  // Tab order for fields [{x1, y1, x2, y2}]: rows top to bottom, left to right. Where consecutive rows
  // share an empty vertical gutter (no print, no field, no separator crossing it) with fields on both
  // sides, those rows are columns: each column is read top to bottom before the next one.
  function makeOrder(dark, W, H, u) {
    const inkColumns = (y1, y2) => {
      const col = new Uint8Array(W);
      for (let y = Math.max(0, Math.floor(y1)); y <= Math.min(H - 1, Math.ceil(y2)); y++) {
        for (let x = 0; x < W; x++) if (dark[y * W + x]) col[x] = 1;
      }
      return col;
    };
    // Widen ink by 2pt each side, so gaps between letters and words never count as a gutter
    const pad = Math.ceil(2 * u);
    const widen = col => {
      const out = new Uint8Array(W);
      for (let x = 0; x < W; x++) {
        if (col[x]) out.fill(1, Math.max(0, x - pad), Math.min(W, x + pad + 1));
      }
      return out;
    };

    // A gutter at x splits rows into columns when at least 2 rows have a field left of it, at least
    // 2 rows have a field right of it, and every row's first field right of it has a label before it
    // (print between the gutter and the field). Option grids (box, then its label) don't qualify,
    // so they keep row order.
    const splits = (rows, x) => {
      let left = 0, right = 0;
      for (const r of rows) {
        if (r.items.some(b => b.x2 < x)) left++;
        const first = r.items.find(b => b.x1 > x);
        if (!first) continue;
        // Skip the last 3pt before the field: that's the box's own border, not a label
        const end = Math.floor(first.x1 - 3 * u);
        if (end <= x || r.inkSum[end] - r.inkSum[x] === 0) return false;
        right++;
      }
      return left >= 2 && right >= 2;
    };

    const split = (rows, xa, xb) => {
      let best = null;
      for (let x = Math.ceil(xa) + 1; x < xb; x += 2) {
        let start = 0;
        for (let i = 0; i <= rows.length; i++) {
          const free = i < rows.length && !rows[i].blocked[x];
          if (free && (i === start || !rows[i - 1].gapBlocked[x])) continue;
          if (i - start >= 2 && (!best || i - start > best.b - best.a) && splits(rows.slice(start, i), x)) {
            best = { x, a: start, b: i };
          }
          start = free ? i : i + 1;
        }
      }
      if (!best) return rows.flatMap(r => r.items);
      const block = rows.slice(best.a, best.b);
      const side = keep => block.map(r => ({ ...r, items: r.items.filter(keep) }));
      return [
        ...split(rows.slice(0, best.a), xa, xb),
        ...split(side(b => b.x2 < best.x), xa, best.x),
        ...split(side(b => b.x1 > best.x), best.x, xb),
        ...split(rows.slice(best.b), xa, xb),
      ];
    };

    return items => {
      const mid = b => (b.y1 + b.y2) / 2;
      const rows = [];
      for (const b of [...items].sort((p, q) => mid(p) - mid(q))) {
        const r = rows[rows.length - 1];
        if (r && mid(b) - r.mid <= 8 * u) {
          r.items.push(b);
          r.y1 = Math.min(r.y1, b.y1);
          r.y2 = Math.max(r.y2, b.y2);
        } else {
          rows.push({ mid: mid(b), items: [b], y1: b.y1, y2: b.y2 });
        }
      }
      rows.forEach((r, i) => {
        r.items.sort((p, q) => p.x1 - q.x1);
        const ink = inkColumns(r.y1, r.y2);
        r.inkSum = new Int32Array(W + 1);
        for (let x = 0; x < W; x++) r.inkSum[x + 1] = r.inkSum[x] + ink[x];
        r.blocked = widen(ink);
        for (const b of r.items) {
          for (let x = Math.max(0, Math.floor(b.x1)); x <= Math.min(W - 1, Math.ceil(b.x2)); x++) r.blocked[x] = 1;
        }
        const next = rows[i + 1];
        r.gapBlocked = next ? widen(inkColumns(r.y2 + 1, next.y1 - 1)) : null;
      });
      return split(rows, 0, W);
    };
  }

  function detectFields(rgba, W, H, u) {
    const dark = binarize(rgba, W, H);
    const { comps, label } = components(dark, W, H);
    return { lines: findLines(comps, u), cells: findCells(comps, label, W, u), order: makeOrder(dark, W, H, u) };
  }

  if (typeof module !== 'undefined') module.exports = { detectFields };
  else window.detectFields = detectFields;
})();
