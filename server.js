import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PORT || 8787;

const EMAIL = process.env.ACLED_EMAIL || "";
const PASSWORD = process.env.ACLED_PASSWORD || "";

const MOCK = process.env.ACLED_MOCK === "1" || !EMAIL || !PASSWORD;
const DEBUG = process.env.DEBUG === "1";

const TOKEN_URL = "https://acleddata.com/oauth/token";
const READ_URL  = "https://acleddata.com/api/acled/read";

const WINDOW_DAYS = parseInt(process.env.WINDOW_DAYS || "30", 10);
const CACHE_MIN = parseInt(process.env.CACHE_MIN || "20", 10);

const PAGE_LIMIT = 1000;
const MAX_PAGES = 12;
const CONCURRENCY = 3;

const COUNTRIES = [
  "Ukraine","Russia","Sudan","South Sudan","Democratic Republic of Congo",
  "Mali","Burkina Faso","Niger","Haiti","Somalia","Nigeria","Myanmar",
  "Israel","Palestine","Yemen","Syria","Lebanon","Iran","Venezuela",
  "India","Pakistan","Ethiopia","Eritrea","Armenia","Azerbaijan",
  "Serbia","Kosovo","China","Taiwan",
];

// ---------------- CACHE ----------------
let tokenCache = { value: null, exp: 0 };
let dataCache = { ts: 0, payload: null };

// ---------------- UTIL ----------------
function isoDaysAgo(days) {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

function level(events, fatalities) {
  const score = events + fatalities * 4;
  if (score >= 600) return "active";
  if (score >= 180) return "volatile";
  return "latent";
}

// ---------------- TOKEN ----------------
async function getToken() {
  const now = Date.now();
  if (tokenCache.value && now < tokenCache.exp) return tokenCache.value;

  const body = new URLSearchParams({
    username: EMAIL,
    password: PASSWORD,
    grant_type: "password",
    client_id: "acled",
    scope: "authenticated",
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) throw new Error(`ACLED AUTH ERROR ${res.status}`);

  const j = await res.json();

  tokenCache = {
    value: j.access_token,
    exp: now + (j.expires_in - 300) * 1000,
  };

  return tokenCache.value;
}

// ---------------- ACLED FETCH (BULLETPROOF) ----------------
async function fetchCountry(country, token, fromISO, toISO, debug = false) {
  let events = 0;
  let fatalities = 0;
  let gotData = false;

  for (let page = 1; page <= MAX_PAGES; page++) {

    // 🔥 QUERY ROBUSTA (BETWEEN + fallback ready)
    const url =
      `${READ_URL}?_format=json`
      + `&country=${encodeURIComponent(country)}`
      + `&event_date=${fromISO}|${toISO}`
      + `&event_date_where=BETWEEN`
      + `&limit=${PAGE_LIMIT}&page=${page}`;

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!res.ok) {
      if (debug) console.log(`[${country}] HTTP ${res.status}`);
      break;
    }

    const j = await res.json();

    const rows = Array.isArray(j)
      ? j
      : Array.isArray(j?.data)
        ? j.data
        : [];

    if (debug && page === 1) {
      console.log(`DEBUG ${country} rows:`, rows.length);
    }

    // 🚨 DETECTA API VAZIA (IMPORTANTE)
    if (page === 1 && rows.length === 0) {
      if (debug) console.log(`[${country}] EMPTY RESPONSE`);
      break;
    }

    if (rows.length === 0) break;

    gotData = true;

    for (const r of rows) {
      events++;
      fatalities += Number(r.fatalities) || 0;
    }

    if (rows.length < PAGE_LIMIT) break;
  }

  return {
    events,
    fatalities,
    ok: gotData
  };
}

// ---------------- POOL ----------------
async function withPool(items, worker, size) {
  const out = {};
  let i = 0;

  await Promise.all(
    Array.from({ length: size }, async () => {
      while (i < items.length) {
        const idx = i++;
        const c = items[idx];
        out[c] = await worker(c);
      }
    })
  );

  return out;
}

// ---------------- BUILD ----------------
async function buildIntensity(debug = false) {
  const fromISO = isoDaysAgo(WINDOW_DAYS);
  const toISO = isoDaysAgo(0);

  const token = await getToken();

  const results = await withPool(
    COUNTRIES,
    (c) => fetchCountry(c, token, fromISO, toISO, debug),
    CONCURRENCY
  );

  const countries = {};
  let failed = 0;

  for (const c of COUNTRIES) {
    const r = results[c];

    if (!r || !r.ok) {
      failed++;
      countries[c] = {
        events: 0,
        fatalities: 0,
        level: "latent",
        source: "fallback"
      };
      continue;
    }

    countries[c] = {
      events: r.events,
      fatalities: r.fatalities,
      level: level(r.events, r.fatalities),
      source: "acled"
    };
  }

  if (debug) {
    console.log("FAILED COUNTRIES:", failed);
  }

  return {
    updated: new Date().toISOString(),
    source: "ACLED",
    confidence: failed > 5 ? "degraded" : "good",
    countries,
  };
}

// ---------------- MOCK ----------------
function mock() {
  const countries = {};
  for (const c of COUNTRIES) {
    const e = Math.floor(Math.random() * 300);
    const f = Math.floor(Math.random() * 120);

    countries[c] = {
      events: e,
      fatalities: f,
      level: level(e, f),
      source: "mock"
    };
  }

  return {
    updated: new Date().toISOString(),
    source: "mock",
    confidence: "mock",
    countries,
  };
}

// ---------------- CACHE ----------------
async function getData(debug = false) {
  const fresh = Date.now() - dataCache.ts < CACHE_MIN * 60000;
  if (fresh && dataCache.payload) return dataCache.payload;

  const payload = MOCK
    ? mock()
    : await buildIntensity(debug);

  dataCache = { ts: Date.now(), payload };
  return payload;
}

// ---------------- SERVER ----------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const debug = url.searchParams.get("debug") === "1";

  if (url.pathname === "/intensity") {
    try {
      const data = await getData(debug);
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500);
      return res.end(JSON.stringify({ error: String(e.message || e) }));
    }
  }

  if (url.pathname === "/health") {
    return res.end(JSON.stringify({ ok: true }));
  }

  const file =
    url.pathname === "/" ? "monitor-conflitos-globais.html" : url.pathname.slice(1);

  try {
    const content = await readFile(path.join(__dirname, file));
    res.writeHead(200);
    return res.end(content);
  } catch {
    res.writeHead(404);
    return res.end("not found");
  }
});

server.listen(PORT, () => {
  console.log(`🚀 BULLETPROOF ACLED SERVER rodando em http://localhost:${PORT}`);
});