import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { appendJsonLine, readJson, readJsonLines, writeJsonAtomic } from './store.js';

export const MINUTE_MS = 60_000;
export const EVENT_TYPES = ['bits', 'sub', 'resub', 'gift', 'pix'];
const STATUSES = ['idle', 'running', 'paused', 'ended'];
const TIER_KEYS = { 1000: 't1', 2000: 't2', 3000: 't3' }; // Prime chega como 1000
const MAX_BITS = 1_000_000;
const MAX_GIFTS = 1_000;
const MAX_PIX_CENTAVOS = 100_000_000; // R$ 1 milhão
const MAX_USER_LENGTH = 50;
const MAX_ADJUST_MINUTES = 100_000;
const EVENTS_PAGE_SIZE = 500;

/** Erro com mensagem pronta para mostrar ao streamer. */
export class UserError extends Error {
  status = 400;
}

/** Quantos minutos um evento vale. Função pura: não arredonda e não conhece o estado do timer. */
export function minutesFor(event, rules) {
  if (event.type === 'bits') return (event.amount / rules.bits.per) * rules.bits.minutes;
  if (event.type === 'pix') return (event.amount / 100 / rules.pix.per) * rules.pix.minutes; // amount em centavos
  const tierMinutes = rules.sub[TIER_KEYS[event.tier]];
  if (tierMinutes === undefined) throw new UserError('Tier de sub inválido.');
  return event.type === 'gift' ? event.amount * tierMinutes : tierMinutes;
}

/** Valida e limpa um evento vindo da Twitch ou do simulador. Os dois passam por aqui. */
export function validateEvent(input) {
  if (!input || typeof input !== 'object') throw new UserError('Evento inválido.');
  const { type } = input;
  if (!EVENT_TYPES.includes(type)) throw new UserError('Tipo de evento inválido.');

  const user = typeof input.user === 'string' ? input.user.replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim() : '';
  if (!user || user.length > MAX_USER_LENGTH) throw new UserError('Nome de usuário inválido.');

  if (type === 'bits') {
    return { type, user, amount: integerIn(input.amount, 1, MAX_BITS, 'Quantidade de bits'), tier: null };
  }
  if (type === 'pix') {
    return { type, user, amount: integerIn(input.amount, 1, MAX_PIX_CENTAVOS, 'O valor do Pix (em centavos)'), tier: null };
  }
  const tier = String(input.tier);
  if (!TIER_KEYS[tier]) throw new UserError('Tier inválido. Use 1, 2 ou 3.');
  const amount = type === 'gift' ? integerIn(input.amount, 1, MAX_GIFTS, 'Quantidade de gifts') : 1;
  return { type, user, amount, tier };
}

const isOwnSub = (e) => e.type === 'sub' || e.type === 'resub';

function integerIn(value, min, max, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new UserError(`${label} deve ser um número inteiro entre ${min} e ${max.toLocaleString('pt-BR')}.`);
  }
  return n;
}

/**
 * Estado do subathon. Todas as operações são síncronas: como o Node roda num só processo,
 * cada uma termina antes da próxima começar e o estado nunca fica pela metade.
 */
