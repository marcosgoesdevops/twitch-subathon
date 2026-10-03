import { validateClientId } from './config.js';

// As URLs podem ser trocadas por variáveis de ambiente só para testar com a Twitch CLI ou um mock.
const AUTH_URL = process.env.TWITCH_AUTH_URL ?? 'https://id.twitch.tv/oauth2';
const API_URL = process.env.TWITCH_API_URL ?? 'https://api.twitch.tv/helix';
const EVENTSUB_URL = process.env.TWITCH_EVENTSUB_URL ?? 'wss://eventsub.wss.twitch.tv/ws';

const SCOPES = 'bits:read channel:read:subscriptions';
const SUBSCRIPTION_TYPES = ['channel.cheer', 'channel.subscribe', 'channel.subscription.message', 'channel.subscription.gift'];
const ANONYMOUS = 'Anônimo';
const KEEPALIVE_GRACE_MS = 5_000;
const MAX_RETRY_MS = 60_000;
const VALIDATE_EVERY_MS = 60 * 60_000; // a Twitch exige validar o token de hora em hora

const SUBSCRIPTION_LABELS = {
  'channel.cheer': 'bits',
  'channel.subscribe': 'subs',
  'channel.subscription.message': 'resubs',
  'channel.subscription.gift': 'gifts',
};

/**
 * Converte o payload da Twitch no evento que o subathon entende. Devolve null para o que não deve
 * contar: um sub recebido de presente já foi contado no channel.subscription.gift de quem presenteou.
 */
export function normalize(subscriptionType, e) {
  switch (subscriptionType) {
    case 'channel.cheer':
      return { type: 'bits', user: e.is_anonymous ? ANONYMOUS : e.user_name, amount: e.bits, tier: null };
    case 'channel.subscribe':
      return e.is_gift ? null : { type: 'sub', user: e.user_name, amount: 1, tier: e.tier };
    case 'channel.subscription.message':
      return { type: 'resub', user: e.user_name, amount: 1, tier: e.tier };
    case 'channel.subscription.gift':
      return { type: 'gift', user: e.is_anonymous ? ANONYMOUS : e.user_name, amount: e.total, tier: e.tier };
    default:
      return null;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function postForm(url, params) {
  const res = await fetch(url, { method: 'POST', body: new URLSearchParams(params) });
  return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) };
}

/**
 * Login (Device Code Flow) e EventSub por WebSocket.
 * onEvent(evento, messageId) recebe eventos normalizados; onStatus avisa o painel.
 */
