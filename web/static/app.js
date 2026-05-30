"use strict";

const Q = new URLSearchParams(location.search);
let pendingTime = Q.get("time");          // optional deep-link start time
let pendingSuggest = Q.get("suggest") === "1";
const canvas = document.getElementById("map");
const ctx = canvas.getContext("2d");
const fxCanvas = document.getElementById("windFx");
const fxCtx = fxCanvas ? fxCanvas.getContext("2d", { alpha: true }) : null;
const MONO = "ui-monospace,Menlo,Consolas,monospace";
const SANS = "-apple-system,Segoe UI,Roboto,sans-serif";

// ------------- app state -------------
const S = {
  date: Q.get("date") || "2025-07-08",
  flight: Q.get("flight") || "SWA3209",
  meta: null,        // /api/flight
  state: null,       // /api/state
  reroutes: null,    // /api/reroutes  (null until "Suggest" pressed)
  selected: null,    // selected reroute index
  rerouteFrac: null, // frac at which reroutes were evaluated (plane follows the
  // selected route past this point)
  committedPath: null, // actual flown polyline up to rerouteFrac (filed + any
  // earlier accepted reroutes); null = filed route
  frac: 0,           // scrub position 0..1
  view: null,        // [w,e,s,n]
  wx: null,          // weather Image
  states: null, cities: [],
  dpr: 1,
  landing: null,     // /api/landing destination METAR
  winds: null,       // /api/winds station vectors
  windsOn: false,    // wind streamlines toggle
  sectors: null,     // /api/sectors HIGH-band polygons
  sectorsOn: false,  // sector polygons layer toggle
  weatherOn: true,   // NEXRAD radar layer toggle (on by default)
};

// ------------- wind streamlines (animated overlay canvas) -------------
const WIND_FX = {
  particles: [],
  field: null,
  raf: null,
  lastView: null,
};
const PARTICLES_N = 1800;
const TRAIL_FADE = 0.965;
const SPEED_SCALE = 0.016;
const PARTICLE_LIFE = 140;

