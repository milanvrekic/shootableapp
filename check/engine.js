/* Shootable — "is this spot legal for this firearm, today?" verdict engine (BC + Alberta).
 * Pure functions; runs in the WebView and in Node (tests). Same shape as Huntable's engine.js.
 *
 * Trust rules built in (from the project context, section 3):
 *  1. Three states only: PROHIBITED · NO PROHIBITION FOUND ("clear") · NOT CONFIRMED. Never "legal".
 *     "clear" needs every required layer loaded, fresh and verified; anything less is NOT CONFIRMED.
 *  2. Every check carries its rule, instrument + section, layer and "data as of" date.
 *  3. Boundary uncertainty: the point is re-checked on a ring at the GPS accuracy; a ring point that is
 *     prohibited when the centre isn't turns the answer into NOT CONFIRMED.
 *  4. Missing, unloaded, stale or unresearched data is reported, never assumed clear.
 *  5. Conditions maps can't settle (dwelling setbacks, lot size without parcels) are NOT CONFIRMED.
 *  6. Each province is its own pack with its own projection; an Alberta failure never touches BC answers.
 *
 * Data shapes are documented in docs/rule-schema.md and app/schema/*.schema.json.
 */
(function (root) {
  'use strict';

  const ENGINE_VERSION = 'sh-0.4 (2026-11-20)';
  const STATE = { prohibited: 'Prohibited', clear: 'No prohibition found', unconfirmed: 'Not confirmed' };
  const RING_POINTS = 8;
  const DEFAULT_MAX_AGE_DAYS = 30; // a pack older than this answers NOT CONFIRMED until it is updated

  // ---------- projections ----------
  // BC: EPSG:3005 NAD83 / BC Albers (same constants as Huntable). AB: EPSG:3400 NAD83 / Alberta 10-TM (Forest).
  const A = 6378137, F = 1 / 298.257222101, E2 = 2 * F - F * F, E = Math.sqrt(E2), D2R = Math.PI / 180;
  const albers = (() => {
    const LAT0 = 45 * D2R, LAT1 = 50 * D2R, LAT2 = 58.5 * D2R, LON0 = -126 * D2R, FE = 1000000;
    const q = (p) => { const s = Math.sin(p); return (1 - E2) * (s / (1 - E2 * s * s) - (1 / (2 * E)) * Math.log((1 - E * s) / (1 + E * s))); };
    const m = (p) => Math.cos(p) / Math.sqrt(1 - E2 * Math.sin(p) ** 2);
    const m1 = m(LAT1), m2 = m(LAT2), q0 = q(LAT0), q1 = q(LAT1), q2 = q(LAT2);
    const N = (m1 * m1 - m2 * m2) / (q2 - q1), C = m1 * m1 + N * q1, RHO0 = A * Math.sqrt(C - N * q0) / N;
    return (lon, lat) => { const rho = A * Math.sqrt(C - N * q(lat * D2R)) / N, th = N * (lon * D2R - LON0); return [FE + rho * Math.sin(th), RHO0 - rho * Math.cos(th)]; };
  })();
  function transverseMercator(lon0, k0, fe, fn) { // Snyder (1987) 8-9..8-10; sub-millimetre over a 6° band
    const ep2 = E2 / (1 - E2), e4 = E2 * E2, e6 = e4 * E2;
    const M = (p) => A * ((1 - E2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * p - (3 * E2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * Math.sin(2 * p)
      + (15 * e4 / 256 + 45 * e6 / 1024) * Math.sin(4 * p) - (35 * e6 / 3072) * Math.sin(6 * p));
    return (lon, lat) => {
      const p = lat * D2R, s = Math.sin(p), c = Math.cos(p), t = Math.tan(p);
      const n = A / Math.sqrt(1 - E2 * s * s), T = t * t, Cc = ep2 * c * c, a = (lon - lon0) * D2R * c;
      const x = k0 * n * (a + (1 - T + Cc) * a ** 3 / 6 + (5 - 18 * T + T * T + 72 * Cc - 58 * ep2) * a ** 5 / 120);
      const y = k0 * (M(p) + n * t * (a * a / 2 + (5 - T + 9 * Cc + 4 * Cc * Cc) * a ** 4 / 24 + (61 - 58 * T + T * T + 600 * Cc - 330 * ep2) * a ** 6 / 720));
      return [fe + x, fn + y];
    };
  }
  const PROJ = { 'EPSG:3005': albers, 'EPSG:3400': transverseMercator(-115, 0.9992, 500000, 0) };

  // ---------- geometry (projected metres; rings and paths are delta-encoded flat arrays, as in Huntable) ----------
  function decodeRing(flat) {
    const out = new Array(flat.length / 2); let x = 0, y = 0;
    for (let i = 0, j = 0; i < flat.length; i += 2, j++) { x += flat[i]; y += flat[i + 1]; out[j] = [x, y]; }
    return out;
  }
  function encodeRing(pts) { const out = []; let px = 0, py = 0; for (const [x, y] of pts) { out.push(x - px, y - py); px = x; py = y; } return out; }
  function bboxOf(parts) {
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const r of parts) for (const [x, y] of r) { if (x < a) a = x; if (y < b) b = y; if (x > c) c = x; if (y > d) d = y; }
    return [a, b, c, d];
  }
  function bboxOfFlat(flats) { // the same box as bboxOf(flats.map(decodeRing)), without building the points
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const r of flats) { let x = 0, y = 0; for (let i = 0; i < r.length; i += 2) { x += r[i]; y += r[i + 1]; if (x < a) a = x; if (y < b) b = y; if (x > c) c = x; if (y > d) d = y; } }
    return [a, b, c, d];
  }
  function inRings(rings, x, y) { // even-odd over all rings (holes included)
    let n = 0; for (const r of rings) n += r.length;
    if (n > 256) return inRingsBanded(rings, x, y);
    let inside = false;
    for (const r of rings) for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i], [xj, yj] = r[j];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  // Big polygons (management units, regional districts): edges bucketed into horizontal bands once, so a point test
  // only crosses the edges in its band. Same even-odd result as the plain loop.
  const BANDS = new WeakMap();
  function inRingsBanded(rings, x, y) {
    let B = BANDS.get(rings);
    if (!B) {
      let y0 = Infinity, y1 = -Infinity, n = 0;
      for (const r of rings) for (const p of r) { if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; n++; }
      const k = Math.max(1, Math.min(4096, Math.ceil(n / 8))), h = (y1 - y0) / k || 1, bands = Array.from({ length: k }, () => []);
      for (const r of rings) for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const a = r[j], b = r[i], lo = Math.min(a[1], b[1]), hi = Math.max(a[1], b[1]);
        const s0 = Math.max(0, Math.floor((lo - y0) / h)), s1 = Math.min(k - 1, Math.floor((hi - y0) / h));
        for (let s = s0; s <= s1; s++) bands[s].push(a[0], a[1], b[0], b[1]);
      }
      B = { y0, y1, h, k, bands }; BANDS.set(rings, B);
    }
    if (y < B.y0 || y > B.y1) return false;
    const e = B.bands[Math.min(B.k - 1, Math.floor((y - B.y0) / B.h))];
    let inside = false;
    for (let i = 0; i < e.length; i += 4) {
      const xj = e[i], yj = e[i + 1], xi = e[i + 2], yi = e[i + 3];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function segDist(x, y, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
    return Math.hypot(x - ax - t * dx, y - ay - t * dy);
  }
  function distToParts(parts, x, y, closed) {
    let best = Infinity;
    for (const p of parts) {
      const n = p.length, last = closed ? n : n - 1;
      for (let i = 0; i < last; i++) { const a = p[i], b = p[(i + 1) % n]; const d = segDist(x, y, a[0], a[1], b[0], b[1]); if (d < best) best = d; }
    }
    return best;
  }
  const inBox = (b, x, y, pad) => x >= b[0] - pad && x <= b[2] + pad && y >= b[1] - pad && y <= b[3] + pad;

  // ---------- spatial index: a uniform grid over feature bboxes, built lazily per features array ----------
  // Queries return feature indexes in the layer's original order, so every answer is identical to a full scan
  // (hit() keeps "first containing feature wins"). Features whose bbox covers too many cells sit in a short list
  // that every query checks (a regional district, a long closed-area polygon).
  const GRID_CELL = 4000, GRID_MAX_CELLS = 400, INDEXES = new WeakMap();
  function indexOf(features) {
    let ix = INDEXES.get(features);
    if (ix) return ix;
    const cells = new Map(), big = [];
    for (let i = 0; i < features.length; i++) {
      const b = features[i].bb; if (!b || !isFinite(b[0])) continue;
      const x0 = Math.floor(b[0] / GRID_CELL), x1 = Math.floor(b[2] / GRID_CELL), y0 = Math.floor(b[1] / GRID_CELL), y1 = Math.floor(b[3] / GRID_CELL);
      if ((x1 - x0 + 1) * (y1 - y0 + 1) > GRID_MAX_CELLS) { big.push(i); continue; }
      for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) { const k = cx * 65536 + cy; const a = cells.get(k); if (a) a.push(i); else cells.set(k, [i]); }
    }
    ix = { cells, big }; INDEXES.set(features, ix); return ix;
  }
  // Indexes of features whose bbox may meet the box [x0,y0,x1,y1], ascending (original order).
  const mergeSorted = (a, b) => { const out = new Array(a.length + b.length); let i = 0, j = 0, k = 0;
    while (i < a.length && j < b.length) out[k++] = a[i] < b[j] ? a[i++] : b[j++];
    while (i < a.length) out[k++] = a[i++]; while (j < b.length) out[k++] = b[j++]; return out; };
  function candidates(features, x0, y0, x1, y1) {
    if (features.length < 32) return null; // small layers: a plain scan is as fast
    const ix = indexOf(features);
    const cx0 = Math.floor(x0 / GRID_CELL), cx1 = Math.floor(x1 / GRID_CELL), cy0 = Math.floor(y0 / GRID_CELL), cy1 = Math.floor(y1 / GRID_CELL);
    if (cx0 === cx1 && cy0 === cy1) { const a = ix.cells.get(cx0 * 65536 + cy0); return a ? (ix.big.length ? mergeSorted(a, ix.big) : a) : ix.big; } // a point: cell lists are already ascending
    if ((cx1 - cx0 + 1) * (cy1 - cy0 + 1) > 4 * GRID_MAX_CELLS) return null; // a huge query box: scan
    const seen = new Set(ix.big);
    for (let cx = cx0; cx <= cx1; cx++) for (let cy = cy0; cy <= cy1; cy++) { const a = ix.cells.get(cx * 65536 + cy); if (a) for (const i of a) seen.add(i); }
    return [...seen].sort((a, b) => a - b);
  }
  // Indexes (ascending) of the features with the given ids: a rule naming features skips the rest of the layer.
  const ID_INDEX = new WeakMap(), ID_LISTS = new WeakMap();
  function byIds(features, ids) {
    let m = ID_INDEX.get(features);
    if (!m) { m = new Map(); features.forEach((f, i) => { const a = m.get(f.id); if (a) a.push(i); else m.set(f.id, [i]); }); ID_INDEX.set(features, m); }
    const key = Array.isArray(ids) ? ids : [ids];
    let c = ID_LISTS.get(features); if (!c) { c = new Map(); ID_LISTS.set(features, c); }
    const k = key.join('\u0001'); let out = c.get(k);
    if (!out) { out = []; for (const id of key) for (const i of m.get(id) || []) out.push(i); out.sort((a, b) => a - b); c.set(k, out); }
    return out;
  }
  // The same list, remembered on the rule's `where` (a rule names the same features every time; skips the key join).
  const WHERE_IDS = new WeakMap();
  function byWhere(features, where) {
    const c = WHERE_IDS.get(where);
    if (c && c.features === features) return c.out;
    const out = byIds(features, where.features); WHERE_IDS.set(where, { features, out }); return out;
  }
  // Iterate features near a box without allocating when the index isn't worth it.
  function* nearby(features, x0, y0, x1, y1) {
    const c = candidates(features, x0, y0, x1, y1);
    if (!c) { yield* features; return; }
    for (const i of c) yield features[i];
  }
  const containing = (features, x, y) => { for (const f of nearby(features, x, y, x, y)) if (f.closed && inBox(f.bb, x, y, 0) && inRings(f.parts, x, y)) return f; return null; };

  // ---------- data model ----------
  // packs: { provinces: {features:[{id:'BC'|'AB', rings:[lon/lat rings, not encoded]}]}, BC: pack, AB: pack,
  //         live?: { BC: [feed, ...], AB: [...] } }   feeds: live.schema.json (e.g. BC fire orders), merged into their own
  // province's pack only; a feed for the other province or projection is ignored, so one province's feed can't touch the other.
  function prepare(packs) {
    const provinces = (packs.provinces ? packs.provinces.features : []).map(f => ({ id: f.id, rings: f.rings, bb: bboxOf(f.rings) }));
    const P = {}, live = packs.live || {};
    for (const id of ['BC', 'AB']) if (packs[id]) P[id] = preparePack(packs[id], live[id]);
    return { provinces, packs: P };
  }
  function prepareLayer(L) {
    if (L.xyz) { // spot elevations: flat [x, y, z, ...] in metres, indexed on a 10 km grid
      const grid = new Map(), C = 10000;
      for (let i = 0; i < L.xyz.length; i += 3) { const k = Math.floor(L.xyz[i] / C) + ',' + Math.floor(L.xyz[i + 1] / C); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(L.xyz[i], L.xyz[i + 1], L.xyz[i + 2]); }
      return Object.assign({}, L, { features: [], grid, cell: C });
    }
    // A feature's outlines are decoded the first time something reads `parts` (a tap near it, the shading, the
    // downrange fan), not at load: most features are never touched in a session. The bbox comes straight from the
    // delta arrays, so the index and every bbox test work without decoding. Same points, same answers.
    const features = L.features ? L.features.map(f => {
      const flat = f.rings || f.paths || [];
      const o = Object.assign({}, f, { closed: !!f.rings, bb: bboxOfFlat(flat) });
      if (o.rings) o.rings = undefined; if (o.paths) o.paths = undefined; // the deltas stay only in `flat`, until decoded
      let parts = null;
      Object.defineProperty(o, 'parts', { enumerable: true, get() { return parts || (parts = flat.map(decodeRing)); } });
      return o;
    }) : null; // null = layer exists but isn't loaded on this phone (e.g. a region not saved offline)
    const stale = L.stale_extent ? L.stale_extent.map(decodeRing) : null;
    return Object.assign({}, L, { features, staleRings: stale });
  }
  function preparePack(pack, feeds) {
    const proj = PROJ[pack.projection];
    if (!proj) throw new Error(`Unknown projection ${pack.projection}`);
    const baseLayers = new Map();
    for (const L of pack.layers) baseLayers.set(L.id, prepareLayer(L));
    const pk = { province: pack.province, projection: pack.projection, built: pack.built, version: pack.version, maxAgeDays: pack.max_age_days || DEFAULT_MAX_AGE_DAYS,
      proj, baseLayers, baseRules: pack.rules, liveDecl: pack.live || [], liveFeeds: new Map(), regions: new Map() };
    for (const f of feeds || []) acceptFeed(pk, f);
    applyLive(pk);
    return pk;
  }
  function acceptFeed(pk, f) { // only a feed this pack declares, for this province and projection
    if (!f || f.province !== pk.province || f.projection !== pk.projection || !pk.liveDecl.some(d => d.id === f.feed)) return false;
    const ver = String(f.version || '') + '@' + String(f.built || '');
    pk.liveFeeds.set(f.feed, { raw: f, layers: f.layers.map(L => Object.assign(prepareLayer(L), { ver })) });
    return true;
  }
  function applyLive(pk) {
    const layers = new Map(pk.baseLayers), rules = pk.baseRules.slice(), feeds = {};
    // Downrange regions (Pro tiles of buildings, roads, trails, property lines): the same layer id in several tiles is one layer.
    // (pieces gathered per id and joined once, in region order: the same layer as concatenating tile by tile)
    const pieces = new Map();
    for (const reg of pk.regions.values()) for (const L of reg.layers) {
      const cur = pieces.get(L.id);
      if (cur && cur.first.features) { if (L.features) cur.parts.push(L.features); }
      else pieces.set(L.id, { first: L, parts: L.features ? [L.features] : [] });
    }
    for (const [id, p] of pieces) layers.set(id, Object.assign({}, p.first, { fromRegion: true }, p.first.features ? { features: p.parts.length === 1 ? p.parts[0] : [].concat(...p.parts) } : {}));
    for (const d of pk.liveDecl) {
      const f = pk.liveFeeds.get(d.id); if (!f) continue;
      for (const L of f.layers) layers.set(L.id, L);
      rules.push(...f.raw.rules);
      feeds[d.id] = { built: f.raw.built, version: f.raw.version, maxAgeHours: Math.min(d.max_age_hours, f.raw.max_age_hours || d.max_age_hours) };
    }
    pk.layers = layers; pk.rules = rules; pk.feeds = feeds;
  }
  // Add (or replace) a downrange region tile: { province, projection, region, version, built, bbox:[x0,y0,x1,y1], layers }.
  function addRegion(D, region) {
    const pk = region && D.packs[region.province];
    if (!pk || region.projection !== pk.projection || !region.region || !Array.isArray(region.bbox)) return false;
    pk.regions.set(region.region, { raw: region, bbox: region.bbox, layers: region.layers.map(prepareLayer) });
    applyLive(pk); return true;
  }
  // Swap in a newer live feed (the page fetches fire orders every few hours) without re-preparing the whole pack.
  function setLive(D, feed) {
    const pk = feed && D.packs[feed.province];
    if (!pk || !acceptFeed(pk, feed)) return false;
    applyLive(pk); return true;
  }
  function provinceAt(D, lon, lat) {
    for (const p of D.provinces) if (inBox(p.bb, lon, lat, 0) && inRings(p.rings, lon, lat)) return p.id;
    return null;
  }

  // ---------- inputs ----------
  // firearm: { class: 'non_restricted'|'restricted'|'prohibited', kind: 'rifle'|'shotgun'|'handgun'|'muzzleloader'|'airgun'|'bow',
  //            projectile: 'shot'|'single', power: 'high'|'low' (air guns) }  → tags matched against rule.applies_to.firearms
  // Air guns: always 'airgun' (BC Wildlife Act s.1 counts any compressed-gas or spring gun as a firearm, so BC closed areas
  // list 'airgun'); plus 'airgun_high' when over both federal thresholds (500 fps / 152.4 m/s and 5.7 J), for rules that
  // follow the Firearms Act / Criminal Code definition. Bows are never firearms under the Wildlife Act.
  function firearmTags(fa) {
    const f = Object.assign({ class: 'non_restricted', kind: 'rifle' }, fa || {});
    const t = new Set(['any']);
    if (f.kind === 'airgun') { t.add('airgun'); if (f.power === 'high') t.add('airgun_high'); return t; }
    if (f.kind === 'bow' || f.kind === 'crossbow') { t.add('bow'); if (f.kind === 'crossbow') t.add('crossbow'); return t; } // a rule listing 'bow' covers crossbows too
    t.add('firearm'); t.add(f.kind); t.add(f.class);
    const proj = f.projectile || (f.kind === 'shotgun' ? 'shot' : 'single');
    t.add(proj === 'shot' ? 'shot' : 'single_projectile');
    return t;
  }
  const mmdd = (d) => String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  function inWindow(md, from, to) { return from <= to ? md >= from && md <= to : md >= from || md <= to; }

  // ---------- rule matching ----------
  // rule.where: { everywhere:true } | { layer, features?, inside:true } | { layer, features?, within_m } | { layer, features?, outside:true, within_layer?, within_features? }
  function hit(pk, where, x, y) {
    if (where.everywhere) return { ok: true };
    const L = pk.layers.get(where.layer);
    if (!L) return { missing: where.layer };
    if (!L.features) return { unloaded: where.layer };
    const pad = where.within_m || 0;
    let inside = null, near = null;
    const feats = L.features, list = where.features ? byWhere(feats, where) : candidates(feats, x - pad, y - pad, x + pad, y + pad);
    for (let k = 0, n = list ? list.length : feats.length; k < n; k++) {
      const f = feats[list ? list[k] : k];
      if (!inBox(f.bb, x, y, pad)) continue;
      if (f.closed && inRings(f.parts, x, y)) { inside = f; break; }
      if (pad) { const d = distToParts(f.parts, x, y, f.closed); if (d <= pad && (!near || d < near.d)) near = { f, d }; }
    }
    if (where.outside) { // "shooting only inside mapped zones" (e.g. a bylaw's permitted areas): hit = inside the jurisdiction but outside every zone
      if (inside) return { ok: false };
      if (where.within_layer) { const w = hit(pk, { layer: where.within_layer, features: where.within_features, inside: true }, x, y); return w.ok ? { ok: true, feature: w.feature } : w; }
      return { ok: true };
    }
    if (inside) return { ok: true, feature: inside, d: 0 };
    if (near) return { ok: true, feature: near.f, d: near.d };
    return { ok: false };
  }

  // day / md: ymd(when) and mmdd(when), passed in by callers that check many rules for one moment
  function ruleApplies(rule, tags, when, activity, day, md) {
    const a = rule.applies_to || {};
    const acts = a.activities || ['target_shooting'];
    if (!acts.includes(activity)) return false;
    const fs = a.firearms || ['firearm'];
    let any = false; for (const f of fs) if (tags.has(f)) { any = true; break; }
    if (!any) return false;
    const c = rule.conditions;
    if (!c) return true;
    if (c.valid_from || c.valid_to) {
      const d = day || ymd(when);
      if (c.valid_from && d < c.valid_from) return false;
      if (c.valid_to && d > c.valid_to) return false;
    }
    if (c.season && !inWindow(md || mmdd(when), c.season.from, c.season.to)) return false;
    return true;
  }
  // The rules that apply for one firearm, moment and activity (the same for every point of one answer).
  function applicable(pk, tags, when, activity) {
    const day = ymd(when), md = mmdd(when);
    return pk.rules.filter(rule => ruleApplies(rule, tags, when, activity, day, md));
  }
  // A date the data carries that can't be read is treated as too old: the answer says so instead of skipping the check.
  const ageOf = (when, iso, unit) => { const t = Date.parse(iso); return Number.isFinite(t) ? (when - t) / unit : Infinity; };

  function cite(rule, L) {
    return { rule: rule.id, title: rule.title, instrument: rule.citation && rule.citation.instrument, section: rule.citation && rule.citation.section,
      url: rule.citation && rule.citation.url, layer: L ? L.id : null, data_as_of: (rule.data && rule.data.data_as_of) || (L && L.data_as_of) || null };
  }

  // Unmappable conditions: settled only when a resolver layer is loaded (BC Pro parcels), else NOT CONFIRMED.
  function unmapped(pk, rule, x, y) {
    const out = [];
    for (const u of (rule.conditions && rule.conditions.unmapped) || []) {
      if (u.kind === 'lot_size_min_ha') {
        const parcels = pk.layers.get('parcels');
        if (parcels && parcels.features) {
          const p = containing(parcels.features, x, y);
          if (p && typeof p.area_ha === 'number') { if (p.area_ha >= u.value) { out.push({ resolved: 'clear' }); continue; } out.push({ resolved: 'prohibited', why: `Parcel is ${p.area_ha} ha, under the ${u.value} ha minimum` }); continue; }
        }
        out.push({ why: `Only you can confirm the lot is at least ${u.value} ha` });
      } else if (u.kind === 'dwelling_setback') out.push({ why: `Only you can confirm you're at least ${u.distance_m} m from any dwelling` });
      else out.push({ why: u.note || 'A condition the maps can\'t settle' });
    }
    return out;
  }

  // ---------- evaluation at one projected point ----------
  // rules: applicable(pk, tags, when, activity), worked out once per answer
  function checkPoint(pk, x, y, rules) {
    const checks = [];
    for (const rule of rules) {
      const L = rule.where.layer ? pk.layers.get(rule.where.layer) : null;
      const h = hit(pk, rule.where, x, y);
      if (h.missing || h.unloaded) {
        checks.push({ status: 'unconfirmed', key: 'layer', why: h.missing ? `Layer "${h.missing}" isn't in this build` : `${L ? L.title : h.unloaded} isn't loaded on this phone`, cite: cite(rule, L) });
        continue;
      }
      if (!h.ok) continue;
      if (rule.status === 'stale') { checks.push({ status: 'unconfirmed', key: 'stale', why: 'The source changed and is being re-verified', cite: cite(rule, L) }); continue; }
      let status = rule.effect === 'prohibited' ? 'prohibited' : rule.effect === 'unconfirmed' ? 'unconfirmed' : 'condition';
      let why = rule.summary;
      if (status === 'prohibited') {
        const u = unmapped(pk, rule, x, y);
        if (u.some(v => v.resolved === 'clear')) continue; // a mapped condition shows the rule doesn't reach this spot
        if (u.some(v => !v.resolved)) { status = 'unconfirmed'; why = `${rule.summary} ${u.filter(v => !v.resolved).map(v => v.why).join('; ')}.`; }
      }
      checks.push({ status, key: rule.kind, why, d: h.d, feature: h.feature ? (h.feature.name || h.feature.id) : null, exceptions: rule.exceptions || [], cite: cite(rule, L) });
    }
    // Layer health: required layers must be present, loaded and (where the point falls in a stale extent) re-verified.
    for (const L of pk.layers.values()) {
      if (!L.required) continue;
      if (!L.features) checks.push({ status: 'unconfirmed', key: 'layer', why: `${L.title} isn't loaded on this phone`, cite: { layer: L.id, data_as_of: L.data_as_of } });
      else if (L.status === 'stale' && (!L.staleRings || inRings(L.staleRings, x, y))) checks.push({ status: 'unconfirmed', key: 'stale', why: `${L.title}: the source changed and is being re-verified`, cite: { layer: L.id, data_as_of: L.data_as_of } });
    }
    // Local bylaw coverage: a point inside a jurisdiction we haven't researched or verified is NOT CONFIRMED.
    const J = pk.layers.get('jurisdictions');
    if (J && J.features) {
      const j = containing(J.features, x, y);
      if (j && j.coverage !== 'verified') checks.push({ status: 'unconfirmed', key: 'bylaw_coverage', feature: j.name, cite: { layer: 'jurisdictions', data_as_of: J.data_as_of },
        why: j.coverage === 'map_pending' ? `${j.name}'s bylaw sets where shooting is allowed on a map that isn't in Shootable yet`
          : j.coverage === 'stale' ? `${j.name}'s bylaw changed since it was checked and is being re-verified` : `Local bylaws for ${j.name} aren't verified yet` });
    }
    return checks;
  }

  // ---------- mapped buildings near the spot (downrange region tiles, when loaded) ----------
  // A condition rule with conditions.building_check_m (BC Sch 3 item 19: 100 m from dwellings and occupied buildings)
  // is checked against the mapped buildings: one within that distance (plus the GPS accuracy) makes the answer
  // NOT CONFIRMED, because only the person can tell a dwelling from a shed. None within it keeps the condition (maps
  // miss buildings, so an empty map never clears anything). Without tiles covering the circle nothing changes.
  // Answer-only: map shading and whereToGo (stateAt) don't look at buildings.
  // lon/lat of a projected point near (lon0, lat0): Newton steps on the forward projection (sub-centimetre within a few km)
  function unproject(pk, lon0, lat0, X, Y) {
    let lon = lon0, lat = lat0;
    for (let i = 0; i < 6; i++) {
      const [x, y] = pk.proj(lon, lat), e = 1e-5, [x1, y1] = pk.proj(lon + e, lat), [x2, y2] = pk.proj(lon, lat + e);
      const a = (x1 - x) / e, b = (x2 - x) / e, c = (y1 - y) / e, d = (y2 - y) / e, det = a * d - b * c, ex = X - x, ey = Y - y;
      lon += (d * ex - b * ey) / det; lat += (-c * ex + a * ey) / det;
      if (Math.abs(ex) + Math.abs(ey) < 0.01) break;
    }
    return [+lon.toFixed(7), +lat.toFixed(7)];
  }
  const DIRS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
  function nearestBuilding(pk, lon, lat, x, y, R) {
    const tiles = [...pk.regions.values()];
    if (!tiles.length) return { covered: false };
    const ring = [[x, y]]; for (let k = 0; k < 8; k++) ring.push([x + R * Math.cos(k * Math.PI / 4), y + R * Math.sin(k * Math.PI / 4)]);
    const layers = [...pk.layers.values()].filter(L => L.downrange === 'building' && L.features);
    if (!layers.length || !ring.every(([px, py]) => tiles.some(t => inBox(t.bbox, px, py, 0)))) return { covered: false };
    let best = null;
    for (const L of layers) {
      const feats = L.features, list = candidates(feats, x - R, y - R, x + R, y + R);
      for (let k = 0, n = list ? list.length : feats.length; k < n; k++) {
        const f = feats[list ? list[k] : k];
        if (!inBox(f.bb, x, y, R)) continue;
        const d = f.closed && inRings(f.parts, x, y) ? 0 : distToParts(f.parts, x, y, f.closed);
        if (d <= R && (!best || d < best.d)) best = { d, f, L };
      }
    }
    if (!best) return { covered: true, nearest: null, layer: layers[0] };
    // true bearing to the building's centre: grid north differs from true north by a few degrees in BC Albers / AB 10-TM
    const [nx, ny] = pk.proj(lon, lat + 0.001), north = Math.atan2(nx - x, ny - y);
    const bb = best.f.bb, g = Math.atan2((bb[0] + bb[2]) / 2 - x, (bb[1] + bb[3]) / 2 - y);
    const deg = ((g - north) / D2R + 360) % 360;
    // its outline in lon/lat for the page to draw (first part, at most 200 points)
    const outline = (best.f.parts[0] || []).slice(0, 200).map(([px, py]) => unproject(pk, lon, lat, px, py));
    return { covered: true, nearest: { d: Math.round(best.d), bearing_deg: Math.round(deg), dir: DIRS[Math.round(deg / 45) % 8], id: best.f.id, ring: outline }, layer: best.L };
  }
  function buildingCheck(pk, lon, lat, x, y, rules, checks, acc) {
    let out = null;
    for (const rule of rules) {
      const m = rule.conditions && rule.conditions.building_check_m; if (!m) continue;
      const c = checks.find(k => k.cite && k.cite.rule === rule.id && k.status === 'condition'); if (!c) continue;
      const nb = nearestBuilding(pk, lon, lat, x, y, m + acc);
      out = { rule: rule.id, distance_m: m, covered: nb.covered, nearest: nb.nearest || null };
      if (!nb.covered) continue;
      const L = nb.layer;
      if (nb.nearest) {
        const n = nb.nearest, where = n.d === 0 ? "You're inside a mapped building's outline" : `A mapped building is about ${n.d} m ${n.dir} of this spot`;
        Object.assign(c, { status: 'unconfirmed', key: 'building_near', d: n.d,
          why: `${where}${n.d > m ? ` (within ${m} m allowing for your GPS accuracy)` : ''}. ${rule.summary} Only you can confirm what the building is.`,
          cite: Object.assign({}, c.cite, { layer: L.id, data_as_of: L.data_as_of }) });
      } else c.why = `${rule.summary} No building is mapped within ${m} m, but maps miss some.`;
    }
    return out;
  }

  const rank = { prohibited: 2, unconfirmed: 1, clear: 0 };
  function stateOf(checks) {
    if (checks.some(c => c.status === 'prohibited')) return 'prohibited';
    if (checks.some(c => c.status === 'unconfirmed')) return 'unconfirmed';
    return 'clear';
  }

  // ---------- public: evaluate a spot ----------
  // q: { lon, lat, accuracy_m?, firearm?, when?: Date, activity?: 'target_shooting' }
  function evaluate(D, q) {
    const when = q.when || new Date(), activity = q.activity || 'target_shooting', tags = firearmTags(q.firearm);
    const prov = provinceAt(D, q.lon, q.lat);
    const base = { engine: ENGINE_VERSION, at: when.toISOString(), lon: q.lon, lat: q.lat, province: prov };
    if (!prov) return finish(Object.assign(base, { checks: [{ status: 'unconfirmed', key: 'outside', why: 'Shootable covers BC and Alberta only' }] }));
    const pk = D.packs[prov];
    if (!pk) return finish(Object.assign(base, { checks: [{ status: 'unconfirmed', key: 'pack', why: `${prov === 'AB' ? 'Alberta' : 'BC'} rules aren't available right now. The other province is unaffected.` }] }));
    const [x, y] = pk.proj(q.lon, q.lat);
    const rules = applicable(pk, tags, when, activity);
    const checks = checkPoint(pk, x, y, rules);
    const buildings = buildingCheck(pk, q.lon, q.lat, x, y, rules, checks, Math.max(0, q.accuracy_m || 0));
    const ageDays = ageOf(when, pk.built, 864e5);
    if (!(ageDays <= pk.maxAgeDays)) checks.push({ status: 'unconfirmed', key: 'data_age', why: Number.isFinite(ageDays) ? `Rule data is ${Math.floor(ageDays)} days old. Update it with signal before relying on it.` : 'The rule data has no readable build date. Update it with signal before relying on it.', cite: { data_as_of: String(pk.built || '').slice(0, 10) || null } });
    // Live feeds (fire orders): a required feed that's missing or too old can't be assumed clear.
    for (const d of pk.liveDecl) {
      if (d.required === false) continue;
      const f = pk.feeds[d.id];
      if (!f) { checks.push({ status: 'unconfirmed', key: 'live', why: `${d.title} haven't been downloaded yet. Get signal once to check them.`, cite: { layer: d.id, data_as_of: null } }); continue; }
      const h = ageOf(when, f.built, 36e5);
      if (!(h <= f.maxAgeHours)) checks.push({ status: 'unconfirmed', key: 'live', why: Number.isFinite(h) ? `${d.title} were last updated ${h < 48 ? Math.floor(h) + ' hours' : Math.floor(h / 24) + ' days'} ago. Get signal to update them.` : `${d.title} have no readable update time. Get signal to update them.`, cite: { layer: d.id, data_as_of: String(f.built || '').slice(0, 10) || null } });
    }

    // Boundary uncertainty: a ring at the GPS accuracy. Prohibited on the ring but not at the centre → NOT CONFIRMED.
    const r = Math.max(0, q.accuracy_m || 0);
    if (r > 0 && stateOf(checks) !== 'prohibited') {
      for (let k = 0; k < RING_POINTS; k++) {
        const a = 2 * Math.PI * k / RING_POINTS, rc = checkPoint(pk, x + r * Math.cos(a), y + r * Math.sin(a), rules);
        const near = rc.find(c => c.status === 'prohibited') || (!checks.some(c => c.key === 'bylaw_coverage') && rc.find(c => c.key === 'bylaw_coverage'));
        if (near) { checks.push({ status: 'unconfirmed', key: 'edge', why: `Within ${Math.round(r)} m (your GPS accuracy) of: ${near.why}`, cite: near.cite }); break; }
      }
    }
    const rulesChecked = rules.map(rl => rl.id);
    const layers = [...pk.layers.values()].map(L => ({ id: L.id, title: L.title, data_as_of: L.data_as_of, status: L.features ? (L.status || 'verified') : 'not_loaded' }));
    // the municipality or electoral area the spot is in (name and kind only), for the page's prompts; null when unknown
    const JL = pk.layers.get('jurisdictions'), jf = JL && JL.features ? containing(JL.features, x, y) : null;
    const jurisdiction = jf ? { name: jf.name || null, kind: jf.kind || null } : null;
    return finish(Object.assign(base, { checks, x, y, rulesChecked, layers, jurisdiction, buildings, pack: { version: pk.version, built: pk.built }, live: pk.feeds }));
  }

  function finish(ans) {
    const state = stateOf(ans.checks);
    ans.checks.sort((a, b) => (rank[b.status] || 0) - (rank[a.status] || 0));
    const sources = new Map();
    for (const c of ans.checks) if (c.cite && c.cite.layer) sources.set(c.cite.layer, c.cite.data_as_of);
    return Object.assign(ans, {
      state, label: STATE[state],
      conditions: ans.checks.filter(c => c.status === 'condition').map(c => c.why),
      sources: [...sources].map(([layer, data_as_of]) => ({ layer, data_as_of })),
    });
  }

  // ---------- downrange check (Pro): what's mapped in the line of fire, out to the danger distance ----------
  // q: { lon, lat, bearing_deg (true north), arc_deg (whole width, default 20), cartridge (cartridges.json entry) or
  //      distance_m, elevation_m? (GPS altitude; else the pack's spot elevations; else 1500 m, the long side) }
  // Every layer with a `downrange` role is scanned: region tiles (buildings, roads, trails, property lines, rail) and the
  // pack's own areas (parks, closed areas, reserves, recreation sites). A feature counts when any part of it lies inside the
  // wedge; its distance is the nearest such part. Inside a polygon (a park you're standing in) is 0 m.
  // Elevation at a projected point from the pack's spot elevations: the highest within 6 km (spot heights sit on rises,
  // and higher means thinner air and a longer range, so this errs long), else the nearest within 25 km, else null.
  function elevationAt(pk, x, y) {
    const L = pk.layers.get('elevation'); if (!L || !L.grid) return null;
    const C = L.cell, cx = Math.floor(x / C), cy = Math.floor(y / C);
    let best = null, near = null;
    for (let i = -3; i <= 3; i++) for (let j = -3; j <= 3; j++) {
      const a = L.grid.get((cx + i) + ',' + (cy + j)); if (!a) continue;
      for (let k = 0; k < a.length; k += 3) { const d = Math.hypot(a[k] - x, a[k + 1] - y);
        if (d <= 6000 && (best === null || a[k + 2] > best)) best = a[k + 2];
        if (d <= 25000 && (!near || d < near.d)) near = { d, z: a[k + 2] }; }
    }
    return best !== null ? best : near ? near.z : null;
  }
  // A cartridge's danger distance at an elevation: its maximum range interpolated from range_by_elevation_m, rounded up
  // to round_m (100 m; 50 m for shot and arrows). Same rule as scripts/cartridges/build_cartridges.py.
  function dangerDistance(cart, elevation_m) {
    const t = cart && cart.range_by_elevation_m; if (!t || !t.length) return cart && cart.danger_distance_m || null;
    const e = Math.max(t[0][0], Math.min(t[t.length - 1][0], elevation_m || 0)); let r = t[t.length - 1][1];
    for (let i = 1; i < t.length; i++) if (e <= t[i][0]) { r = t[i - 1][1] + (t[i][1] - t[i - 1][1]) * (e - t[i - 1][0]) / (t[i][0] - t[i - 1][0]); break; }
    const step = cart.round_m || 100; return Math.ceil(r / step - 1e-9) * step;
  }
  const DR_ORDER = ['building', 'road', 'trail', 'rail', 'property_line', 'park', 'closed_area', 'reserve', 'rec_site'];
  function downrange(D, q) {
    const prov = provinceAt(D, q.lon, q.lat), pk = prov && D.packs[prov];
    if (!pk) return { ok: false, why: prov ? 'Rules for this province aren\'t loaded' : 'Shootable covers BC and Alberta only' };
    const [ox, oy] = pk.proj(q.lon, q.lat);
    let elev = Number.isFinite(q.elevation_m) ? q.elevation_m : null, elevSrc = elev !== null ? 'gps' : null;
    if (elev === null) { elev = elevationAt(pk, ox, oy); elevSrc = elev !== null ? 'spot_heights' : null; }
    if (elev === null) { elev = 1500; elevSrc = 'assumed'; }
    const R = q.cartridge ? dangerDistance(q.cartridge, elev) : q.distance_m, arc = Math.max(2, Math.min(180, q.arc_deg || 20)), half = arc / 2 * D2R;
    if (!(R > 0)) return { ok: false, why: 'Pick a firearm and cartridge first' };
    // grid bearing: project a point a short way along the true bearing (Albers and 10-TM north isn't true north)
    const b = (q.bearing_deg || 0) * D2R, step = 0.002;
    const [tx, ty] = pk.proj(q.lon + Math.sin(b) * step / Math.cos(q.lat * D2R), q.lat + Math.cos(b) * step);
    const th = Math.atan2(tx - ox, ty - oy), ux = Math.sin(th), uy = Math.cos(th), tanH = Math.tan(Math.min(half, 89 * D2R));
    // sector bbox, and whether downloaded region tiles cover it
    const pts = [[ox, oy]];
    for (let k = 0; k <= 8; k++) { const a = th - half + 2 * half * k / 8; pts.push([ox + R * Math.sin(a), oy + R * Math.cos(a)], [ox + R / 2 * Math.sin(a), oy + R / 2 * Math.cos(a)]); }
    const sb = bboxOf([pts]);
    const tiles = [...pk.regions.values()];
    const covered = pts.every(([x, y]) => tiles.some(t => inBox(t.bbox, x, y, 0)));
    // the t-interval of segment A→B inside the wedge (local coords, origin at the shooter), then the nearest point in it
    const segIn = (ax, ay, bx, by) => {
      let t0 = 0, t1 = 1;
      const clip = (c0, c1) => { // keep c0 + (c1 - c0) t >= 0
        if (c0 < 0 && c1 < 0) return false;
        if (c0 >= 0 && c1 >= 0) return true;
        const t = c0 / (c0 - c1); if (c0 < 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t); return t0 <= t1;
      };
      const dot = (x, y) => x * ux + y * uy, crs = (x, y) => ux * y - uy * x; // crs > 0: left of the line of fire
      if (!clip(dot(ax, ay), dot(bx, by))) return Infinity;
      if (!clip(tanH * dot(ax, ay) - crs(ax, ay), tanH * dot(bx, by) - crs(bx, by))) return Infinity;
      if (!clip(tanH * dot(ax, ay) + crs(ax, ay), tanH * dot(bx, by) + crs(bx, by))) return Infinity;
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      let t = l2 ? -(ax * dx + ay * dy) / l2 : 0; t = Math.max(t0, Math.min(t1, t));
      return Math.hypot(ax + t * dx, ay + t * dy);
    };
    const items = [], used = [];
    for (const L of pk.layers.values()) {
      if (!L.downrange || !L.features) continue;
      used.push({ id: L.id, title: L.title, data_as_of: L.data_as_of, role: L.downrange });
      const asLines = L.downrange === 'property_line';
      for (const f of nearby(L.features, sb[0], sb[1], sb[2], sb[3])) {
        if (f.bb[2] < sb[0] || f.bb[0] > sb[2] || f.bb[3] < sb[1] || f.bb[1] > sb[3]) continue;
        let d = Infinity;
        if (f.closed && !asLines && inBox(f.bb, ox, oy, 0) && inRings(f.parts, ox, oy)) d = 0;
        else for (const p of f.parts) {
          const n = p.length, last = f.closed ? n : n - 1;
          for (let i = 0; i < last; i++) { const a = p[i], c = p[(i + 1) % n]; const v = segIn(a[0] - ox, a[1] - oy, c[0] - ox, c[1] - oy); if (v < d) d = v; }
          if (p.length === 1) { const v = segIn(p[0][0] - ox, p[0][1] - oy, p[0][0] - ox, p[0][1] - oy); if (v < d) d = v; }
        }
        if (d <= R) items.push({ role: L.downrange, layer: L.id, id: f.id, name: f.name || null, d: Math.round(d) });
      }
    }
    items.sort((a, b) => a.d - b.d);
    // a road or parcel cut at a tile edge appears in both tiles under one id: keep its nearest piece
    const seen = new Set();
    const kept = items.filter(it => { const k = it.layer + '|' + it.id; if (seen.has(k)) return false; seen.add(k); return true; }); items.length = 0; items.push(...kept);
    const byRole = {};
    for (const it of items) (byRole[it.role] = byRole[it.role] || { count: 0, nearest_m: it.d }).count++;
    const roles = Object.keys(byRole).sort((a, b) => DR_ORDER.indexOf(a) - DR_ORDER.indexOf(b));
    return { ok: true, province: prov, lon: q.lon, lat: q.lat, bearing_deg: q.bearing_deg || 0, arc_deg: arc, distance_m: R, elevation_m: Math.round(elev), elevation_source: elevSrc,
      covered, items, by_role: roles.map(r => Object.assign({ role: r }, byRole[r])), layers: used,
      note: covered ? 'Mapped features only. Confirm your target and what\'s beyond it.'
        : 'Part of the arc is outside the downloaded downrange data, so features there aren\'t listed. Mapped features only. Confirm your target and what\'s beyond it.' };
  }

  // The state at one projected point for rules worked out once (applicable): the per-point part of evaluate, for
  // callers that check many points for one firearm and moment (field.js whereToGo). Whole-province checks (data age,
  // live feeds) are not in it: the caller reads those from one evaluate.
  function stateAt(pk, x, y, rules) { return stateOf(checkPoint(pk, x, y, rules)); }

  const api = { ENGINE_VERSION, STATE, ruleApplies, applicable, stateAt, prepare, setLive, addRegion, downrange, dangerDistance, evaluate, provinceAt, firearmTags, project: (code, lon, lat) => PROJ[code](lon, lat), decodeRing, encodeRing, inRings, distToParts };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Shootable = api;
})(typeof self !== 'undefined' ? self : this);
