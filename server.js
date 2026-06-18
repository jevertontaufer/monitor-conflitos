// ---------------------------------------------------------------------------
// Monitor de Conflitos — DASHBOARD COMPLETO
// API + Frontend no mesmo servidor
// ---------------------------------------------------------------------------

import http from "node:http";

const PORT = process.env.PORT || 8787;

const COUNTRIES = [
  "Ukraine","Russia","Sudan","South Sudan","Democratic Republic of Congo",
  "Mali","Burkina Faso","Niger","Haiti","Somalia","Nigeria","Myanmar",
  "Israel","Palestine","Yemen","Syria","Lebanon","Iran","Venezuela",
  "India","Pakistan","Ethiopia","Eritrea","Armenia","Azerbaijan",
  "Serbia","Kosovo","China","Taiwan",
];

// ---------------- MOCK / SIMULAÇÃO (substitui ACLED se quiser) ----------
function level(events, fatalities) {
  const score = events + fatalities * 4;
  if (score >= 600) return "active";
  if (score >= 180) return "volatile";
  return "latent";
}

function generateData() {
  const countries = {};
  for (const c of COUNTRIES) {
    const events = Math.floor(Math.random() * 300);
    const fatalities = Math.floor(Math.random() * 120);

    countries[c] = {
      events,
      fatalities,
      level: level(events, fatalities),
    };
  }

  return {
    updated: new Date().toISOString(),
    countries,
  };
}

// ---------------- CACHE ----------------
let cache = { ts: 0, data: null };

function getData() {
  const fresh = Date.now() - cache.ts < 10_000;
  if (fresh && cache.data) return cache.data;

  cache = { ts: Date.now(), data: generateData() };
  return cache.data;
}

// ---------------- DASHBOARD HTML ----------------
const html = `
<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<title>Monitor de Conflitos</title>

<style>
body {
  margin:0;
  font-family: Arial;
  background:#0b0f14;
  color:#fff;
}

header {
  padding:20px;
  background:#111827;
  font-size:20px;
  font-weight:bold;
}

.container {
  padding:20px;
}

.grid {
  display:grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap:10px;
}

.card {
  padding:12px;
  border-radius:10px;
  background:#1f2937;
}

.active { border-left:5px solid red; }
.volatile { border-left:5px solid orange; }
.latent { border-left:5px solid green; }

.small { font-size:12px; opacity:0.7; }

#top {
  margin-bottom:20px;
}
</style>
</head>

<body>

<header>🌍 Monitor de Conflitos Globais</header>

<div class="container">

<div id="top">
  <div>Atualizado: <span id="updated">-</span></div>
</div>

<div class="grid" id="grid"></div>

</div>

<script>
async function load() {
  const res = await fetch('/intensity');
  const data = await res.json();

  document.getElementById('updated').innerText = data.updated;

  const entries = Object.entries(data.countries)
    .sort((a,b) => (b[1].events + b[1].fatalities) - (a[1].events + a[1].fatalities));

  const grid = document.getElementById('grid');
  grid.innerHTML = '';

  for (const [country, v] of entries) {
    const div = document.createElement('div');
    div.className = 'card ' + v.level;

    div.innerHTML = \`
      <b>\${country}</b><br/>
      Eventos: \${v.events}<br/>
      Fatalidades: \${v.fatalities}<br/>
      <div class="small">nível: \${v.level}</div>
    \`;

    grid.appendChild(div);
  }
}

load();
setInterval(load, 10000);
</script>

</body>
</html>
`;

// ---------------- SERVER ----------------
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // DASHBOARD NA RAIZ
  if (url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html" });
    return res.end(html);
  }

  // API
  if (url.pathname === "/intensity") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(getData()));
  }

  if (url.pathname === "/health") {
    return res.end(JSON.stringify({ ok: true }));
  }

  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, () => {
  console.log(`🚀 Dashboard rodando em http://localhost:${PORT}`);
});