import { createReadStream, mkdirSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConfigStore } from './config.js';
import { eventsToCsv } from './csv.js';
import { createPixgg } from './pixgg.js';
import { createSubathon, UserError } from './subathon.js';
import { createTwitch } from './twitch.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');
const DATA_DIR = resolve(process.env.SUBATHON_DATA_DIR ?? join(ROOT, 'data'));
const HOST = '127.0.0.1'; // só este computador acessa; nada fica exposto na rede
const MAX_BODY_BYTES = 16 * 1024;
const TICK_MS = 1_000;
const SSE_HEARTBEAT_MS = 25_000;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': [
    "default-src 'self'",
    "style-src 'self' https://fonts.googleapis.com",
    'font-src https://fonts.gstatic.com',
    "img-src 'self' data:",
    "connect-src 'self'",
    "frame-ancestors 'self'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; '),
};

// ---------- Inicialização ----------

let config, subathon;
try {
  mkdirSync(DATA_DIR, { recursive: true });
  config = createConfigStore(join(DATA_DIR, 'config.json'));
  subathon = createSubathon({ dataDir: DATA_DIR, getConfig: config.get, emit: broadcast });
} catch (err) {
  console.error(`\n❌ Não foi possível abrir os dados em ${DATA_DIR}.\n   ${err.message}\n`);
  process.exit(1);
}

const PORT = Number(process.env.PORT) || config.get().port;
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);
const ALLOWED_ORIGINS = new Set([...ALLOWED_HOSTS].map((h) => `http://${h}`));

/** Twitch e PixGG entregam aqui o mesmo evento normalizado; o id evita contar duas vezes. */
function receive(event, id) {
  try {
    const record = subathon.apply(event, { id });
    if (record) console.log(`[evento] ${record.type} de ${record.user}: +${record.minutesAdded} min`);
  } catch (err) {
    console.error(`[evento] ${event.type} ignorado (${id}):`, err.message);
  }
}

const twitch = createTwitch({ config, onEvent: receive, onStatus: (status) => broadcast('twitch', status) });
const pixgg = createPixgg({ config, onEvent: receive, onStatus: (status) => broadcast('pixgg', status) });

// ---------- Tempo real (SSE) ----------

const clients = new Set();

