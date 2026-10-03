import { readJson, writeJsonAtomic } from './store.js';
import { UserError } from './subathon.js';

export const FONTS = ['Poppins', 'Inter', 'Montserrat', 'Bebas Neue', 'Bangers', 'Press Start 2P', 'Roboto Mono'];
const MAX_EVENT_MINUTES = 10_080; // uma semana por evento já é absurdo; o limite só barra erro de digitação
const MAX_INITIAL_MINUTES = 100_000;
const COLOR = /^#[0-9a-f]{6}$/i;
const CLIENT_ID = /^[a-z0-9]{1,64}$/i;

export const DEFAULT_CONFIG = {
  port: 3000,
  initialMinutes: 240,
  rules: {
    bits: { per: 100, minutes: 1 },
    sub: { t1: 5, t2: 10, t3: 25 },
    pix: { per: 10, minutes: 5 },
  },
  overlay: { primaryColor: '#9146FF', textColor: '#FFFFFF', font: 'Poppins' },
  twitch: { clientId: '', accessToken: '', refreshToken: '', userId: '', login: '' },
  pixgg: { widgetKey: '' },
};

function numberIn(value, min, max, label, { integer = false } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    const kind = integer ? 'um número inteiro' : 'um número';
    throw new UserError(`${label} deve ser ${kind} entre ${min} e ${max.toLocaleString('pt-BR')}.`);
  }
  return n;
}

/** Valida as configurações editáveis pelo painel. Cada seção é opcional; o que vier precisa estar completo. */
export function validateSettings(input) {
  if (!input || typeof input !== 'object') throw new UserError('Configuração inválida.');
  const out = {};
  if (input.initialMinutes !== undefined) {
    out.initialMinutes = numberIn(input.initialMinutes, 1, MAX_INITIAL_MINUTES, 'O tempo inicial', { integer: true });
  }
  if (input.rules !== undefined) {
    const { bits, sub, pix } = input.rules ?? {};
    out.rules = {
      bits: {
        per: numberIn(bits?.per, 1, 1_000_000, 'A quantidade de bits', { integer: true }),
        minutes: numberIn(bits?.minutes, 0, MAX_EVENT_MINUTES, 'Os minutos por bits'),
      },
      sub: {
        t1: numberIn(sub?.t1, 0, MAX_EVENT_MINUTES, 'Os minutos do Tier 1'),
        t2: numberIn(sub?.t2, 0, MAX_EVENT_MINUTES, 'Os minutos do Tier 2'),
        t3: numberIn(sub?.t3, 0, MAX_EVENT_MINUTES, 'Os minutos do Tier 3'),
      },
      pix: {
        per: numberIn(pix?.per, 0.01, 1_000_000, 'O valor em reais do Pix'),
        minutes: numberIn(pix?.minutes, 0, MAX_EVENT_MINUTES, 'Os minutos por Pix'),
      },
    };
  }
  if (input.overlay !== undefined) {
    const { primaryColor, textColor, font } = input.overlay ?? {};
    if (!COLOR.test(primaryColor) || !COLOR.test(textColor)) throw new UserError('Cor inválida.');
    if (!FONTS.includes(font)) throw new UserError('Fonte inválida.');
    out.overlay = { primaryColor, textColor, font };
  }
  return out;
}

export function validateClientId(clientId) {
  const id = typeof clientId === 'string' ? clientId.trim() : '';
  if (!CLIENT_ID.test(id)) throw new UserError('Client ID inválido. Copie de novo do site da Twitch.');
  return id;
}

/** Junta o arquivo com os padrões; um valor inválido salvo à mão volta ao padrão em vez de quebrar. */
function load(path) {
  const saved = readJson(path, {});
  const config = structuredClone(DEFAULT_CONFIG);
  // Regras novas (ex.: pix) entram com o padrão sem descartar as que o streamer já ajustou.
  if (saved.rules && typeof saved.rules === 'object') saved.rules = { ...DEFAULT_CONFIG.rules, ...saved.rules };
  for (const key of ['initialMinutes', 'rules', 'overlay']) {
    if (saved[key] === undefined) continue;
    try {
      Object.assign(config, validateSettings({ [key]: saved[key] }));
    } catch (err) {
      console.warn(`[aviso] "${key}" em config.json é inválido (${err.message}). Usando o padrão.`);
    }
  }
  if (Number.isInteger(saved.port) && saved.port > 0 && saved.port < 65536) config.port = saved.port;
  for (const section of ['twitch', 'pixgg']) {
    if (!saved[section] || typeof saved[section] !== 'object') continue;
    for (const key of Object.keys(config[section])) {
      if (typeof saved[section][key] === 'string') config[section][key] = saved[section][key];
    }
  }
  return config;
}

export function createConfigStore(path) {
  const config = load(path);
  writeJsonAtomic(path, config); // primeira execução: cria o arquivo para quem quiser editar à mão

  return {
    get: () => config,
    update(input) {
      Object.assign(config, validateSettings(input));
      writeJsonAtomic(path, config);
    },
    setTwitch(fields) {
      Object.assign(config.twitch, fields);
      writeJsonAtomic(path, config);
    },
    setPixgg(fields) {
      Object.assign(config.pixgg, fields);
      writeJsonAtomic(path, config);
    },
    /** O que o navegador pode ver: nunca tokens nem a chave do PixGG (quem tem a chave vê suas doações). */
    publicView() {
      const { initialMinutes, rules, overlay, twitch } = config;
      return { initialMinutes, rules, overlay, fonts: FONTS, twitch: { clientId: twitch.clientId } };
    },
  };
}
