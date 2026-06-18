// ---------------------------------------------------------------------------
// Monitor de Conflitos — backend de intensidade (ACLED)
// Node 18+ (usa fetch nativo). Sem dependências externas.
//
// O que faz:
//  - autentica na ACLED via OAuth2 (password grant) e mantém o token em cache
//  - para cada país monitorado, soma eventos e mortes dos últimos N dias
//  - classifica a intensidade e entrega tudo em JSON com CORS liberado
//  - serve a própria página no mesmo domínio (sem CORS, sem file://)
//
// Rodar:
//   1) copie .env.example para .env e preencha ACLED_EMAIL / ACLED_PASSWORD
//   2) carregue as variáveis e suba o servidor:
//        node --env-file=.env server.js
//      (ou exporte as variáveis no shell antes de "node server.js")
//   3) abra http://localhost:8787
//
// Sem credenciais, ou com ACLED_MOCK=1, ele responde com dados de exemplo,
// para você validar a integração com a página antes de ter a chave real.
// ---------------------------------------------------------------------------

import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT           = parseInt(process.env.PORT || "8787", 10);
const EMAIL          = process.env.ACLED_EMAIL || "";
const PASSWORD       = process.env.ACLED_PASSWORD || "";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const WINDOW_DAYS    = parseInt(process.env.WINDOW_DAYS || "30", 10);
const CACHE_MIN      = parseInt(process.env.CACHE_MIN || "20", 10);
const PAGE_LIMIT     = 1000;
const MAX_PAGES      = 25;
const CONCURRENCY    = 4;
const MOCK           = process.env.ACLED_MOCK === "1" || !EMAIL || !PASSWORD;

const TOKEN_URL = "https://acleddata.com/oauth/token";
const READ_URL  = "https://acleddata.com/api/acled/read";
const PAGE_FILE = "monitor-conflitos-globais.html";

// Países monitorados (nomes como a ACLED os grafa).
const COUNTRIES = [
  "Ukraine","Russia","Sudan","South Sudan","Democratic Republic of Congo",
  "Mali","Burkina Faso","Niger","Haiti","Somalia","Nigeria","Myanmar",
  "Israel","Palestine","Yemen","Syria","Lebanon","Iran","Venezuela",
  "India","Pakistan","Ethiopia","Eritrea","Armenia","Azerbaijan",
  "Serbia","Kosovo","China","Taiwan",
];

let tokenCache = { access: null, exp: 0 };
let dataCache  = { ts: 0, payload: null };

// ---------------------------------------------------------------- auth -----
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
    const txt = await res.text().catch(() => "");
    throw new Error(`Falha na autenticação ACLED (${res.status}): ${txt.slice(0, 200)}`);
  }
  const j = await res.json();
  // renova 5 min antes de expirar, por segurança
  tokenCache = { access: j.access_token, exp: now + (j.expires_in - 300) * 1000 };
  return tokenCache.access;
}

// --------------------------------------------------------------- fetch -----
function isoDaysAgo(days) {
  const d = new Date(Date.now() - days * 86400000);
  return d.toISOString().slice(0, 10);
}

async function fetchCountry(country, token, fromISO, toISO) {
  let events = 0, fatalities = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${READ_URL}?_format=json`
      + `&country=${encodeURIComponent(country)}`
      + `&event_date=${fromISO}|${toISO}&event_date_where=BETWEEN`
      + `&fields=event_date|fatalities`
      + `&limit=${PAGE_LIMIT}&page=${page}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`ACLED read ${country} p${page}: ${res.status}`);
    const j = await res.json();
    const rows = Array.isArray(j) ? j : (j.data || []);
    for (const r of rows) {
      events += 1;
      fatalities += Number(r.fatalities) || 0;
    }
    if (rows.length < PAGE_LIMIT) break;
  }
  return { events, fatalities };
}

