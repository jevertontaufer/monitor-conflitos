# Monitor de Conflitos Globais — backend de intensidade

Este backend liga a página `monitor-conflitos-globais.html` aos dados de eventos
da **ACLED** (Armed Conflict Location & Event Data), automatizando também a camada
de intensidade dos conflitos — não só o feed de notícias.

Ele faz três coisas:

1. Autentica na ACLED (OAuth2) usando credenciais guardadas no servidor.
2. Soma, por país, os eventos e as mortes dos últimos 30 dias e classifica a
   intensidade (ativo / volátil / latente).
3. Serve a própria página no mesmo endereço — então não há problema de CORS nem
   de abrir o arquivo via `file://`.

## Requisitos

- Node.js 18 ou superior (usa `fetch` nativo; sem bibliotecas externas).
- Uma conta **myACLED** gratuita: https://acleddata.com/user/register
  (registre-se de preferência com e-mail institucional para um nível de acesso maior).

## Passo a passo

1. Coloque na mesma pasta: `server.js`, `package.json`, `.env.example` e
   `monitor-conflitos-globais.html`.

2. **Teste primeiro sem chave** (modo de exemplo), para ver tudo funcionando:

   ```bash
   npm run start:mock
   ```

   Abra http://localhost:8787 — os cartões devem mostrar a tag "ao vivo" com
   números de exemplo. Isso confirma que a ligação página ↔ backend está certa.

3. **Ative os dados reais.** Copie `.env.example` para `.env` e preencha:

   ```
   ACLED_EMAIL=seu-email@instituicao.org
   ACLED_PASSWORD=sua-senha
   ```

   Depois suba normalmente:

   ```bash
   npm start
   ```

   (equivale a `node --env-file=.env server.js`)

   Abra http://localhost:8787. No topo da seção "Mapa dos conflitos" deve aparecer
   "intensidade: ACLED ao vivo · janela 30d · <data/hora>", e os cartões passam a
   refletir eventos e mortes reais dos últimos 30 dias.

## Como a intensidade é classificada

Com base na janela de 30 dias, por foco (somando os países que o compõem):

| Nível    | Critério                                  |
|----------|-------------------------------------------|
| Ativo    | ≥ 150 mortes **ou** ≥ 250 eventos         |
| Volátil  | ≥ 15 mortes **ou** ≥ 40 eventos           |
| Latente  | abaixo disso                              |

Os limiares estão em `server.js` (função `level`) e na página (`liveLevel`) — ajuste
à vontade. A ACLED mede eventos e mortes; ela **não** infere fase diplomática, então
um cessar-fogo recente pode ainda aparecer como "ativo" se a violência dos últimos
30 dias foi alta. Trate a leitura como sinal quantitativo, não como veredito político.

## Endpoints

- `GET /` — a página.
- `GET /intensity` — JSON com a agregação por país (é o que a página consome).
- `GET /health` — checagem rápida (`{ ok: true, mock: <bool> }`).

## Hospedar online

`server.js` roda em qualquer plataforma que aceite Node (Render, Railway, Fly.io,
uma VM, etc.). Em produção:

- Defina `ACLED_EMAIL`, `ACLED_PASSWORD` como variáveis de ambiente (nunca no código).
- Defina `ALLOWED_ORIGIN` com o domínio da sua página, no lugar de `*`.
- Se hospedar a página separada do backend, edite a constante `BACKEND_URL` no
  topo do `<script>` da página, apontando para a URL pública do backend.

## Atribuição

Ao usar dados da ACLED você concorda com a política de atribuição deles.
Cite a fonte (ACLED — acleddata.com) em qualquer material derivado.
