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
const MAX_PAGES = 25;
const CONCURRENCY = 4;

// ---------------- COUNTRIES ----------------
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

// ---------------- TOKEN (ROBUSTO) ----------------
async function getToken() {
  const now = Date.now();

  if (tokenCache.value && now < tokenCache.exp) {
    return tokenCache.value;
  }

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
    const txt = await res.text().catch(() => "");
    throw new Error(`ACLED AUTH FAIL ${res.status}: ${txt}`);
  }

  const j = await res.json();

  tokenCache = {
    value: j.access_token,
    exp: now + (j.expires_in - 300) * 1000,
  };

  return tokenCache.value;
}

// ---------------- FETCH COUNTRY (BLINDADO) ----------------
async function fetchCountry(country, token, fromISO, debug = false) {
  let events = 0;
  let fatalities = 0;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url =
      `${READ_URL}?_format=json`
      + `&country=${encodeURIComponent(country)}`
      + `&event_date=${fromISO}`
      + `&event_date_where=>=`
      + `&limit=${PAGE_LIMIT}&page=${page}`;

    let res;

    // retry leve
    for (let attempt = 0; attempt < 2; attempt++) {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (res.ok) break;
    }

    if (!res.ok) {
      if (DEBUG || debug) {
        console.log(`[${country}] HTTP ERROR`, res.status);
      }
      break;
    }

    const j = await res.json();

    const rows = Array.isArray(j)
      ? j
      : Array.isArray(j?.data)
        ? j.data
        : [];

    if (DEBUG && page === 1) {
      console.log(`DEBUG ${country}`, rows.length);
    }

    if (!rows.length) break;

    for (const r of rows) {
      events++;
      fatalities += Number(r.fatalities) || 0;
    }

    if (rows.length < PAGE_LIMIT) break;
  }

  return { events, fatalities };
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

  const token = await getToken();

  const counts = await withPool(
    COUNTRIES,
    (c) => fetchCountry(c, token, fromISO, debug),
    CONCURRENCY
  );

  const countries = {};

  for (const c of COUNTRIES) {
    const { events = 0, fatalities = 0 } = counts[c] || {};
    countries[c] = {
      events,
      fatalities,
      level: level(events, fatalities),
    };
  }

  return {
    updated: new Date().toISOString(),
    window_days: WINDOW_DAYS,
    source: "ACLED",
    countries,
  };
}

// ---------------- MOCK ----------------
function mock() {
  const countries = {};
  for (const c of COUNTRIES) {
    const e = Math.floor(Math.random() * 300);
    const f = Math.floor(Math.random() * 120);
    countries[c] = { events: e, fatalities: f, level: level(e, f) };
  }

  return {
    updated: new Date().toISOString(),
    source: "mock",
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

  // API
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

  // FRONTEND
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
  console.log(`🚀 ACLED REAL SERVER rodando em http://localhost:${PORT}`);
});