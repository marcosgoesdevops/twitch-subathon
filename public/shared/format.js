// Formatação compartilhada entre painel e overlay.

const TIER_NAMES = { 1000: 'Tier 1', 2000: 'Tier 2', 3000: 'Tier 3' };

export const STATUS_LABELS = {
  idle: 'Aguardando início',
  running: 'Timer rodando',
  paused: 'Timer pausado',
  ended: 'Subathon encerrado',
};

// Pesos só onde a fonte tem; pedir um peso inexistente faz o Google Fonts recusar tudo.
const FONT_QUERIES = {
  Poppins: 'Poppins:wght@400;600;800',
  Inter: 'Inter:wght@400;600;800',
  Montserrat: 'Montserrat:wght@400;600;800',
  'Bebas Neue': 'Bebas+Neue',
  Bangers: 'Bangers',
  'Press Start 2P': 'Press+Start+2P',
  'Roboto Mono': 'Roboto+Mono:wght@400;700',
};

/** 93784000 → "26:03:04". Horas passam de 24 de propósito: subathon dura dias. */
export function formatClock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

/** 2.5 → "2min 30s"; 90 → "1h 30min". */
export function formatMinutes(minutes) {
  const totalSeconds = Math.round(minutes * 60);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const parts = [];
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}min`);
  if (s) parts.push(`${s}s`);
  return parts.join(' ') || '0min';
}

/** 2550 → "R$ 25,50". */
export function formatBRL(centavos) {
  return (centavos / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

/** Detalhe curto do último apoiador de cada frente: "250 bits", "5× Tier 2", "R$ 25,00". */
export function describeLast(kind, last) {
  if (kind === 'bits') return `${last.amount.toLocaleString('pt-BR')} bits`;
  if (kind === 'gift') return `${last.amount}× ${tierName(last.tier)}`;
  if (kind === 'pix') return formatBRL(last.amount);
  return tierName(last.tier);
}

export function tierName(tier) {
  return TIER_NAMES[tier] ?? '';
}

/** Frase do evento, sem o nome: "enviou 250 bits", "presenteou 5 subs Tier 2". */
export function describeEvent(e) {
  switch (e.type) {
    case 'bits':
      return `enviou ${e.amount.toLocaleString('pt-BR')} bits`;
    case 'sub':
      return `se inscreveu (${tierName(e.tier)})`;
    case 'resub':
      return `renovou o sub (${tierName(e.tier)})`;
    case 'gift':
      return `presenteou ${e.amount} ${e.amount === 1 ? 'sub' : 'subs'} (${tierName(e.tier)})`;
    case 'pix':
      return `doou ${formatBRL(e.amount)} no Pix`;
    default:
      return '';
  }
}

/** Carrega a fonte escolhida do Google Fonts (se estiver sem internet, cai na fonte padrão). */
export function applyOverlayStyle(root, { primaryColor, textColor, font }) {
  root.style.setProperty('--primary', primaryColor);
  root.style.setProperty('--text', textColor);
  root.style.setProperty('--font', `"${font}"`);
  const query = FONT_QUERIES[font];
  if (!query) return;
  let link = document.getElementById('overlay-font');
  if (!link) {
    link = Object.assign(document.createElement('link'), { id: 'overlay-font', rel: 'stylesheet' });
    document.head.append(link);
  }
  link.href = `https://fonts.googleapis.com/css2?family=${query}&display=swap`;
}

/**
 * Conta o tempo localmente entre as mensagens do servidor, que só envia o estado quando
 * algo muda: o relógio fica suave sem ninguém ficar perguntando ao servidor.
 */
export function createCountdown() {
  let state = null;
  let receivedAt = 0;
  return {
    set(next) {
      state = next;
      receivedAt = performance.now();
    },
    get state() {
      return state;
    },
    remainingMs() {
      if (!state) return 0;
      const elapsed = state.status === 'running' ? performance.now() - receivedAt : 0;
      return Math.max(0, state.remainingMs - elapsed);
    },
  };
}