function sseMessage(name, data) {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

function broadcast(name, data) {
  const message = sseMessage(name, data);
  for (const res of clients) res.write(message);
}

function openStream(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write('retry: 2000\n\n');
  res.write(sseMessage('config', config.publicView()));
  res.write(sseMessage('state', subathon.getState()));
  res.write(sseMessage('twitch', twitch.status()));
  res.write(sseMessage('pixgg', pixgg.status()));
  clients.add(res);
  req.on('close', () => clients.delete(res));
}

// ---------- API ----------

const routes = {
  'GET /api/state': () => subathon.getState(),
  'GET /api/config': () => config.publicView(),
  'POST /api/config': (body) => {
    config.update(body);
    broadcast('config', config.publicView());
    broadcast('state', subathon.getState()); // o tempo inicial muda o que aparece antes de iniciar
    return config.publicView();
  },
  'POST /api/timer/start': () => subathon.start(),
  'POST /api/timer/pause': () => subathon.pause(),
  'POST /api/timer/resume': () => subathon.resume(),
  'POST /api/timer/adjust': (body) => subathon.adjust(body.minutes),
  'POST /api/timer/finish': () => subathon.finish(),
  'POST /api/simulate': (body) => subathon.apply(body, { simulated: true }),
  'GET /api/events': () => subathon.listEvents(),
  'GET /api/twitch': () => twitch.status(),
  'POST /api/twitch/connect': (body) => twitch.connect(body.clientId),
  'POST /api/twitch/disconnect': () => twitch.disconnect(),
  'GET /api/pixgg': () => pixgg.status(),
  'POST /api/pixgg/connect': (body) => pixgg.connect(body.widgetKey),
  'POST /api/pixgg/disconnect': () => pixgg.disconnect(),
};
const API_PATHS = new Set(Object.keys(routes).map((key) => key.split(' ')[1]));

function httpError(status, message) {
  return Object.assign(new UserError(message), { status });
}

async function readJsonBody(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) {
    throw httpError(415, 'Envie os dados como JSON.');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw httpError(413, 'Dados grandes demais.');
    chunks.push(chunk);
  }
  if (!size) return {};
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw httpError(400, 'JSON inválido.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'Dados inválidos.');
  return body;
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function handleApi(req, res, pathname) {
  const handler = routes[`${req.method} ${pathname}`];
  if (!handler) {
    return sendJson(res, API_PATHS.has(pathname) ? 405 : 404, { error: 'Rota não encontrada.' });
  }
  if (req.method === 'POST') {
    // Impede que um site qualquer aberto no navegador mande comandos para o painel.
    const { origin } = req.headers;
    if (origin && !ALLOWED_ORIGINS.has(origin)) return sendJson(res, 403, { error: 'Origem não permitida.' });
  }
  const body = req.method === 'POST' ? await readJsonBody(req) : {};
  sendJson(res, 200, (await handler(body)) ?? { ok: true });
}

function sendCsv(res) {
  const date = new Date().toISOString().slice(0, 10);
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="subathon-historico-${date}.csv"`,
    'Cache-Control': 'no-store',
  });
  res.end(eventsToCsv(subathon.allEvents()));
}

// ---------- Arquivos do painel e do overlay ----------

function redirect(res, location) {
  res.writeHead(302, { Location: location });
  res.end();
}

function notFound(res) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Página não encontrada.');
}

async function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' });
    return res.end();
  }
  if (pathname === '/') return redirect(res, '/panel/');

  let filePath;
  try {
    filePath = resolve(PUBLIC_DIR, '.' + decodeURIComponent(pathname));
  } catch {
    return notFound(res);
  }
  if (!filePath.startsWith(PUBLIC_DIR + sep)) return notFound(res); // bloqueia ../

  let info = await stat(filePath).catch(() => null);
  if (info?.isDirectory()) {
    if (!pathname.endsWith('/')) return redirect(res, pathname + '/');
    filePath = join(filePath, 'index.html');
    info = await stat(filePath).catch(() => null);
  }
  if (!info?.isFile()) return notFound(res);

  res.writeHead(200, {
    'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': 'no-cache',
    ...SECURITY_HEADERS,
  });
  if (req.method === 'HEAD') return res.end();
  createReadStream(filePath).pipe(res);
}

// ---------- Servidor ----------

async function handle(req, res) {
  // Bloqueia DNS rebinding: só aceita requisições endereçadas a este computador.
  if (!ALLOWED_HOSTS.has(req.headers.host)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(`Acesse por http://localhost:${PORT}`);
  }
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/api/stream' && req.method === 'GET') return openStream(req, res);
  if (pathname === '/api/events.csv' && req.method === 'GET') return sendCsv(res);
  if (pathname.startsWith('/api/')) return handleApi(req, res, pathname);
  return serveStatic(req, res, pathname);
}

const server = createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (!(err instanceof UserError)) console.error('[erro]', err);
    if (res.headersSent) return res.end();
    sendJson(res, err.status ?? 500, { error: err instanceof UserError ? err.message : 'Erro interno. Veja o terminal para detalhes.' });
  });
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ A porta ${PORT} já está em uso.\n   O programa já está aberto em outra janela? Feche-a, ou troque "port" em data/config.json.\n`);
  } else {
    console.error('\n❌ Não foi possível iniciar o servidor:', err.message);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log('\n✅ Subathon Timer rodando!');
  console.log(`   Painel:  http://localhost:${PORT}`);
  console.log(`   Overlay: http://localhost:${PORT}/overlay/  (use no OBS como "Navegador")`);
  console.log('   Para fechar, pressione Ctrl+C nesta janela.\n');
  twitch.init();
  pixgg.init();
});

setInterval(() => {
  try {
    subathon.tick();
  } catch (err) {
    console.error('[erro] não foi possível salvar o timer:', err.message);
  }
}, TICK_MS);
setInterval(() => {
  for (const res of clients) res.write(': ping\n\n'); // mantém a conexão viva no OBS
}, SSE_HEARTBEAT_MS);

function shutdown() {
  try {
    subathon.save();
  } catch (err) {
    console.error('[erro] não foi possível salvar ao fechar:', err.message);
  }
  console.log('\nTimer salvo. Até a próxima!');
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
