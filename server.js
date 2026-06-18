import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.PORT || "8787", 10);
const EMAIL = process.env.ACLED_EMAIL || "";
const PASSWORD = process.env.ACLED_PASSWORD || "";

const MOCK = process.env.ACLED_MOCK === "1" || !EMAIL || !PASSWORD;
const DEBUG_GLOBAL = process.env.DEBUG === "1";

const TOKEN_URL = "https://acleddata.com/oauth/token";
const READ_URL  = "https://acleddata.com/api/acled/read";

const WINDOW_DAYS = parseInt(process.env.WINDOW_DAYS || "30", 10);
const PAGE_LIMIT = 1000;
const MAX_PAGES = 20;
const CONCURRENCY = 4;
const CACHE_MIN = parseInt(process.env.CACHE_MIN || "15", 10);

const COUNTRIES = [
  "Ukraine","Russia","Sudan","South Sudan","Democratic Republic of Congo",
  "Mali","Burkina Faso","Niger","Haiti","Somalia","Nigeria","Myanmar",
  "Israel","Palestine","Yemen","Syria","Lebanon","Iran","Venezuela",
  "India","Pakistan","Ethiopia","Eritrea","Armenia","Azerbaijan",
  "Serbia","Kosovo","China","Taiwan",
];

let tokenCache = { access: null, exp: 0 };
let dataCache = { ts: 0, payload: null };

// -------------------- UTIL --------------------
function isoDaysAgo(days) {
  const d = new Date(Date.now() - days * 86400000);
  return d.toISOString().slice(0, 10);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// -------------------- TOKEN --------------------
async function getToken() {
  const now = Date.now();
  if (tokenCache.access && now < tokenCache.exp) return tokenCache.access;

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

  if (!res.ok) {
    throw new Error(`AUTH ACLED FAIL: ${res.status}`);
  }

  const j = await res.json();

  tokenCache = {
    access: j.access_token,
    exp: now + (j.expires_in - 300) * 1000,
  };

  return tokenCache.access;
}

// -------------------- ACLED FETCH (BLINDADO) --------------------
async function fetchCountry(country, token, fromISO, toISO, debug = false) {
  let events = 0;
  let fatalities = 0;
  let pagesOk = 0;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url =
      `${READ_URL}?_format=json`
      + `&country=${encodeURIComponent(country)}`
      + `&event_date=${fromISO}`
      + `&event_date_where=>=`
      + `&limit=${PAGE_LIMIT}&page=${page}`;

    let res;

    // retry leve (blindagem)
    for (let attempt = 1; attempt <= 2; attempt++) {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (res.ok) break;
      await sleep(400 * attempt);
    }

    if (!res.ok) {
      if (debug) console.log(`[${country}] erro HTTP`, res.status);
      break;
    }

    const j = await res.json();

    const rows = Array.isArray(j)
      ? j
      : Array.isArray(j?.data)
        ? j.data
        : [];

    if (debug && page === 1) {
      console.log(`\n[DEBUG ${country}] rows:`, rows.length);
      console.log(rows.slice(0, 2));
    }

    if (rows.length === 0) break;

    pagesOk++;

    for (const r of rows) {
      events++;
      fatalities += Number(r.fatalities) || 0;
    }

    if (rows.length < PAGE_LIMIT) break;
  }

  return { events, fatalities, pagesOk };
}

// -------------------- POOL --------------------
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

// -------------------- SCORE (BLINDADO) --------------------
function level(events, fatalities) {
  const score = events + fatalities * 4;

  if (score >= 600) return "active";
  if (score >= 180) return "volatile";
  return "latent";
}

// -------------------- BUILD --------------------
async function buildIntensity(debug = false) {
  const fromISO = isoDaysAgo(WINDOW_DAYS);
  const toISO = isoDaysAgo(0);

  const token = await getToken();

  const counts = await withPool(
    COUNTRIES,
    (c) => fetchCountry(c, token, fromISO, toISO, debug),
    CONCURRENCY
  );

  const countries = {};
  let totalEvents = 0;

  for (const c of COUNTRIES) {
    const { events = 0, fatalities = 0 } = counts[c] || {};
    totalEvents += events;

    countries[c] = {
      events,
      fatalities,
      level: level(events, fatalities),
    };
  }

  if (debug) {
    console.log("\nTOTAL EVENTS:", totalEvents);
  }

  return {
    updated: new Date().toISOString(),
    window_days: WINDOW_DAYS,
    source: "ACLED",
    countries,
  };
}

// -------------------- MOCK --------------------
function mockIntensity() {
  const base = {};
  for (const c of COUNTRIES) {
    base[c] = {
      events: Math.floor(Math.random() * 300),
      fatalities: Math.floor(Math.random() * 120),
    };
  }

  const countries = {};
  for (const [c, v] of Object.entries(base)) {
    countries[c] = {
      ...v,
      level: level(v.events, v.fatalities),
    };
  }

  return {
    updated: new Date().toISOString(),
    source: "mock",
    countries,
  };
}

// -------------------- CACHE --------------------
async function getPayload(debug = false) {
  const fresh = Date.now() - dataCache.ts < CACHE_MIN * 60000;
  if (fresh && dataCache.payload) return dataCache.payload;

  const payload = MOCK
    ? mockIntensity()
    : await buildIntensity(debug);

  dataCache = { ts: Date.now(), payload };
  return payload;
}

// -------------------- SERVER --------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const debug = url.searchParams.get("debug") === "1" || DEBUG_GLOBAL;

  res.setHeader("Access-Control-Allow-Origin", "*");

  if (url.pathname === "/intensity") {
    try {
      const data = await getPayload(debug);
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

  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, () => {
  console.log(`🚀 server running http://localhost:${PORT}`);
  console.log(`📊 /intensity`);
});