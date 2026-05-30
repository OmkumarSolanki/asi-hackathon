"use strict";

const Q = new URLSearchParams(location.search);
let pendingTime = Q.get("time");          // optional deep-link start time
let pendingSuggest = Q.get("suggest") === "1";
const canvas = document.getElementById("map");
const ctx = canvas.getContext("2d");
const MONO = "ui-monospace,Menlo,Consolas,monospace";
const SANS = "-apple-system,Segoe UI,Roboto,sans-serif";

// ------------- app state -------------
const S = {
  date: Q.get("date") || "2025-07-08",
  flight: Q.get("flight") || "SWA3209",
  meta: null,        // /api/flight
  state: null,       // /api/state
  reroutes: null,    // /api/reroutes  (null until "Suggest" pressed)
  selected: null,    // selected reroute name
  frac: 0,           // scrub position 0..1
  view: null,        // [w,e,s,n]
  wx: null,          // weather Image
  states: null, cities: [],
  dpr: 1,
  advisory: null,    // /api/advisory (brief + crowd + analogs + landing)
  winds: null,       // /api/winds station vectors
  windsOn: false,    // surface-wind layer toggle
};

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

// Surface-wind vectors: an arrow per station pointing the way the wind blows
// (wind_dir_deg is the direction it comes FROM, so we add 180°). Green under
// 40 kt, red at/above. Length scales with speed.
function drawWinds() {
  if (!S.winds || !S.winds.stations) return;
  const dpr = S.dpr;
  for (const w of S.winds.stations) {
    if (w.lon < S.view[0] || w.lon > S.view[1] || w.lat < S.view[2] || w.lat > S.view[3]) continue;
    const [x, y] = proj(w.lat, w.lon);
    const to = ((w.wind_dir_deg + 180) % 360) * Math.PI / 180;   // dir wind goes toward
    // canvas: x right, y down; 0°=N(up). dx=sin, dy=-cos
    const len = (8 + Math.min(28, w.wind_kt * 0.7)) * dpr;
    const ex = x + Math.sin(to) * len, ey = y - Math.cos(to) * len;
    const col = w.wind_kt >= 40 ? "rgba(255,120,120,.9)" : "rgba(80,210,170,.85)";
    ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1.6 * dpr;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(ex, ey); ctx.stroke();
    // arrowhead
    const a1 = to + Math.PI * 0.82, a2 = to - Math.PI * 0.82, h = 5 * dpr;
    ctx.beginPath(); ctx.moveTo(ex, ey);
    ctx.lineTo(ex + Math.sin(a1) * h, ey - Math.cos(a1) * h);
    ctx.lineTo(ex + Math.sin(a2) * h, ey - Math.cos(a2) * h);
    ctx.closePath(); ctx.fill();
    ctx.beginPath(); ctx.arc(x, y, 1.6 * dpr, 0, 7); ctx.fill();
  }
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
  if (S.wx && S.meta.weatherExtent) {
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

  // surface winds (toggleable layer)
  if (S.windsOn) drawWinds();

  // traffic
  for (const t of (S.state && S.state.traffic) || []) { const [x, y] = proj(t.lat, t.lon); drawPlane(x, y, 5 * dpr, t.hdg, "rgba(165,190,215,.5)", false); }

  // client-side plane split (instant)
  const sp = splitAt(S.meta.filed, S.frac);

  // flown history
  ctx.strokeStyle = "rgba(150,170,190,.45)"; ctx.lineWidth = 2 * dpr; ctx.setLineDash([]);
  if (sp.flown.length > 1) strokeCoords(sp.flown);

  // filed remaining (dashed)
  ctx.strokeStyle = "rgba(150,165,182,.7)"; ctx.lineWidth = 1.6 * dpr;
  ctx.setLineDash([9 * dpr, 7 * dpr]); strokeCoords(sp.remaining); ctx.setLineDash([]);

  // reroutes (if computed)
  if (S.reroutes) {
    ctx.lineWidth = 1.4 * dpr;
    S.reroutes.reroutes.forEach((r, i) => {
      if (i === S.selected) return;
      ctx.strokeStyle = r.entersOverload ? "rgba(220,70,70,.55)" : "rgba(120,140,160,.6)";
      ctx.setLineDash(r.entersOverload ? [3 * dpr, 4 * dpr] : [2 * dpr, 6 * dpr]);
      strokeCoords(r.coords);
    });
    ctx.setLineDash([]);
    const sel = S.selected != null ? S.reroutes.reroutes[S.selected] : null;
    if (sel) {
      ctx.save(); ctx.strokeStyle = "#2fd6ee"; ctx.lineWidth = 3 * dpr;
      ctx.shadowColor = "#2fd6ee"; ctx.shadowBlur = 14 * dpr; ctx.lineJoin = "round";
      strokeCoords(sel.coords); ctx.restore();
      const d = sel.coords[sel.coords.length - 1], [dx, dy] = proj(d[0], d[1]);
      diamond(dx, dy, 6 * dpr, "#2fd6ee");
    }
  }

  // our aircraft
  const [px, py] = proj(sp.lat, sp.lon);
  ctx.strokeStyle = "rgba(47,214,238,.5)"; ctx.lineWidth = 1.5 * dpr;
  ctx.beginPath(); ctx.arc(px, py, 11 * dpr, 0, 7); ctx.stroke();
  drawPlane(px, py, 9 * dpr, sp.hdg, "#2fd6ee", true);

  updateScaleBar();
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
  setText("fcSub", `${f.type} · ${f.origin}→${f.dest}`);
  setText("fcAlt", f.altFL);
  setHtml("fcGs", `${f.gsKt}<small>kt</small>`);
  setText("nowcast", `+${Math.floor(S.meta.nowcastMin)}:00`);
  setText("radarAlt", S.meta.radarAlt);
  setText("scTakeoff", S.meta.takeoffZ + "z");
  setText("scLanding", S.meta.landingZ + "z");
}
function bindState() {
  const st = S.state; if (!st) return;
  const r = st.readouts;
  setText("fcHdg", String(r.hdg).padStart(3, "0") + "°");
  setText("fcFix", r.nextFix);
  setHtml("fcEta", `${r.etaZ}<small>z</small>`);
  setHtml("fcFuel", r.fuelText.replace(/ lb$/, "<small> lb</small>"));
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
}
function bindReroutes() {
  const list = $("rerouteList"), hint = $("rerouteHint");
  if (!S.reroutes) { list.innerHTML = ""; hint.classList.remove("hidden"); setText("panelCount", "—"); return; }
  hint.classList.add("hidden");
  setText("filedName", S.reroutes.filed.name);
  setText("panelCount", S.reroutes.count);
  list.innerHTML = "";
  if (S.reroutes.count === 0) {
    list.innerHTML = `<div class="rr-hint">No reroute needed — the filed track is clear from here.</div>`;
    return;
  }
  S.reroutes.reroutes.forEach((r, i) => list.appendChild(rrCard(r, i)));
}

function verdictClass(v) {
  if (!v || v === "UNKNOWN") return "unknown";
  return v.includes("NO") ? "no" : "go";
}
function bindAdvisory() {
  const box = $("advisory");
  const a = S.advisory;
  if (!a) { box.classList.add("hidden"); return; }
  box.classList.remove("hidden");
  const conf = (a.confidence || "MEDIUM").toLowerCase();
  setText("advConf", `CONF ${a.confidence || "MED"}`);
  $("advConf").className = "adv-conf " + conf;
  const brief = $("advBrief");
  brief.classList.remove("loading");
  brief.textContent = a.brief || "—";
  // Crowd-forecast
  const c = a.crowd;
  if (c && c.n_observed > 0) {
    $("advCrowd").classList.remove("hidden");
    setText("advVerdict", c.verdict);
    $("advVerdict").className = "adv-verdict " + verdictClass(c.verdict);
    setText("advCrowdLine", c.headline || `${c.n_detoured} of ${c.n_observed} nearby flights detoured.`);
  } else $("advCrowd").classList.add("hidden");
  // Historical analogs
  const an = a.analogs;
  if (an && an.count > 0) {
    $("advAnalogs").classList.remove("hidden");
    setText("advAnalogCount", an.count);
    setText("advAnalogLine",
      `Median ${an.median_refc} dBZ · ${an.scenarios} day(s) in the ${an.count}-match archive.`);
  } else $("advAnalogs").classList.add("hidden");
  bindLanding();
}
function bindLanding() {
  const strip = $("landingStrip");
  const L = S.advisory && S.advisory.landing;
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
      <span class="rr-fuel">+${fuel} lb</span>
    </div>
    <div class="rr-meta">
      <span>+${r.addTimeMin} min</span>
      <span class="sw" style="background:${dbzColor(r.worstDbz)}"></span>
      <span>${r.worstDbz} dBZ</span>
      <span class="rr-tag ${tagClass(r.sevLabel)}">${r.sevLabel}</span>
      <span style="margin-left:auto">${r.aircraft} ac</span>
    </div>
    ${r.entersOverload ? '<div class="rr-over">✗ enters over-demand sector</div>' : ""}
    <div class="rr-detail">
      <div class="big"><label>NEXT FIX</label><span>${r.name}</span></div>
      <div><label>ADD'L FUEL</label><div class="v cyan">+${r.addFuelLb.toLocaleString()} lb</div></div>
      <div><label>ADD'L TIME</label><div class="v">+${r.addTimeMin} min</div></div>
      <div><label>WORST WX</label><div class="v">${r.worstDbz} dBZ</div></div>
      <div><label>ON THIS PATH</label><div class="v">${r.aircraft} aircraft</div></div>
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
  S.meta = meta; S.reroutes = null; S.selected = null; S.frac = 0;
  S.advisory = null; S.winds = null;
  $("advisory").classList.add("hidden"); $("landingStrip").classList.add("hidden");
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
  const t = timeIso();
  try {
    const res = await fetch(`/api/reroutes?flight=${encodeURIComponent(S.flight)}&date=${S.date}&time=${encodeURIComponent(t)}`);
    S.reroutes = await res.json();
    let ri = S.reroutes.reroutes.findIndex(r => r.recommended);
    S.selected = ri >= 0 ? ri : (S.reroutes.reroutes.length ? 0 : null);
    bindReroutes(); draw();
  } finally { btn.disabled = false; btn.textContent = "⟳ Suggest reroutes"; }
  fetchAdvisory();                       // ground the AI brief in the chosen reroute
}

// AI advisory bundle (brief + crowd-forecast + analogs + landing weather).
// Heavier (calls Claude), so it's fired after reroutes and shows a loading state.
let advisorySeq = 0;
async function fetchAdvisory() {
  if (!S.meta) return;
  const seq = ++advisorySeq;
  const t = timeIso();
  const box = $("advisory"), brief = $("advBrief");
  box.classList.remove("hidden");
  $("advCrowd").classList.add("hidden"); $("advAnalogs").classList.add("hidden");
  brief.classList.add("loading"); brief.textContent = "Generating briefing…";
  setText("advConf", "…"); $("advConf").className = "adv-conf";
  try {
    const res = await fetch(`/api/advisory?flight=${encodeURIComponent(S.flight)}&date=${S.date}&time=${encodeURIComponent(t)}`);
    const a = await res.json();
    if (seq !== advisorySeq) return;     // a newer scrub/flight superseded this
    if (a.error) { S.advisory = null; box.classList.add("hidden"); return; }
    S.advisory = a; bindAdvisory();
  } catch (e) {
    if (seq === advisorySeq) { brief.classList.remove("loading"); brief.textContent = "Briefing unavailable."; }
  }
}

async function fetchWinds() {
  if (!S.meta) return;
  const t = timeIso();
  try {
    const d = await (await fetch(`/api/winds?date=${S.date}&time=${encodeURIComponent(t)}`)).json();
    if (d && d.stations) { S.winds = d; draw(); }
  } catch (e) {}
}
function toggleWinds() {
  S.windsOn = !S.windsOn;
  $("windBtn").classList.toggle("on", S.windsOn);
  $("lgWind").classList.toggle("hidden", !S.windsOn);
  if (S.windsOn && !S.winds) fetchWinds(); else draw();
}

// ------------- scrubber -------------
function updateScrubText() {
  setText("scPct", Math.round(S.frac * 100) + "%");
  if (S.meta) setText("scNow", new Date(timeIso()).toISOString().slice(11, 16) + "z");
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

let scrubTimer = null;
function onScrub() {
  S.frac = (+$("timeSlider").value) / 1000;
  // moving the plane invalidates any prior reroutes / advisory
  if (S.reroutes) { S.reroutes = null; S.selected = null; bindReroutes(); }
  if (S.advisory) { S.advisory = null; bindAdvisory(); $("advisory").classList.add("hidden"); }
  updateScrubText(); draw();                       // instant plane move
  refreshTrafficLive();                            // live other-aircraft positions
  clearTimeout(scrubTimer);
  scrubTimer = setTimeout(() => {
    fetchWeather().then(draw); refreshState();
    if (S.windsOn) fetchWinds();                   // winds are time-dependent
  }, 220);
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