export function createTwitch({ config, onEvent, onStatus }) {
  const tw = () => config.get().twitch;
  let status = { state: 'disconnected' };
  let flowId = 0; // cada login novo invalida o anterior
  let socket = null; // conexão ativa
  let pending = null; // conexão nova pedida pela Twitch (session_reconnect), assume após o welcome
  let keepaliveMs = 0;
  let keepaliveTimer = null;
  let retryTimer = null;
  let retryMs = 1_000;
  let validateTimer = null;

  function setStatus(next) {
    status = next;
    onStatus(next);
  }

  function fail(message, err) {
    if (err) console.error(`[twitch] ${message}:`, err.message ?? err);
    setStatus({ state: 'error', message, login: tw().login || undefined });
  }

  // ---------- Login ----------

  async function connect(rawClientId) {
    const clientId = validateClientId(rawClientId);
    stop();
    config.setTwitch({ clientId, accessToken: '', refreshToken: '', userId: '', login: '' });
    const myFlow = ++flowId;

    let device;
    try {
      device = await postForm(`${AUTH_URL}/device`, { client_id: clientId, scopes: SCOPES });
    } catch (err) {
      fail('Não foi possível falar com a Twitch. Verifique sua internet.', err);
      return status;
    }
    if (!device.ok) {
      fail('A Twitch recusou o Client ID. Confira se copiou certo e se o app é do tipo "Público".');
      console.error(`[twitch] /device respondeu ${device.status}: ${device.body.message ?? ''}`);
      return status;
    }

    const { device_code, user_code, verification_uri, interval, expires_in } = device.body;
    setStatus({ state: 'awaiting_code', userCode: user_code, verificationUri: verification_uri, expiresAt: Date.now() + expires_in * 1000 });
    pollForToken(myFlow, clientId, device_code, interval);
    return status;
  }

  async function pollForToken(myFlow, clientId, deviceCode, intervalSeconds) {
    let waitMs = intervalSeconds * 1000;
    while (myFlow === flowId) {
      await sleep(waitMs);
      if (myFlow !== flowId) return;
      let res;
      try {
        res = await postForm(`${AUTH_URL}/token`, {
          client_id: clientId,
          scopes: SCOPES,
          device_code: deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        });
      } catch (err) {
        console.error('[twitch] erro ao consultar a autorização, tentando de novo:', err.message);
        continue;
      }
      if (myFlow !== flowId) return;
      if (res.ok) {
        config.setTwitch({ accessToken: res.body.access_token, refreshToken: res.body.refresh_token });
        await start();
        return;
      }
      const reason = res.body.message;
      if (reason === 'authorization_pending') continue;
      if (reason === 'slow_down') {
        waitMs += 5_000;
        continue;
      }
      fail(reason === 'invalid device code' ? 'O código expirou. Clique em "Conectar" de novo.' : 'A autorização foi recusada. Tente conectar de novo.');
      return;
    }
  }

  async function refresh() {
    const { clientId, refreshToken } = tw();
    const res = await postForm(`${AUTH_URL}/token`, { client_id: clientId, grant_type: 'refresh_token', refresh_token: refreshToken });
    if (!res.ok) {
      config.setTwitch({ accessToken: '', refreshToken: '' });
      throw new Error('LOGIN_EXPIRED');
    }
    config.setTwitch({ accessToken: res.body.access_token, refreshToken: res.body.refresh_token });
  }

  /** Confirma o token (renovando se preciso) e descobre de qual canal ele é. */
  async function validate() {
    let res = await fetch(`${AUTH_URL}/validate`, { headers: { Authorization: `OAuth ${tw().accessToken}` } });
    if (res.status === 401) {
      await refresh();
      res = await fetch(`${AUTH_URL}/validate`, { headers: { Authorization: `OAuth ${tw().accessToken}` } });
    }
    if (!res.ok) throw new Error(`validate respondeu ${res.status}`);
    const body = await res.json();
    config.setTwitch({ userId: body.user_id, login: body.login });
  }

  async function helix(path, init, retried = false) {
    const res = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${tw().accessToken}`, 'Client-Id': tw().clientId, 'Content-Type': 'application/json' },
    });
    if (res.status === 401 && !retried) {
      await refresh();
      return helix(path, init, true);
    }
    return res;
  }

  function handleAuthError(err) {
    if (err.message === 'LOGIN_EXPIRED') {
      stop();
      fail('Seu login da Twitch expirou. Clique em "Conectar" de novo.');
    } else {
      fail('Não foi possível falar com a Twitch. Tentando de novo…', err);
      scheduleReconnect();
    }
  }

  // ---------- EventSub ----------

  async function start() {
    const myFlow = flowId;
    setStatus({ state: 'connecting', login: tw().login || undefined });
    try {
      await validate();
    } catch (err) {
      if (myFlow === flowId) handleAuthError(err);
      return;
    }
    if (myFlow !== flowId) return;
    clearInterval(validateTimer);
    validateTimer = setInterval(() => validate().catch(handleAuthError), VALIDATE_EVERY_MS);
    socket = openSocket(EVENTSUB_URL);
  }

  function openSocket(url) {
    const ws = new WebSocket(url);
    ws.onmessage = (msg) => {
      let data;
      try {
        data = JSON.parse(msg.data);
      } catch {
        return console.error('[twitch] mensagem inválida do EventSub ignorada');
      }
      handleMessage(ws, data).catch((err) => console.error('[twitch] erro ao tratar mensagem:', err.message));
    };
    ws.onclose = (e) => {
      if (ws === pending) pending = null;
      if (ws !== socket) return; // conexão antiga, já substituída ou encerrada de propósito
      console.warn(`[twitch] EventSub desconectou (código ${e.code}).`);
      scheduleReconnect();
    };
    ws.onerror = () => {}; // o onclose vem logo em seguida e cuida da reconexão
    return ws;
  }

  async function handleMessage(ws, { metadata, payload }) {
    if (ws === socket) armKeepalive();
    switch (metadata?.message_type) {
      case 'session_welcome': {
        keepaliveMs = payload.session.keepalive_timeout_seconds * 1000 + KEEPALIVE_GRACE_MS;
        if (ws === pending) {
          // Reconexão pedida pela Twitch: as assinaturas vêm junto, basta trocar a conexão.
          const old = socket;
          socket = ws;
          pending = null;
          old?.close();
          armKeepalive();
          return;
        }
        if (ws !== socket) return ws.close(); // sobra de uma conexão já abandonada
        armKeepalive();
        await subscribeAll(payload.session.id);
        return;
      }
      case 'session_reconnect':
        // Abre a nova antes de fechar a atual, para não perder eventos no meio.
        pending?.close();
        pending = openSocket(payload.session.reconnect_url);
        return;
      case 'notification': {
        const event = normalize(payload.subscription.type, payload.event);
        if (event) onEvent(event, metadata.message_id);
        return;
      }
      case 'revocation':
        console.warn(`[twitch] assinatura ${payload.subscription.type} revogada: ${payload.subscription.status}`);
        if (payload.subscription.status === 'authorization_revoked') {
          stop();
          config.setTwitch({ accessToken: '', refreshToken: '' });
          fail('A permissão do app foi removida na Twitch. Conecte de novo.');
        }
        return;
      default:
        return; // session_keepalive e outras: só servem para o armKeepalive acima
    }
  }

  async function subscribeAll(sessionId) {
    const failed = [];
    for (const type of SUBSCRIPTION_TYPES) {
      try {
        const res = await helix('/eventsub/subscriptions', {
          method: 'POST',
          body: JSON.stringify({ type, version: '1', condition: { broadcaster_user_id: tw().userId }, transport: { method: 'websocket', session_id: sessionId } }),
        });
        if (!res.ok && res.status !== 409) {
          const body = await res.json().catch(() => ({}));
          console.error(`[twitch] não foi possível assinar ${type}: ${res.status} ${body.message ?? ''}`);
          failed.push(SUBSCRIPTION_LABELS[type]);
        }
      } catch (err) {
        if (err.message === 'LOGIN_EXPIRED') return handleAuthError(err);
        console.error(`[twitch] erro ao assinar ${type}:`, err.message);
        failed.push(SUBSCRIPTION_LABELS[type]);
      }
    }
    if (failed.length === SUBSCRIPTION_TYPES.length) {
      fail('A Twitch não liberou nenhum evento do seu canal. Tentando de novo…');
      return scheduleReconnect();
    }
    retryMs = 1_000;
    setStatus({
      state: 'connected',
      login: tw().login,
      warning: failed.length ? `Não foi possível receber: ${failed.join(', ')}. Seu canal precisa ser afiliado ou parceiro.` : undefined,
    });
  }

  function armKeepalive() {
    clearTimeout(keepaliveTimer);
    if (!keepaliveMs) return;
    keepaliveTimer = setTimeout(() => {
      console.warn('[twitch] EventSub ficou em silêncio além do esperado; reconectando.');
      scheduleReconnect();
    }, keepaliveMs);
  }

  function closeSockets() {
    const old = [socket, pending];
    socket = pending = null; // antes do close, para o onclose saber que foi de propósito
    for (const ws of old) ws?.close();
  }

  function scheduleReconnect() {
    closeSockets();
    clearTimeout(keepaliveTimer);
    clearTimeout(retryTimer);
    keepaliveMs = 0;
    if (status.state !== 'error') setStatus({ state: 'reconnecting', login: tw().login || undefined });
    retryTimer = setTimeout(start, retryMs);
    retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
  }

  /** Para tudo (login em andamento, conexão, timers) sem apagar credenciais. */
  function stop() {
    flowId++;
    clearTimeout(retryTimer);
    clearTimeout(keepaliveTimer);
    clearInterval(validateTimer);
    keepaliveMs = 0;
    closeSockets();
  }

  return {
    status: () => status,
    connect,

    async disconnect() {
      stop();
      const { clientId, accessToken } = tw();
      if (accessToken) {
        // Melhor esforço: revoga o token na Twitch; se falhar, ele expira sozinho.
        postForm(`${AUTH_URL}/revoke`, { client_id: clientId, token: accessToken }).catch(() => {});
      }
      config.setTwitch({ accessToken: '', refreshToken: '', userId: '', login: '' });
      setStatus({ state: 'disconnected' });
      return status;
    },

    /** Na inicialização: se já existe login salvo, reconecta sozinho. */
    init() {
      if (tw().accessToken && tw().refreshToken) start();
    },
  };
}