export function createSubathon({ dataDir, getConfig, emit = () => {}, now = Date.now }) {
  const statePath = join(dataDir, 'state.json');
  const eventsPath = join(dataDir, 'events.jsonl');
  const archiveDir = join(dataDir, 'archive');
  mkdirSync(archiveDir, { recursive: true });

  let state = loadState();
  let events = readJsonLines(eventsPath);
  const seenIds = new Set(events.map((e) => e.id));
  let lastTick = now();

  function initialMs() {
    return getConfig().initialMinutes * MINUTE_MS;
  }

  // Antes de iniciar, remainingMs guarda só o tempo extra (eventos e ajustes); o tempo
  // inicial é somado no "Iniciar". Assim mudar o tempo inicial na configuração vale na hora.
  function idleState() {
    return { status: 'idle', remainingMs: 0, startedAt: null, endedAt: null, lastByType: { bits: null, sub: null, gift: null, pix: null } };
  }

  function loadState() {
    const saved = readJson(statePath, null);
    if (!saved || !STATUSES.includes(saved.status) || !Number.isFinite(saved.remainingMs) || saved.remainingMs < 0) {
      return idleState();
    }
    const loaded = { ...idleState(), ...saved, lastByType: { ...idleState().lastByType, ...saved.lastByType } };
    // O tempo com o programa desligado não conta: volta pausado e o streamer decide quando continuar.
    if (loaded.status === 'running') loaded.status = 'paused';
    return loaded;
  }

  function save() {
    writeJsonAtomic(statePath, state);
  }

  /** Desconta o tempo real decorrido desde a última chamada (sem drift de setInterval). */
  function settle() {
    const t = now();
    const elapsed = t - lastTick;
    lastTick = t;
    if (state.status !== 'running') return;
    state.remainingMs = Math.max(0, state.remainingMs - elapsed);
    if (state.remainingMs === 0) {
      state.status = 'ended';
      state.endedAt = new Date(t).toISOString();
    }
  }

  function snapshot() {
    const remainingMs = state.status === 'idle' ? state.remainingMs + initialMs() : state.remainingMs;
    return { ...state, remainingMs };
  }

  function commit() {
    save();
    const s = snapshot();
    emit('state', s);
    return s;
  }

  function requireStatus(allowed, message) {
    settle();
    if (!allowed.includes(state.status)) {
      // O settle pode ter acabado de encerrar o timer; isso precisa ser salvo e avisado mesmo com erro.
      if (state.status === 'ended') commit();
      throw new UserError(state.status === 'ended' ? 'O subathon já terminou. Finalize para começar um novo.' : message);
    }
  }

  return {
    getState() {
      settle();
      return snapshot();
    },

    /** Chamado a cada segundo pelo servidor. Só salva e avisa quando algo realmente mudou. */
    tick() {
      const before = state.status;
      settle();
      if (state.status === 'running') save();
      else if (before === 'running') commit();
    },

    start() {
      requireStatus(['idle'], 'O timer já foi iniciado.');
      const total = state.remainingMs + initialMs();
      if (total <= 0) throw new UserError('O timer precisa ter algum tempo para começar.');
      Object.assign(state, { status: 'running', remainingMs: total, startedAt: new Date(now()).toISOString() });
      return commit();
    },

    pause() {
      requireStatus(['running'], 'O timer não está rodando.');
      state.status = 'paused';
      return commit();
    },

    resume() {
      requireStatus(['paused'], 'O timer não está pausado.');
      state.status = 'running';
      return commit();
    },

    adjust(minutes) {
      const m = Number(minutes);
      if (!Number.isFinite(m) || m === 0 || Math.abs(m) > MAX_ADJUST_MINUTES) {
        throw new UserError(`Informe um número de minutos diferente de zero, até ${MAX_ADJUST_MINUTES.toLocaleString('pt-BR')}.`);
      }
      requireStatus(['idle', 'running', 'paused'], '');
      const deltaMs = Math.round(m * MINUTE_MS);
      const shown = snapshot().remainingMs;
      // Tirar tempo nunca encerra o subathon: um clique errado não pode acabar com a live.
      if (shown + deltaMs <= 0) throw new UserError('Não dá para remover mais tempo do que o que resta.');
      state.remainingMs += deltaMs;
      return commit();
    },

    /**
     * Registra um evento (real ou simulado) e soma o tempo dele. Depois do fim, o evento ainda
     * entra no histórico, mas com 0 minutos. Devolve null se o id já foi processado.
     */
    apply(input, { id = randomUUID(), simulated = false } = {}) {
      const event = validateEvent(input);
      if (seenIds.has(id)) return null;
      // A Twitch manda channel.subscribe na renovação e channel.subscription.message quando a pessoa
      // compartilha o resub no chat: é a mesma assinatura. Um sub por pessoa por subathon (dura ~30 dias).
      if (!simulated && isOwnSub(event) && events.some((e) => !e.simulated && isOwnSub(e) && e.user === event.user)) return null;
      settle(); // se o tempo zerou agora, o evento já encontra o timer encerrado
      const addedMs = state.status === 'ended' ? 0 : Math.round(minutesFor(event, getConfig().rules) * MINUTE_MS);
      const record = { id, ...event, minutesAdded: addedMs / MINUTE_MS, at: new Date(now()).toISOString(), simulated };

      appendJsonLine(eventsPath, record);
      events.push(record);
      seenIds.add(id);
      state.remainingMs += addedMs;
      const lastKey = event.type === 'resub' ? 'sub' : event.type;
      state.lastByType[lastKey] = { user: event.user, amount: event.amount, tier: event.tier, at: record.at };

      emit('event', record);
      commit();
      return record;
    },

    /** Arquiva o subathon atual e prepara um novo, zerado. */
    finish() {
      settle();
      let archivedTo = null;
      if (state.status !== 'idle' || events.length) {
        const finishedAt = new Date(now()).toISOString();
        archivedTo = join(archiveDir, `subathon-${finishedAt.replace(/[:.]/g, '-')}.json`);
        writeJsonAtomic(archivedTo, { finishedAt, state: snapshot(), events });
      }
      writeFileSync(eventsPath, '');
      events = [];
      // seenIds continua: a Twitch pode reenviar um evento antigo e ele não deve cair no novo subathon.
      state = idleState();
      emit('reset', null);
      return { state: commit(), archivedTo };
    },

    /** Eventos mais recentes primeiro. */
    listEvents(limit = EVENTS_PAGE_SIZE) {
      return { total: events.length, events: events.slice(-limit).reverse() };
    },

    allEvents() {
      return events;
    },

    save,
  };
}
