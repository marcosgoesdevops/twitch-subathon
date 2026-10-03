import { UserError } from './subathon.js';

// O mesmo canal em tempo real que o widget de alertas do PixGG usa no OBS (Pusher, app público).
// Não é API oficial: os nomes abaixo vêm do código do widget e podem mudar sem aviso.
const PUSHER_URL = process.env.PIXGG_PUSHER_URL ?? 'wss://ws-mt1.pusher.com/app/787e05d557a8480c3ee7?protocol=7&client=js&version=7.2.0&flash=false';
const WIDGET_KEY = /^[A-Za-z0-9_-]{6,200}$/;
const ANONYMOUS = 'Anônimo';
const MAX_USER_LENGTH = 50;
const DEFAULT_ACTIVITY_MS = 120_000;
const PONG_TIMEOUT_MS = 30_000;
const MAX_RETRY_MS = 60_000;

/** Aceita o link do widget (`https://api.pixgg.com/?apikey=…`) ou só a chave. */
export function parseWidgetKey(input) {
  let text = typeof input === 'string' ? input.trim() : '';
  if (text.includes('apikey=')) {
    try {
      text = new URL(text.includes('://') ? text : `https://${text}`).searchParams.get('apikey') ?? '';
    } catch {
      text = '';
    }
  }
  if (!WIDGET_KEY.test(text)) {
    throw new UserError('Link ou chave do widget inválido. Copie de novo o link do widget de alertas no PixGG.');
  }
  return text;
}

/**
 * Converte a mensagem do widget no evento do subathon. Devolve null para o que não é doação:
 * o mesmo canal também carrega mensagens de outros widgets do PixGG (meta, PixAthon).
 */
export function normalizeDonation(data) {
  if (!data || typeof data !== 'object') return null;
  const transactionId = data.TransactionId;
  const total = typeof data.TotalAmount === 'string' ? Number(data.TotalAmount) : data.TotalAmount;
  if (transactionId == null || transactionId === '' || typeof total !== 'number' || !Number.isFinite(total) || total <= 0) {
    return null;
  }
  // Centavos inteiros: somar reais em float é como R$ 0,30 vira 0,30000000000000004.
  const centavos = Math.round(total * 100);
  if (centavos < 1) return null;
  // O apelido é digitado por quem doa. Um nome estranho nunca pode fazer a doação ser recusada.
  const nickname = typeof data.DonatorNickname === 'string' ? data.DonatorNickname.replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim().slice(0, MAX_USER_LENGTH).trim() : '';
  return { id: `pixgg:${transactionId}`, event: { type: 'pix', user: nickname || ANONYMOUS, amount: centavos, tier: null } };
}

function parseData(data) {
  if (typeof data !== 'string') return data; // o Pusher manda alguns campos como string JSON e outros não
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/** Conexão com o canal do widget. onEvent(evento, id) recebe doações normalizadas. */
export function createPixgg({ config, onEvent, onStatus }) {
  const widgetKey = () => config.get().pixgg.widgetKey;
  let status = { state: 'disconnected' };
  let socket = null;
  let retryTimer = null;
  let idleTimer = null;
  let pongTimer = null;
  let retryMs = 1_000;
  let activityMs = DEFAULT_ACTIVITY_MS;

  function setStatus(next) {
    status = next;
    onStatus(next);
  }

  function send(ws, event, data) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ event, data }));
  }

  function open() {
    const ws = new WebSocket(PUSHER_URL);
    socket = ws;
    ws.onmessage = (msg) => {
      if (ws === socket) handleMessage(ws, msg.data);
    };
    ws.onclose = (e) => {
      if (ws !== socket) return; // fechada de propósito
      console.warn(`[pixgg] conexão caiu (código ${e.code}).`);
      scheduleReconnect();
    };
    ws.onerror = () => {}; // o onclose vem em seguida e cuida da reconexão
  }

  function handleMessage(ws, raw) {
    const msg = parseData(raw);
    if (!msg) return;
    armIdle();
    switch (msg.event) {
      case 'pusher:connection_established': {
        const info = parseData(msg.data);
        if (info?.activity_timeout) activityMs = info.activity_timeout * 1000;
        armIdle();
        send(ws, 'pusher:subscribe', { channel: widgetKey() });
        return;
      }
      case 'pusher_internal:subscription_succeeded':
        retryMs = 1_000;
        setStatus({ state: 'connected' });
        return;
      case 'pusher:ping':
        send(ws, 'pusher:pong', {});
        return;
      case 'pusher:error':
        handleError(parseData(msg.data));
        return;
      case 'messages':
        handleDonation(parseData(msg.data));
        return;
      default:
        return; // pusher:pong, pause, skip-alert, clear-queue: só controlam o widget
    }
  }

  function handleError(err) {
    console.error(`[pixgg] erro do Pusher ${err?.code ?? '?'}: ${err?.message ?? ''}`);
    // 4000–4099: o servidor recusou de vez (app desativado, protocolo); tentar de novo não resolve.
    if (err?.code >= 4000 && err?.code < 4100) {
      stop();
      setStatus({ state: 'error', message: 'O PixGG recusou a conexão. A integração pode ter mudado; veja se há uma versão nova do programa.' });
    }
  }

  function handleDonation(data) {
    const donation = normalizeDonation(data);
    if (donation) return onEvent(donation.event, donation.id);
    if (data?.TransactionId != null) {
      // Parecia doação mas não deu para ler: o log é o único registro desse dinheiro.
      console.warn(`[pixgg] doação ignorada (valor inválido): transação ${data.TransactionId}, valor ${JSON.stringify(data.TotalAmount)}`);
    }
  }

  /** Sem nenhuma mensagem no tempo combinado, pergunta se a conexão está viva; sem resposta, reconecta. */
  function armIdle() {
    clearTimeout(idleTimer);
    clearTimeout(pongTimer);
    idleTimer = setTimeout(() => {
      send(socket, 'pusher:ping', {});
      pongTimer = setTimeout(() => {
        console.warn('[pixgg] conexão sem resposta; reconectando.');
        scheduleReconnect();
      }, PONG_TIMEOUT_MS);
    }, activityMs);
  }

  function closeSocket() {
    const old = socket;
    socket = null; // antes do close, para o onclose saber que foi de propósito
    old?.close();
  }

  function stop() {
    clearTimeout(retryTimer);
    clearTimeout(idleTimer);
    clearTimeout(pongTimer);
    closeSocket();
  }

  function scheduleReconnect() {
    stop();
    if (status.state !== 'error') setStatus({ state: 'reconnecting' });
    retryTimer = setTimeout(open, retryMs);
    retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
  }

  function start() {
    stop();
    retryMs = 1_000;
    setStatus({ state: 'connecting' });
    open();
  }

  return {
    status: () => status,

    connect(input) {
      config.setPixgg({ widgetKey: parseWidgetKey(input) });
      start();
      return status;
    },

    disconnect() {
      stop();
      config.setPixgg({ widgetKey: '' });
      setStatus({ state: 'disconnected' });
      return status;
    },

    init() {
      if (widgetKey()) start();
    },
  };
}