async function withPool(items, worker, size) {
  const out = {};
  let i = 0;
  const runners = Array.from({ length: size }, async () => {
    while (i < items.length) {
      const idx = i++;
      const c = items[idx];
      try { out[c] = await worker(c); }
      catch (e) { out[c] = { events: 0, fatalities: 0, error: String(e.message || e) }; }
    }
  });
  await Promise.all(runners);
  return out;
}

// ------------------------------------------------------------ classify -----
function level(events, fatalities) {
  if (fatalities >= 150 || events >= 250) return "active";
  if (fatalities >= 15  || events >= 40)  return "volatile";
  return "latent";
}

// ---------------------------------------------------------- build/mock -----
async function buildIntensity() {
  const fromISO = isoDaysAgo(WINDOW_DAYS);
  const toISO = isoDaysAgo(0);
  const token = await getToken();
  const counts = await withPool(
    COUNTRIES,
    (c) => fetchCountry(c, token, fromISO, toISO),
    CONCURRENCY
  );
  const countries = {};
  for (const c of COUNTRIES) {
    const { events = 0, fatalities = 0 } = counts[c] || {};
    countries[c] = { events, fatalities, level: level(events, fatalities) };
  }
  return {
    updated: new Date().toISOString(),
    window_days: WINDOW_DAYS,
    source: "ACLED",
    attribution: "Dados ACLED (acleddata.com). Uso conforme a política de atribuição da ACLED.",
    countries,
  };
}

function mockIntensity() {
  // valores ilustrativos, só para validar a ligação com a página
  const sample = {
    Ukraine: [2400, 720], Russia: [180, 60], Sudan: [900, 1100],
    "South Sudan": [70, 40], "Democratic Republic of Congo": [520, 480],
    Mali: [210, 260], "Burkina Faso": [240, 380], Niger: [80, 90],
    Haiti: [160, 210], Somalia: [430, 520], Nigeria: [300, 340],
    Myanmar: [610, 430], Israel: [120, 30], Palestine: [340, 280],
    Yemen: [150, 90], Syria: [260, 140], Lebanon: [90, 40],
    Iran: [25, 8], Venezuela: [45, 12], India: [110, 25], Pakistan: [180, 120],
    Ethiopia: [140, 160], Eritrea: [4, 2], Armenia: [6, 3], Azerbaijan: [9, 5],
    Serbia: [3, 0], Kosovo: [2, 0], China: [5, 0], Taiwan: [1, 0],
  };
  const countries = {};
  for (const [c, [events, fatalities]] of Object.entries(sample)) {
    countries[c] = { events, fatalities, level: level(events, fatalities) };
  }
  return {
    updated: new Date().toISOString(),
    window_days: WINDOW_DAYS,
    source: "mock",
    attribution: "Dados de exemplo (mock) — não são reais.",
    countries,
  };
}

async function getPayload() {
  const fresh = Date.now() - dataCache.ts < CACHE_MIN * 60000;
  if (fresh && dataCache.payload) return dataCache.payload;
  const payload = MOCK ? mockIntensity() : await buildIntensity();
  dataCache = { ts: Date.now(), payload };
  return payload;
}

// ----------------------------------------------------------- http srv -----
const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".json": "application/json" };

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, mock: MOCK }));
  }

  if (url.pathname === "/intensity") {
    try {
      const payload = await getPayload();
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      return res.end(JSON.stringify(payload));
    } catch (e) {
      res.writeHead(502, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: String(e.message || e) }));
    }
  }

  // static: serve a página
  const file = url.pathname === "/" || url.pathname === "/index.html"
    ? PAGE_FILE
    : url.pathname.replace(/^\/+/, "");
  if (file.includes("..")) { res.writeHead(403); return res.end("forbidden"); }
  try {
    const buf = await readFile(path.join(__dirname, file));
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    return res.end(buf);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    return res.end("not found");
  }
});

server.listen(PORT, () => {
  console.log(`Monitor backend em http://localhost:${PORT}  (modo: ${MOCK ? "MOCK" : "ACLED ao vivo"})`);
  console.log(`  página:    http://localhost:${PORT}/`);
  console.log(`  intensidade: http://localhost:${PORT}/intensity`);
});