// ------------- geometry (client-side plane interpolation) -------------
function hav(lat1, lon1, lat2, lon2) {
  const R = 3440.065, r = Math.PI / 180;
  const dphi = (lat2 - lat1) * r, dl = (lon2 - lon1) * r;
  const a = Math.sin(dphi / 2) ** 2 +
        Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function lineLen(coords) {
  let d = 0;
  for (let i = 0; i < coords.length - 1; i++)
    d += hav(coords[i][0], coords[i][1], coords[i + 1][0], coords[i + 1][1]);
  return d;
}
// returns {lat,lon,hdgCompass, flown:[[lat,lon]...], remaining:[...]}
function splitAt(coords, frac) {
  frac = Math.max(0, Math.min(1, frac));
  const cum = [0];
  for (let i = 0; i < coords.length - 1; i++)
    cum.push(cum[i] + hav(coords[i][0], coords[i][1], coords[i + 1][0], coords[i + 1][1]));
  const total = cum[cum.length - 1];
  if (total <= 0) return { lat: coords[0][0], lon: coords[0][1], hdg: 0,
                           flown: [coords[0]], remaining: coords.slice() };
  const target = frac * total;
  let seg = 0;
  while (seg < cum.length - 2 && cum[seg + 1] < target) seg++;
  const segLen = cum[seg + 1] - cum[seg];
  const t = segLen > 0 ? (target - cum[seg]) / segLen : 0;
  const lat = coords[seg][0] + t * (coords[seg + 1][0] - coords[seg][0]);
  const lon = coords[seg][1] + t * (coords[seg + 1][1] - coords[seg][1]);
  const dispHdg = Math.atan2(coords[seg + 1][0] - coords[seg][0],
                             coords[seg + 1][1] - coords[seg][1]) * 180 / Math.PI;
  const compass = (90 - dispHdg + 360) % 360;
  return {
    lat, lon, hdg: compass,
    flown: coords.slice(0, seg + 1).concat([[lat, lon]]),
    remaining: [[lat, lon]].concat(coords.slice(seg + 1)),
  };
}
// Plane split that follows the selected reroute. Before the reroute-decision
// point (S.rerouteFrac) the aircraft is on the filed route; after it, it tracks
// the selected alternative, with the remaining flight time mapped along it.
function activeSplit(frac) {
  const selR = (S.reroutes && S.selected != null && S.rerouteFrac != null)
        ? S.reroutes.reroutes[S.selected] : null;
  if (!selR) return splitAt(S.meta.filed, frac);
  const df = S.rerouteFrac;
  // Path actually flown up to the decision point: the committed trajectory if we
  // have already accepted a reroute, else the filed route up to df.
  const committed = S.committedPath || splitAt(S.meta.filed, df).flown;
  if (frac <= df) {                                       // before the decision: on the committed path
    const sp = splitAt(committed, df > 0 ? frac / df : 1);
    return { lat: sp.lat, lon: sp.lon, hdg: sp.hdg, flown: sp.flown,
             remaining: sp.remaining.slice(0, -1).concat(selR.coords) };
  }
  const rsp = splitAt(selR.coords, (frac - df) / Math.max(1e-6, 1 - df));
  return { lat: rsp.lat, lon: rsp.lon, hdg: rsp.hdg,
           flown: committed.slice(0, -1).concat(rsp.flown),
           remaining: rsp.remaining };
}

// ------------- projection / view -------------
function fitView(ext, W, H) {
  let [w, e, s, n] = ext;
  const target = W / H;
  const dlon = e - w, dlat = n - s;
  if (dlon / dlat < target) {
    const nd = dlat * target, c = (w + e) / 2; w = c - nd / 2; e = c + nd / 2;
  } else {
    const nd = dlon / target, c = (s + n) / 2; s = c - nd / 2; n = c + nd / 2;
  }
  return [w, e, s, n];
}
function proj(lat, lon) {
  const [w, e, s, n] = S.view, W = canvas.width, H = canvas.height;
  return [(lon - w) / (e - w) * W, (n - lat) / (n - s) * H];
}
function unproj(px, py) {
  const [w, e, s, n] = S.view, W = canvas.width, H = canvas.height;
  return [n - (py / H) * (n - s), w + (px / W) * (e - w)];
}

function resize() {
  S.dpr = window.devicePixelRatio || 1;
  canvas.width = innerWidth * S.dpr;
  canvas.height = innerHeight * S.dpr;
  canvas.style.width = innerWidth + "px";
  canvas.style.height = innerHeight + "px";
  if (fxCanvas) {
    fxCanvas.width = canvas.width;
    fxCanvas.height = canvas.height;
    fxCanvas.style.width = innerWidth + "px";
    fxCanvas.style.height = innerHeight + "px";
    if (fxCtx) {
      fxCtx.setTransform(1, 0, 0, 1, 0, 0);
      fxCtx.clearRect(0, 0, fxCanvas.width, fxCanvas.height);
    }
    if (S.windsOn) restartParticles();
  }
  draw();
}

// ------------- drawing -------------
function drawPlane(x, y, size, bearing, fill, glow) {
  ctx.save(); ctx.translate(x, y); ctx.rotate((bearing || 0) * Math.PI / 180);
  ctx.beginPath();
  ctx.moveTo(0, -size); ctx.lineTo(size * 0.62, size * 0.7);
  ctx.lineTo(0, size * 0.32); ctx.lineTo(-size * 0.62, size * 0.7); ctx.closePath();
  if (glow) { ctx.shadowColor = fill; ctx.shadowBlur = 12 * S.dpr; }
  ctx.fillStyle = fill; ctx.fill(); ctx.restore();
}
function strokeCoords(coords) {
  ctx.beginPath();
  coords.forEach((c, i) => { const [x, y] = proj(c[0], c[1]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.stroke();
}
function drawGeom(geom) {
  const polys = geom.type === "Polygon" ? [geom.coordinates] : geom.coordinates;
  for (const poly of polys) for (const ring of poly) {
    ctx.beginPath();
    ring.forEach((pt, i) => { const [x, y] = proj(pt[1], pt[0]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.stroke();
  }
}
function diamond(x, y, s, color) {
  ctx.save(); ctx.translate(x, y); ctx.rotate(Math.PI / 4);
  ctx.strokeStyle = color; ctx.lineWidth = 2 * S.dpr;
  ctx.strokeRect(-s, -s, 2 * s, 2 * s); ctx.restore();
}
function centroid(ring) { let a = 0, b = 0; for (const p of ring) { a += p[0]; b += p[1]; } return [a / ring.length, b / ring.length]; }

// Reroute line style by category. recommended = green solid, rejected
// (enters an over-demand sector) = red dashed, viable alternate = blue dotted.
function routeStyle(r) {
  if (r.recommended) return { color: "rgba(46,210,170,.9)", dash: [], w: 2.4 };
  if (r.entersOverload) return { color: "rgba(225,80,80,.7)", dash: [4, 4], w: 1.5 };
  return { color: "rgba(110,150,200,.75)", dash: [2, 6], w: 1.5 };
}
// Opaque variant for the selected-route glow/highlight + destination marker.
function routeGlow(r) {
  if (r.recommended) return "#2ee2aa";
  if (r.entersOverload) return "#ff6a6a";
  return "#7fa8d8";
}

// Wind field: climatological westerly base blended with IDW from METAR stations.
// Returns (lat, lon) -> {u: kt east, v: kt north, kt: speed}.
function makeWindField(stations) {
  const pts = stations.map(s => {
    const rad = ((s.wind_dir_deg + 180) * Math.PI) / 180;
    return {
      lat: s.lat, lon: s.lon,
      u: s.wind_kt * Math.sin(rad), v: s.wind_kt * Math.cos(rad),
      isReal: s.source === "metar",
    };
  });
  return (lat, lon) => {
    const baseDirDeg = 270 + (lat - 38) * 1.5;
    const baseSpeed = 12 + Math.max(0, (lat - 30) * 0.4);
    const baseRad = ((baseDirDeg + 180) * Math.PI) / 180;
    let u = baseSpeed * Math.sin(baseRad);
    let v = baseSpeed * Math.cos(baseRad);
    let wsum = 0, uSum = 0, vSum = 0;
    for (const p of pts) {
      const dLat = lat - p.lat;
      const dLon = (lon - p.lon) * Math.cos((lat * Math.PI) / 180);
      const d2 = dLat * dLat + dLon * dLon;
      const w = 1 / (d2 + 0.5);
      wsum += w; uSum += w * p.u; vSum += w * p.v;
    }
    if (wsum > 0) {
      const realityWeight = 0.55;
      const ux = uSum / wsum, vx = vSum / wsum;
      u = u * (1 - realityWeight) + ux * realityWeight;
      v = v * (1 - realityWeight) + vx * realityWeight;
    }
    return { u, v, kt: Math.sqrt(u * u + v * v) };
  };
}
function streamColor(kt, alpha) {
  if (kt >= 40) return `rgba(255, 70, 50, ${Math.min(1, alpha + 0.25)})`;  // DANGER — fully saturated red, brighter
  if (kt >= 25) return `rgba(255, 184, 0, ${alpha})`;                       // CAUTION — amber
  return `rgba(0, 227, 122, ${alpha})`;                                     // CALM — green
}
function spawnInView(p) {
  if (!S.view) { p.lat = 38; p.lon = -98; p.age = 0; return; }
  const [w, e, s, n] = S.view;
  p.lat = s + Math.random() * (n - s);
  p.lon = w + Math.random() * (e - w);
  p.age = Math.random() * PARTICLE_LIFE * 0.5;
}
function restartParticles() {
  if (!S.view) return;
  WIND_FX.particles = new Array(PARTICLES_N).fill(0).map(() => {
    const p = { lat: 0, lon: 0, age: 0 };
    spawnInView(p);
    return p;
  });
  WIND_FX.lastView = S.view.slice();
  if (fxCtx) fxCtx.clearRect(0, 0, fxCanvas.width, fxCanvas.height);
}
function windFxTick() {
  if (!S.windsOn || !fxCtx || !S.view || !WIND_FX.field) {
    WIND_FX.raf = null;
    return;
  }
  if (WIND_FX.lastView) {
    const a = WIND_FX.lastView, b = S.view;
    if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2] || a[3] !== b[3]) {
      restartParticles();
    }
  }
  const W = fxCanvas.width, H = fxCanvas.height, dpr = S.dpr;
  fxCtx.globalCompositeOperation = "destination-in";
  fxCtx.fillStyle = `rgba(0,0,0,${TRAIL_FADE})`;
  fxCtx.fillRect(0, 0, W, H);
  fxCtx.globalCompositeOperation = "source-over";
  const [vw, ve, vs, vn] = S.view;
  const field = WIND_FX.field;
  for (const p of WIND_FX.particles) {
    const { u, v, kt } = field(p.lat, p.lon);
    const [prevX, prevY] = proj(p.lat, p.lon);
    const dLat = v * SPEED_SCALE * 0.05;
    const dLon = u * SPEED_SCALE * 0.05 / Math.max(Math.cos((p.lat * Math.PI) / 180), 0.3);
    p.lat += dLat;
    p.lon += dLon;
    p.age += 1;
    if (p.age > PARTICLE_LIFE ||
        p.lat < vs - 1 || p.lat > vn + 1 ||
        p.lon < vw - 1 || p.lon > ve + 1) {
      spawnInView(p);
      continue;
    }
    const [curX, curY] = proj(p.lat, p.lon);
    const alpha = Math.min(1, kt / 30) * 0.7 + 0.25;
    fxCtx.strokeStyle = streamColor(kt, alpha);
    fxCtx.lineWidth = 1.1 * dpr;
    fxCtx.beginPath();
    fxCtx.moveTo(prevX, prevY);
    fxCtx.lineTo(curX, curY);
    fxCtx.stroke();
  }
  WIND_FX.raf = requestAnimationFrame(windFxTick);
}
function startWindFx() {
  if (!fxCtx || !S.winds || !S.winds.stations) return;
  WIND_FX.field = makeWindField(S.winds.stations);
  restartParticles();
  if (WIND_FX.raf == null) WIND_FX.raf = requestAnimationFrame(windFxTick);
}
function stopWindFx() {
  if (WIND_FX.raf != null) cancelAnimationFrame(WIND_FX.raf);
  WIND_FX.raf = null;
  if (fxCtx) fxCtx.clearRect(0, 0, fxCanvas.width, fxCanvas.height);
}

// Sector polygons: full HIGH-band airspace with load/capacity color ramp.
function sectorFillColor(pct) {
  if (pct >= 0.9) return "rgba(255, 59, 48, 0.55)";
  if (pct >= 0.6) return "rgba(255, 184, 0, 0.42)";
  if (pct >= 0.3) return "rgba(0, 212, 255, 0.22)";
  return "rgba(0, 212, 255, 0.10)";
}
function sectorStrokeColor(pct) {
  if (pct >= 0.9) return "rgba(255, 59, 48, 0.95)";
  if (pct >= 0.6) return "rgba(255, 184, 0, 0.9)";
  return "rgba(0, 212, 255, 0.7)";
}
function drawSectors() {
  if (!S.sectors || !S.sectors.length) return;
  const dpr = S.dpr;
  for (const sec of S.sectors) {
    if (!sec.ring || sec.ring.length < 3) continue;
    ctx.beginPath();
    sec.ring.forEach((c, i) => {
      const [x, y] = proj(c[0], c[1]);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.closePath();
    ctx.fillStyle = sectorFillColor(sec.load_pct);
    ctx.fill();
    ctx.strokeStyle = sectorStrokeColor(sec.load_pct);
    ctx.lineWidth = (sec.load_pct >= 0.6 ? 1.6 : 1.1) * dpr;
    ctx.stroke();
  }
  ctx.textAlign = "center";
  ctx.font = `${10 * dpr}px ${MONO}`;
  for (const sec of S.sectors) {
    if (sec.load_pct < 0.4) continue;
    const c = centroid(sec.ring), [cx, cy] = proj(c[0], c[1]);
    ctx.fillStyle = "rgba(242,245,249,.92)";
    ctx.shadowColor = "rgba(7,10,16,.9)";
    ctx.shadowBlur = 3 * dpr;
    ctx.fillText(sec.name, cx, cy);
    ctx.fillText(`${sec.load}/${sec.cap}`, cx, cy + 12 * dpr);
    ctx.shadowBlur = 0;
  }
  ctx.textAlign = "left";
}

function draw() {
  const W = canvas.width, H = canvas.height, dpr = S.dpr;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, "#070c13"); bg.addColorStop(1, "#04070c");
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  if (!S.meta || !S.view) return;

  // graticule
  ctx.strokeStyle = "rgba(120,150,190,.05)"; ctx.lineWidth = dpr;
  for (let lon = -130; lon <= -60; lon += 5) { const [x] = proj(40, lon); ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let lat = 20; lat <= 55; lat += 5) { const [, y] = proj(lat, -95); ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

  // weather
  if (S.weatherOn && S.wx && S.meta.weatherExtent) {
    const [ww, we, ws, wn] = S.meta.weatherExtent;
    const [x0, y0] = proj(wn, ww), [x1, y1] = proj(ws, we);
    ctx.globalAlpha = 0.92; ctx.imageSmoothingEnabled = true;
    ctx.drawImage(S.wx, x0, y0, x1 - x0, y1 - y0); ctx.globalAlpha = 1;
  }

  // states
  if (S.states) { ctx.strokeStyle = "rgba(125,160,195,.18)"; ctx.lineWidth = dpr; for (const f of S.states.features) drawGeom(f.geometry); }

  // over-demand sectors
  for (const sec of (S.state && S.state.overloadSectors) || []) {
    ctx.beginPath();
    sec.ring.forEach((c, i) => { const [x, y] = proj(c[0], c[1]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
    ctx.closePath();
    ctx.fillStyle = "rgba(225,55,55,.12)"; ctx.fill();
    ctx.strokeStyle = "rgba(235,80,80,.55)"; ctx.lineWidth = 1.3 * dpr;
    ctx.setLineDash([6 * dpr, 5 * dpr]); ctx.stroke(); ctx.setLineDash([]);
    const c = centroid(sec.ring), [cx, cy] = proj(c[0], c[1]);
    ctx.fillStyle = "rgba(255,150,150,.9)"; ctx.font = `${11 * dpr}px ${MONO}`; ctx.textAlign = "center";
    ctx.fillText(sec.name, cx, cy); ctx.fillText(`${sec.load}/${sec.cap}`, cx, cy + 13 * dpr);
  }

  // cities
  ctx.textAlign = "left";
  for (const c of S.cities) {
    if (c.lon < S.view[0] || c.lon > S.view[1] || c.lat < S.view[2] || c.lat > S.view[3]) continue;
    const [x, y] = proj(c.lat, c.lon);
    ctx.fillStyle = "rgba(150,175,200,.55)"; ctx.beginPath(); ctx.arc(x, y, 2.2 * dpr, 0, 7); ctx.fill();
    ctx.fillStyle = "rgba(160,180,200,.6)"; ctx.font = `${11 * dpr}px ${SANS}`;
    ctx.fillText(c.n.toUpperCase(), x + 6 * dpr, y + 3.5 * dpr);
  }

  // sector polygons (toggleable layer) — rendered before traffic/plane so they sit underneath
  if (S.sectorsOn) drawSectors();

  // traffic
  for (const t of (S.state && S.state.traffic) || []) { const [x, y] = proj(t.lat, t.lon); drawPlane(x, y, 5 * dpr, t.hdg, "rgba(165,190,215,.5)", false); }

  // client-side plane split — follows the selected reroute once scrubbed past
  // the point where reroutes were evaluated (instant, no server round-trip).
  const selR = (S.reroutes && S.selected != null && S.rerouteFrac != null)
        ? S.reroutes.reroutes[S.selected] : null;
  const onReroute = selR && S.frac > S.rerouteFrac;
  const sp = activeSplit(S.frac);

  // flown history
  ctx.strokeStyle = "rgba(150,170,190,.45)"; ctx.lineWidth = 2 * dpr; ctx.setLineDash([]);
  if (sp.flown.length > 1) strokeCoords(sp.flown);

  // remaining ahead — the chosen reroute (colored) once committed, else filed (dashed)
  if (onReroute) {
    const g = routeGlow(selR);
    ctx.save(); ctx.strokeStyle = g; ctx.lineWidth = 2.8 * dpr; ctx.lineJoin = "round";
    ctx.shadowColor = g; ctx.shadowBlur = 10 * dpr; ctx.setLineDash([]);
    strokeCoords(sp.remaining); ctx.restore();
  } else {
    ctx.strokeStyle = "rgba(150,165,182,.7)"; ctx.lineWidth = 1.6 * dpr;
    ctx.setLineDash([9 * dpr, 7 * dpr]); strokeCoords(sp.remaining); ctx.setLineDash([]);
  }

  // reroute options overlay — colored by category so the suggestion is obvious:
  //   recommended = green solid · viable alternate = blue dotted · rejected = red dashed
  if (S.reroutes) {
    S.reroutes.reroutes.forEach((r, i) => {
      if (i === S.selected) return;                  // selected handled below
      const st = routeStyle(r);
      ctx.strokeStyle = st.color; ctx.lineWidth = st.w * dpr;
      ctx.setLineDash(st.dash.map(d => d * dpr));
      strokeCoords(r.coords);
    });
    ctx.setLineDash([]);
    if (selR) {
      const g = routeGlow(selR);
      if (!onReroute) {                              // show the full chosen route ahead before committing
        ctx.save(); ctx.strokeStyle = g; ctx.lineWidth = 3.4 * dpr;
        ctx.shadowColor = g; ctx.shadowBlur = 14 * dpr; ctx.lineJoin = "round";
        ctx.setLineDash([]); strokeCoords(selR.coords); ctx.restore();
      }
      const d = selR.coords[selR.coords.length - 1], [dx, dy] = proj(d[0], d[1]);
      diamond(dx, dy, 6 * dpr, g);
    }
  }

  // our aircraft
  const [px, py] = proj(sp.lat, sp.lon);
  ctx.strokeStyle = "rgba(47,214,238,.5)"; ctx.lineWidth = 1.5 * dpr;
  ctx.beginPath(); ctx.arc(px, py, 11 * dpr, 0, 7); ctx.stroke();
  drawPlane(px, py, 9 * dpr, sp.hdg, "#2fd6ee", true);

  updateScaleBar();
  updateFuel();
}

// Cumulative fuel tracker. Fuel = distance × aircraft burn rate (lb/nm). Uses the
// ACTIVE path (filed + any accepted reroutes), so detours raise the totals, and
// each field shows the extra vs what the filed route would have used by this time.
function fmtLb(lb) {
  return lb >= 1000 ? (lb / 1000).toFixed(lb >= 9950 ? 0 : 1) + "k" : String(Math.round(lb));
}
function fuelDelta(d) {
  if (Math.abs(d) < 50) return "";
  const cls = d > 0 ? "up" : "down";
  return ` <span class="fd ${cls}">${d > 0 ? "+" : "−"}${fmtLb(Math.abs(d))}</span>`;
}
function updateFuel() {
  if (!S.meta) return;
  const burn = S.meta.fuelPerNm || 0;
  const sp = activeSplit(S.frac);                       // actual path being flown
  const filed = splitAt(S.meta.filed, S.frac);          // filed baseline at the same time
  const used = lineLen(sp.flown) * burn, rem = lineLen(sp.remaining) * burn;
  const dUsed = used - lineLen(filed.flown) * burn;
  const dRem = rem - lineLen(filed.remaining) * burn;
  setHtml("fuelUsed", `${fmtLb(used)}<small> lb</small>${fuelDelta(dUsed)}`);
  setHtml("fuelRem", `${fmtLb(rem)}<small> lb</small>${fuelDelta(dRem)}`);
  setHtml("fuelTotal", `${fmtLb(used + rem)}<small> lb</small>${fuelDelta(dUsed + dRem)}`);
}

function updateScaleBar() {
  const midLat = (S.view[2] + S.view[3]) / 2;
  const [x0] = proj(midLat, S.view[0]), [x1] = proj(midLat, S.view[0] + 1);
  const pxPerDeg = (x1 - x0) / S.dpr;
  const nmPerDeg = 60 * Math.cos(midLat * Math.PI / 180);
  const pxPerNm = pxPerDeg / nmPerDeg;
  const el = document.querySelector(".sb-line");
  if (el && isFinite(pxPerNm) && pxPerNm > 0) el.style.width = Math.max(18, 100 * pxPerNm) + "px";
}

// ------------- UI binding -------------
function tagClass(s) {
  if (s === "SEV") return "sev";
  if (s === "MOD" || s === "LGT-MOD") return "mod";
  if (s === "LIGHT" || s === "SMTH-LGT") return "light";
  return "smooth";
}
function dbzColor(d) {
  if (d >= 50) return "#dc2d1e"; if (d >= 40) return "#f0961e";
  if (d >= 30) return "#ebc82d"; if (d >= 20) return "#7fb02a"; return "#3f7a3a";
}
const $ = id => document.getElementById(id);
const setText = (id, t) => { $(id).textContent = t; };
const setHtml = (id, h) => { $(id).innerHTML = h; };

function bindMeta() {
  const f = S.meta.flight;
  setText("fcCallsign", f.callsign);
  setText("fcSub", `${f.origin}→${f.dest}`);
  setText("nowcast", `+${Math.floor(S.meta.nowcastMin)}:00`);
  setText("radarAlt", S.meta.radarAlt);
  setText("scTakeoff", S.meta.takeoffZ + "z");
  setText("scLanding", S.meta.landingZ + "z");
}
function bindState() {
  const st = S.state; if (!st) return;
  setText("scNow", st.nowZ + "z");
  // SIGMET
  const sg = $("sigmet");
  if (st.sigmet) {
    sg.classList.remove("hidden");
    setText("sgId", `CONVECTIVE SIGMET ${st.sigmet.id}`);
    setHtml("sgBody", `Line of convective cells across filed track. Tops <b>${st.sigmet.tops}</b>. ` +
            `Deviation advised — <b>${st.sigmet.worstDbz} dBZ</b> near ${st.sigmet.fix}.`);
  } else sg.classList.add("hidden");
  // filed card badges from state
  setHtml("filedBadges",
          `<span class="badge dbz">${st.filed.worstDbz} dBZ</span>` +
          `<span class="badge ${tagClass(st.filed.sevLabel)}">${st.filed.sevLabel}</span>`);
  // upper-right controls box — live as you scrub the timeline
  setText("ctlTime", st.nowZ + "z");
  const wx = $("ctlWx");
  wx.textContent = `${st.filed.worstDbz} dBZ`;
  wx.style.color = dbzColor(st.filed.worstDbz);
  wx.title = st.filed.sevLabel;
}
function bindReroutes() {
  const list = $("rerouteList"), hint = $("rerouteHint");
  if (!S.reroutes) { list.innerHTML = ""; hint.classList.remove("hidden"); setText("panelCount", "—"); return; }
  hint.classList.add("hidden");
  setText("filedName", S.reroutes.filed.name);
  setText("panelCount", S.reroutes.count);
  list.innerHTML = "";
  list.appendChild(origCard(S.reroutes.filed));     // original route, for comparison
  if (S.reroutes.count === 0) {
    list.insertAdjacentHTML("beforeend",
                            `<div class="rr-hint">No reroute needed — the filed track is clear from here.</div>`);
    return;
  }
  S.reroutes.reroutes.forEach((r, i) => list.appendChild(rrCard(r, i)));
}
// The original/filed route as a non-selectable baseline card, so the alternates
// below can be compared against it (same dBZ / severity / aircraft columns).
function origCard(f) {
  const el = document.createElement("div");
  el.className = "rr orig";
  el.innerHTML = `
    <div class="rr-row">
      <span class="rr-idx">··</span>
      <span class="rr-name">ORIGINAL</span>
      <span class="rr-orig-badge">ON PLAN</span>
      <span class="rr-fuel">${f.distNm} nm</span>
    </div>
    <div class="rr-meta">
      <span class="sw" style="background:${dbzColor(f.worstDbz)}"></span>
      <span>${f.worstDbz} dBZ</span>
      <span class="rr-tag ${tagClass(f.sevLabel)}">${f.sevLabel}</span>
      <span style="margin-left:auto">${f.aircraft != null ? f.aircraft : "—"} aircraft</span>
    </div>`;
  return el;
}

function bindLanding() {
  const strip = $("landingStrip");
  const L = S.landing;
  if (!L) { strip.classList.add("hidden"); return; }
  strip.classList.remove("hidden");
  setText("lsIcao", L.icao || (S.meta && S.meta.flight.dest) || "—");
  const st = $("lsState");
  if (!L.available) {
    st.textContent = "NO DATA"; st.className = "ls-state na";
    setHtml("lsBody", L.note || "No METAR available for this time/airport.");
    $("lsWarn").classList.add("hidden");
    return;
  }
  const wind = L.wind_kt != null
        ? `${String(Math.round(L.wind_dir_deg || 0)).padStart(3, "0")}° / <b>${Math.round(L.wind_kt)}</b> kt`
        : "calm";
  const gust = L.gust_kt ? ` G${Math.round(L.gust_kt)}` : "";
  const vis = L.visibility_mi != null ? ` · ${L.visibility_mi} mi vis` : "";
  const xw = L.crosswind_kt != null ? ` · X-wind ${L.crosswind_kt} kt` : "";
  setHtml("lsBody", wind + gust + vis + xw);
  const warn = $("lsWarn");
  if (L.warnings && L.warnings.length) {
    st.textContent = "CAUTION"; st.className = "ls-state warn";
    warn.classList.remove("hidden"); warn.textContent = "⚠ " + L.warnings.join(" · ");
  } else {
    st.textContent = "OK"; st.className = "ls-state ok"; warn.classList.add("hidden");
  }
}
function rrCard(r, i) {
  const el = document.createElement("div");
  el.className = "rr" + (r.recommended ? " reco" : "") +
    (i === S.selected ? " selected expanded" : "") + (r.entersOverload ? " over" : "");
  const fuel = r.addFuelLb >= 1000
        ? (r.addFuelLb / 1000).toFixed(r.addFuelLb >= 10000 ? 1 : 2).replace(/\.?0+$/, "") + "k" : r.addFuelLb;
  el.innerHTML = `
    <div class="rr-row">
      <span class="rr-idx">${String(i + 1).padStart(2, "0")}</span>
      <span class="rr-name">${r.name}</span>
      ${r.recommended ? '<span class="rr-reco-badge">RECOMMENDED</span>' : ""}
      <span class="rr-fuel">${r.addFuelLb ? "−" : ""}${fuel} lb</span>
    </div>
    <div class="rr-meta">
      <span>+${r.addTimeMin} min</span>
      <span class="sw" style="background:${dbzColor(r.worstDbz)}"></span>
      <span>${r.worstDbz} dBZ</span>
      <span class="rr-tag ${tagClass(r.sevLabel)}">${r.sevLabel}</span>
      <span style="margin-left:auto">${r.aircraft} aircraft</span>
    </div>
    ${r.entersOverload ? '<div class="rr-over">✗ enters over-demand sector</div>' : ""}
    <div class="rr-detail">
      <button class="load-btn">LOAD REROUTE → ${r.name}</button>
    </div>`;
  el.addEventListener("click", ev => {
    if (ev.target.classList.contains("load-btn")) { setText("statusText", `Cleared direct ${r.name} · reroute loaded`); return; }
    S.selected = i; bindReroutes(); draw();
  });
  return el;
}

// ------------- data loading -------------
async function fetchWeather() {
  const t = timeIso();
  return new Promise(res => {
    const img = new Image();
    img.onload = () => { S.wx = img; res(); };
    img.onerror = res;
    img.src = `/api/weather.png?date=${S.date}&time=${encodeURIComponent(t)}`;
  });
}
function timeIso() {
  // map frac -> ISO time within [takeoff, landing]
  const t0 = new Date(S.meta.takeoffIso).getTime();
  const t1 = new Date(S.meta.landingIso).getTime();
  return new Date(t0 + S.frac * (t1 - t0)).toISOString().replace(".000Z", "Z");
}

async function loadFlight() {
  setText("pickerMsg", "loading…");
  const res = await fetch(`/api/flight?flight=${encodeURIComponent(S.flight)}&date=${S.date}`);
  const meta = await res.json();
  if (meta.error) { setText("pickerMsg", meta.error); return; }
  S.meta = meta; S.reroutes = null; S.selected = null; S.rerouteFrac = null; S.frac = 0;
  S.committedPath = null; S.landing = null; S.winds = null; S.sectors = null;
  $("landingStrip").classList.add("hidden");
  // Optional deep-link: start at a given time (and optionally auto-suggest).
  if (pendingTime) {
    let ts = pendingTime.trim();
    if (!ts.includes("T")) ts = `${S.date}T${ts}`;     // bare time of day
    if (ts.length === 16) ts += ":00";                  // add seconds
    if (!/[Z+]/.test(ts.slice(10))) ts += "Z";          // force UTC
    const t0 = new Date(meta.takeoffIso).getTime(), t1 = new Date(meta.landingIso).getTime();
    const tt = new Date(ts).getTime();
    if (isFinite(tt) && t1 > t0) S.frac = Math.max(0, Math.min(1, (tt - t0) / (t1 - t0)));
  }
  S.view = fitView(meta.extent, canvas.width, canvas.height);
  bindMeta(); bindReroutes();
  $("timeSlider").value = Math.round(S.frac * 1000); updateScrubText();
  setText("pickerMsg", "");
  history.replaceState(null, "", `?flight=${encodeURIComponent(S.flight)}&date=${S.date}`);
  await Promise.all([fetchWeather(), refreshState()]);
  draw();
  if (pendingSuggest) await suggestReroutes();
  pendingTime = null; pendingSuggest = false;
  loadHotspot();   // background: find congested point + pre-warm reroute cache
  fetchLanding();  // background: destination landing weather
  if (S.windsOn) fetchWinds().then(() => { if (S.windsOn) startWindFx(); });
  if (S.sectorsOn) fetchSectors();
}

let stateSeq = 0;
async function refreshState() {
  const seq = ++stateSeq;
  const t = timeIso();
  const res = await fetch(`/api/state?flight=${encodeURIComponent(S.flight)}&date=${S.date}&time=${encodeURIComponent(t)}`);
  const st = await res.json();
  if (seq !== stateSeq || st.error) return;     // ignore stale
  S.state = st; bindState(); draw();
}

async function loadHotspot() {
  const m = $("scMarker"); m.classList.add("hidden"); S.hotspot = null;
  try {
    const h = await (await fetch(`/api/hotspot?flight=${encodeURIComponent(S.flight)}&date=${S.date}`)).json();
    if (!h.found) return;
    S.hotspot = h;
    m.style.left = (h.frac * 100) + "%";
    m.classList.remove("hidden", "ready");
    m.title = `Congestion ~${h.timeZ}z (${h.worstDbz} dBZ) — pre-computing reroutes…`;
    // Background precompute is usually done within a couple seconds.
    setTimeout(() => { if (S.hotspot === h) { m.classList.add("ready");
                                              m.title = `Congestion ~${h.timeZ}z — reroutes ready. Click to jump.`; } }, 2600);
    m.onclick = () => jumpToHotspot(h);
  } catch (e) {}
}
async function jumpToHotspot(h) {
  $("timeSlider").value = Math.round(h.frac * 1000);
  S.frac = h.frac;
  if (S.reroutes) { S.reroutes = null; S.selected = null; }
  updateScrubText(); draw();
  await Promise.all([fetchWeather().then(draw), refreshState()]);
  await suggestReroutes();   // cache hit if precompute finished -> instant
}

async function suggestReroutes() {
  if (!S.meta) return;
  const btn = $("suggestBtn"); btn.disabled = true; btn.textContent = "⟳ Evaluating…";
  const reqFrac = S.frac;
  const t = timeIso();
  const url = `/api/reroutes?flight=${encodeURIComponent(S.flight)}&date=${S.date}&time=${encodeURIComponent(t)}`;
  // If already flying a selected reroute, branch the new options off the current
  // position along THAT route (server gets our position + remaining as baseline).
  const following = S.reroutes && S.selected != null && S.rerouteFrac != null && reqFrac > S.rerouteFrac;
  const sp = following ? activeSplit(reqFrac) : null;
  try {
    const res = following
          ? await fetch(url, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              lat: sp.lat, lon: sp.lon,
              remaining: sp.remaining.map(c => [+c[0].toFixed(4), +c[1].toFixed(4)]),
            }),
          })
          : await fetch(url);
    S.reroutes = await res.json();
    S.committedPath = following ? sp.flown : null;   // lock in the path flown so far
    S.rerouteFrac = reqFrac;                          // plane follows the new selection past here
    const ri = S.reroutes.reroutes.findIndex(r => r.recommended);
    S.selected = ri >= 0 ? ri : (S.reroutes.reroutes.length ? 0 : null);
    bindReroutes(); draw();
  } finally { btn.disabled = false; btn.textContent = "⟳ Suggest reroutes"; }
}

// Destination landing weather (METAR). Loaded once per flight.
let landingSeq = 0;
async function fetchLanding() {
  if (!S.meta) return;
  const seq = ++landingSeq;
  const t = timeIso();
  try {
    const res = await fetch(`/api/landing?flight=${encodeURIComponent(S.flight)}&date=${S.date}&time=${encodeURIComponent(t)}`);
    const L = await res.json();
    if (seq !== landingSeq || L.error) return;   // superseded or failed
    S.landing = L; bindLanding();
  } catch (e) {}
}

let windsSeq = 0;
async function fetchWinds() {
  if (!S.meta) return;
  const seq = ++windsSeq;
  const t = timeIso();
  try {
    const d = await (await fetch(`/api/winds?date=${S.date}&time=${encodeURIComponent(t)}`)).json();
    if (seq !== windsSeq) return;                  // a newer scrub superseded this
    if (d && d.stations) {
      S.winds = d;
      if (S.windsOn) { WIND_FX.field = makeWindField(d.stations); }
    }
  } catch (e) {}
}
function toggleWinds() {
  S.windsOn = !S.windsOn;
  $("windBtn").classList.toggle("on", S.windsOn);
  $("lgWind").classList.toggle("hidden", !S.windsOn);
  if (S.windsOn) {
    if (!S.winds) fetchWinds().then(() => { if (S.windsOn) startWindFx(); });
    else startWindFx();
  } else {
    stopWindFx();
  }
}

let sectorsSeq = 0;
async function fetchSectors() {
  if (!S.meta) return;
  const seq = ++sectorsSeq;
  const t = timeIso();
  try {
    const d = await (await fetch(`/api/sectors?date=${S.date}&time=${encodeURIComponent(t)}&band=high`)).json();
    if (seq !== sectorsSeq) return;
    if (d && d.sectors) { S.sectors = d.sectors; draw(); }
  } catch (e) {}
}
function toggleSectors() {
  S.sectorsOn = !S.sectorsOn;
  $("sectorBtn").classList.toggle("on", S.sectorsOn);
  $("lgSect").classList.toggle("hidden", !S.sectorsOn);
  if (S.sectorsOn && !S.sectors) fetchSectors(); else draw();
}
function toggleWeather() {
  S.weatherOn = !S.weatherOn;
  $("weatherBtn").classList.toggle("on", S.weatherOn);
  $("wxLegend").classList.toggle("hidden", !S.weatherOn);
  draw();
}

// ------------- scrubber -------------
function updateScrubText() {
  setText("scPct", Math.round(S.frac * 100) + "%");
  if (S.meta) {
    const z = new Date(timeIso()).toISOString().slice(11, 16) + "z";
    setText("scNow", z);
    setText("ctlTime", z);                 // instant time in the controls box while dragging
  }
}
// Live traffic during scrub: one request in flight at a time, always chasing
// the latest scrub position so other aircraft move as you drag.
let trafficBusy = false, trafficPending = false;
async function refreshTrafficLive() {
  if (trafficBusy) { trafficPending = true; return; }
  trafficBusy = true;
  try {
    const t = timeIso();
    const d = await (await fetch(`/api/traffic?flight=${encodeURIComponent(S.flight)}&date=${S.date}&time=${encodeURIComponent(t)}`)).json();
    if (d && d.traffic) {
      if (!S.state) S.state = {};
      S.state.traffic = d.traffic;     // preserve sectors/readouts from last full state
      draw();
    }
  } catch (e) {}
  trafficBusy = false;
  if (trafficPending) { trafficPending = false; refreshTrafficLive(); }
}

// Run an async refresh with at most one request in flight, always chasing the
// latest scrub position (drop intermediate frames). Used for the radar + winds
// so they follow the timeline live instead of only on settle.
function throttleLatest(fn) {
  let busy = false, pending = false;
  return async function run() {
    if (busy) { pending = true; return; }
    busy = true;
    try { await fn(); } finally { busy = false; }
    if (pending) { pending = false; run(); }
  };
}
const refreshWeatherLive = throttleLatest(() => fetchWeather().then(draw));
const refreshWindsLive = throttleLatest(fetchWinds);
const refreshSectorsLive = throttleLatest(fetchSectors);

let scrubTimer = null;
function onScrub() {
  S.frac = (+$("timeSlider").value) / 1000;
  // Keep the reroutes while one is selected so the plane can follow it as you
  // scrub; otherwise a scrub invalidates the position-specific suggestions.
  if (S.reroutes && S.selected == null) { S.reroutes = null; S.rerouteFrac = null; S.committedPath = null; bindReroutes(); }
  updateScrubText(); draw();                       // instant plane move
  refreshTrafficLive();                            // live other-aircraft positions
  refreshWeatherLive();                            // live radar follows the timeline
  if (S.windsOn) refreshWindsLive();               // live wind field follows the timeline
  if (S.sectorsOn) refreshSectorsLive();           // live sector loads follow the timeline
  clearTimeout(scrubTimer);
  scrubTimer = setTimeout(refreshState, 220);      // heavier sector/readout state on settle
}

// ------------- pan / zoom -------------
function zoomAt(px, py, factor) {
  const [lat, lon] = unproj(px, py);
  let [w, e, s, n] = S.view;
  w = lon - (lon - w) * factor; e = lon + (e - lon) * factor;
  s = lat - (lat - s) * factor; n = lat + (n - lat) * factor;
  S.view = [w, e, s, n]; draw();
}
canvas.addEventListener("wheel", ev => {
  ev.preventDefault();
  if (!S.view) return;
  zoomAt(ev.clientX * S.dpr, ev.clientY * S.dpr, ev.deltaY > 0 ? 1.12 : 0.89);
}, { passive: false });

// Distance (px) from point P to segment AB.
function distToSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
// Index of the nearest reroute to a canvas (device-px) point, within tolerance.
function pickRouteAt(px, py) {
  if (!S.reroutes) return null;
  let best = null, bestD = 11 * S.dpr;
  S.reroutes.reroutes.forEach((r, ri) => {
    for (let i = 0; i < r.coords.length - 1; i++) {
      const [ax, ay] = proj(r.coords[i][0], r.coords[i][1]);
      const [bx, by] = proj(r.coords[i + 1][0], r.coords[i + 1][1]);
      const d = distToSeg(px, py, ax, ay, bx, by);
      if (d < bestD) { bestD = d; best = ri; }
    }
  });
  return best;
}

let drag = null;
canvas.addEventListener("mousedown", ev => {
  drag = { x: ev.clientX, y: ev.clientY, view: S.view.slice(), moved: false };
});
addEventListener("mousemove", ev => {
  if (drag && S.view) {
    if (Math.abs(ev.clientX - drag.x) > 3 || Math.abs(ev.clientY - drag.y) > 3) {
      drag.moved = true; canvas.style.cursor = "grabbing";
    }
    const W = canvas.width, H = canvas.height;
    const [w, e, s, n] = drag.view;
    const dx = (ev.clientX - drag.x) * S.dpr, dy = (ev.clientY - drag.y) * S.dpr;
    const dlon = dx / W * (e - w), dlat = dy / H * (n - s);
    S.view = [w - dlon, e - dlon, s + dlat, n + dlat]; draw();
    return;
  }
  if (S.view) canvas.style.cursor = pickRouteAt(ev.clientX * S.dpr, ev.clientY * S.dpr) ? "pointer" : "";
});
addEventListener("mouseup", ev => {
  const d = drag; drag = null; canvas.style.cursor = "";
  if (d && !d.moved && S.view) {            // a click, not a pan
    const idx = pickRouteAt(ev.clientX * S.dpr, ev.clientY * S.dpr);
    if (idx != null) { S.selected = idx; bindReroutes(); draw(); }
  }
});

// ------------- picker -------------
async function loadDates() {
  const res = await fetch(`/api/flights?date=${S.date}`);
  const d = await res.json();
  const sel = $("dateSel"); sel.innerHTML = "";
  (d.dates || []).forEach(dt => {
    const o = document.createElement("option"); o.value = dt; o.textContent = dt;
    if (dt === S.date) o.selected = true; sel.appendChild(o);
  });
  refreshFlightList("");
}
let flListTimer = null;
async function refreshFlightList(q) {
  const res = await fetch(`/api/flights?date=${S.date}&q=${encodeURIComponent(q)}`);
  const d = await res.json();
  const dl = $("flightList"); dl.innerHTML = "";
  (d.flights || []).forEach(fn => { const o = document.createElement("option"); o.value = fn; dl.appendChild(o); });
}

$("dateSel").addEventListener("change", e => { S.date = e.target.value; refreshFlightList(""); });
$("flightInput").addEventListener("input", e => {
  clearTimeout(flListTimer);
  const q = e.target.value;
  flListTimer = setTimeout(() => refreshFlightList(q), 180);
});
$("flightInput").addEventListener("keydown", e => { if (e.key === "Enter") { S.flight = e.target.value.trim().toUpperCase(); loadFlight(); } });
$("loadBtn").addEventListener("click", () => { S.flight = $("flightInput").value.trim().toUpperCase() || S.flight; loadFlight(); });

$("timeSlider").addEventListener("input", onScrub);
$("suggestBtn").addEventListener("click", suggestReroutes);
$("zoomIn").addEventListener("click", () => zoomAt(canvas.width / 2, canvas.height / 2, 0.8));
$("zoomOut").addEventListener("click", () => zoomAt(canvas.width / 2, canvas.height / 2, 1.25));
$("fitBtn").addEventListener("click", () => { if (S.meta) { S.view = fitView(S.meta.extent, canvas.width, canvas.height); draw(); } });
$("windBtn").addEventListener("click", toggleWinds);
$("sectorBtn").addEventListener("click", toggleSectors);
$("weatherBtn").addEventListener("click", toggleWeather);
addEventListener("resize", resize);

// ------------- "Don't Crash!" curved caption (per-char, upright smile) -------------
function buildLogoCaption() {
  const g = document.getElementById("capGroup");
  if (!g || g.childNodes.length) return;
  const text = "Don't Crash!", cx = 62, cy = 56, R = 64;
  const start = 142, end = 38, N = text.length, step = (start - end) / (N - 1);
  const NS = "http://www.w3.org/2000/svg";
  for (let i = 0; i < N; i++) {
    const phi = start - i * step, rad = phi * Math.PI / 180;
    const x = cx + R * Math.cos(rad), y = cy + R * Math.sin(rad), rot = phi - 90;
    const t = document.createElementNS(NS, "text");
    t.setAttribute("x", x.toFixed(2)); t.setAttribute("y", y.toFixed(2));
    t.setAttribute("text-anchor", "middle"); t.setAttribute("dominant-baseline", "central");
    t.setAttribute("transform", `rotate(${rot.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)})`);
    t.textContent = text[i];
    g.appendChild(t);
  }
}

// ------------- boot -------------
async function boot() {
  resize();
  buildLogoCaption();
  [S.states, S.cities] = await Promise.all([
    fetch("/static/us_states.geojson").then(r => r.json()),
    fetch("/static/cities.json").then(r => r.json()),
  ]);
  $("flightInput").value = S.flight;
  await loadDates();
  await loadFlight();
}
boot();

// ------------- live reload -------------
let lastVer = null;
setInterval(async () => {
  try { const v = await (await fetch("/api/version")).json();
        if (lastVer && v.version !== lastVer) location.reload(); lastVer = v.version;
      } catch (e) {}
}, 1500);
