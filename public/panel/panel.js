import { STATUS_LABELS, createCountdown, describeEvent, describeLast, formatClock, formatMinutes } from '../shared/format.js';

const MAX_HISTORY_ROWS = 500;
const TOAST_MS = 4_000;
const OVERLAY_WIDTH = 800;

const STATUS_HINTS = {
  idle: 'Configure as regras, teste com o simulador e clique em Iniciar quando a live começar.',
  running: 'O tempo está correndo. Bits e subs adicionam tempo automaticamente.',
  paused: 'O tempo está parado. Bits e subs continuam somando tempo enquanto isso.',
  ended: 'O tempo acabou! Eventos novos aparecem no histórico, mas não somam tempo. Finalize para arquivar e começar outro.',
};

const PIXGG_PILL = {
  disconnected: 'PixGG desconectado',
  connecting: 'Conectando ao PixGG…',
  reconnecting: 'Reconectando ao PixGG…',
  connected: 'PixGG conectado',
  error: 'Problema no PixGG',
};

const TWITCH_PILL = {
  disconnected: 'Twitch desconectada',
  awaiting_code: 'Aguardando autorização',
  connecting: 'Conectando à Twitch…',
  reconnecting: 'Reconectando à Twitch…',
  error: 'Problema na Twitch',
};

const $ = (id) => document.getElementById(id);
const countdown = createCountdown();
let historyCount = 0;

// ---------- Utilidades ----------

async function api(path, body) {
  const init = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new Error('Sem conexão com o programa. Ele ainda está aberto?');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? 'Algo deu errado. Veja o terminal.');
  return data;
}

function toast(message, type = 'ok') {
  const el = Object.assign(document.createElement('div'), { className: `toast ${type}`, textContent: message });
  document.querySelector('.toasts').append(el);
  setTimeout(() => el.remove(), TOAST_MS);
}

/** Executa uma ação do painel com o botão travado enquanto espera, mostrando sucesso ou erro. */
async function run(button, fn, successMessage) {
  if (button) button.disabled = true;
  try {
    await fn();
    if (successMessage) toast(successMessage);
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    if (button) button.disabled = false;
  }
}

/**
 * Diálogo de confirmação. Com typeWord, o botão só libera depois de digitar a palavra:
 * nem um clique nem um Enter sem querer confirmam.
 */
function confirmDialog({ title, text, ok, typeWord }) {
  const dialog = $('confirm-dialog');
  const input = $('confirm-input');
  const okButton = $('confirm-ok');
  $('confirm-title').textContent = title;
  $('confirm-text').textContent = text;
  okButton.textContent = ok;
  $('confirm-type').hidden = !typeWord;
  $('confirm-word').textContent = typeWord ?? '';
  input.value = '';
  okButton.disabled = Boolean(typeWord);
  input.oninput = () => (okButton.disabled = input.value.trim().toUpperCase() !== typeWord);
  // Sem isso, Enter no campo acionaria o primeiro botão do form (Cancelar).
  input.onkeydown = (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    if (!okButton.disabled) dialog.close('ok');
  };
  dialog.returnValue = '';
  dialog.showModal();
  if (typeWord) input.focus();
  return new Promise((resolve) => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true }));
}

function restartAnimation(el, className) {
  el.classList.remove(className);
  void el.offsetWidth;
  el.classList.add(className);
}

// ---------- Timer ----------

function renderClock() {
  $('clock').textContent = formatClock(countdown.remainingMs());
}

function renderState(state) {
  const previous = countdown.state;
  countdown.set(state);
  const hero = document.querySelector('.hero');
  hero.dataset.status = state.status;
  $('status-label').textContent = STATUS_LABELS[state.status];
  $('status-hint').textContent = STATUS_HINTS[state.status];
  $('btn-start').hidden = state.status !== 'idle';
  $('btn-pause').hidden = state.status !== 'running';
  $('btn-resume').hidden = state.status !== 'paused';
  for (const el of $('adjust-form').elements) el.disabled = state.status === 'ended';
  if (previous && state.remainingMs > previous.remainingMs + 1000) restartAnimation($('clock'), 'pop');
  renderClock();
  renderLast(state.lastByType);
}

function renderLast(lastByType) {
  for (const [kind, last] of Object.entries(lastByType)) {
    const item = document.querySelector(`.last-list [data-kind="${kind}"]`);
    item.querySelector('strong').textContent = last?.user ?? '—';
    item.querySelector('small').textContent = last ? describeLast(kind, last) : '';
  }
}

$('btn-start').addEventListener('click', (e) => run(e.currentTarget, () => api('/api/timer/start', {}), 'Subathon iniciado! Boa live! 🎉'));
$('btn-pause').addEventListener('click', (e) => run(e.currentTarget, () => api('/api/timer/pause', {}), 'Timer pausado.'));
$('btn-resume').addEventListener('click', (e) => run(e.currentTarget, () => api('/api/timer/resume', {}), 'Timer rodando de novo.'));

$('adjust-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const minutes = Number($('adjust-minutes').value);
  const remove = e.submitter?.value === 'remove';
  run(e.submitter, () => api('/api/timer/adjust', { minutes: remove ? -minutes : minutes }), `${remove ? 'Removido' : 'Adicionado'}: ${formatMinutes(minutes)}.`);
});

// Confirmação dupla: finalizar zera o timer da live e não tem volta.
$('btn-finish').addEventListener('click', async (e) => {
  const button = e.currentTarget; // depois do await o evento já não tem currentTarget
  const first = await confirmDialog({
    title: 'Finalizar o subathon?',
    text: 'O timer para, o histórico atual é guardado na pasta data/archive e tudo volta para o começo. Não dá para desfazer.',
    ok: 'Sim, quero finalizar',
  });
  if (!first) return;
  const second = await confirmDialog({
    title: 'Tem certeza mesmo?',
    text: `Faltam ${formatClock(countdown.remainingMs())} no timer. Esse tempo será perdido.`,
    ok: 'Finalizar de vez',
    typeWord: 'FINALIZAR',
  });
  if (second) run(button, () => api('/api/timer/finish', {}), 'Subathon finalizado e arquivado.');
});

// ---------- Histórico ----------

function formatWhen(iso) {
  const date = new Date(iso);
  const time = date.toLocaleTimeString('pt-BR');
  return date.toDateString() === new Date().toDateString() ? time : `${date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} ${time}`;
}

function historyRow(event) {
  const row = document.createElement('tr');
  const cell = (text, className) => {
    const td = Object.assign(document.createElement('td'), { textContent: text });
    if (className) td.className = className;
    row.append(td);
    return td;
  };
  cell(formatWhen(event.at));
  const who = cell(event.user, 'user'); // textContent: nomes de usuário nunca viram HTML
  if (event.simulated) who.append(Object.assign(document.createElement('span'), { className: 'tag', textContent: 'simulado' }));
  cell(describeEvent(event));
  const time = cell(event.minutesAdded > 0 ? `+${formatMinutes(event.minutesAdded)}` : '—', event.minutesAdded > 0 ? 'num' : 'num zero');
  if (!event.minutesAdded) time.title = 'Não somou tempo (o subathon já tinha acabado ou a regra vale 0).';
  return row;
}

function renderHistoryMeta() {
  $('history-count').textContent = historyCount ? `(${historyCount.toLocaleString('pt-BR')})` : '';
  $('history-empty').hidden = historyCount > 0;
}

async function loadHistory() {
  const { total, events } = await api('/api/events');
  historyCount = total;
  $('history-body').replaceChildren(...events.map(historyRow));
  renderHistoryMeta();
}

function addHistory(event) {
  const body = $('history-body');
  const row = historyRow(event);
  row.className = 'new';
  body.prepend(row);
  while (body.rows.length > MAX_HISTORY_ROWS) body.lastElementChild.remove();
  historyCount++;
  renderHistoryMeta();
}

// ---------- Regras e visual ----------

function isEditing(form) {
  return form.contains(document.activeElement);
}

function renderConfig(config) {
  if (!isEditing($('rules-form'))) {
    $('initial-minutes').value = config.initialMinutes;
    $('bits-per').value = config.rules.bits.per;
    $('bits-minutes').value = config.rules.bits.minutes;
    $('sub-t1').value = config.rules.sub.t1;
    $('sub-t2').value = config.rules.sub.t2;
    $('sub-t3').value = config.rules.sub.t3;
    $('pix-per').value = config.rules.pix.per;
    $('pix-minutes').value = config.rules.pix.minutes;
  }
  $('initial-hint').textContent = `(= ${formatMinutes(config.initialMinutes)})`;

  if (!isEditing($('style-form'))) {
    $('primary-color').value = config.overlay.primaryColor;
    $('text-color').value = config.overlay.textColor;
    $('font').replaceChildren(...config.fonts.map((f) => new Option(f, f, false, f === config.overlay.font)));
  }
  if (!$('client-id').value) $('client-id').value = config.twitch.clientId;
}

$('initial-minutes').addEventListener('input', (e) => {
  const minutes = Number(e.target.value);
  $('initial-hint').textContent = minutes > 0 ? `(= ${formatMinutes(minutes)})` : '';
});

$('rules-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const n = (id) => Number($(id).value);
  const body = {
    initialMinutes: n('initial-minutes'),
    rules: {
      bits: { per: n('bits-per'), minutes: n('bits-minutes') },
      sub: { t1: n('sub-t1'), t2: n('sub-t2'), t3: n('sub-t3') },
      pix: { per: n('pix-per'), minutes: n('pix-minutes') },
    },
  };
  run(e.submitter, () => api('/api/config', body), 'Regras salvas.');
});

$('style-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const overlay = { primaryColor: $('primary-color').value, textColor: $('text-color').value, font: $('font').value };
  run(e.submitter, () => api('/api/config', { overlay }), 'Visual do overlay salvo.');
});

const overlayUrl = `http://localhost:${location.port}/overlay/`;
$('overlay-url').value = overlayUrl;
$('btn-copy').addEventListener('click', () =>
  run(null, async () => {
    try {
      await navigator.clipboard.writeText(overlayUrl);
    } catch {
      $('overlay-url').select();
      throw new Error('Não consegui copiar sozinho. O link está selecionado: use Ctrl+C.');
    }
  }, 'Link copiado! Cole no OBS.'),
);

// A prévia é o overlay real em 800 px, reduzido para a largura do card.
const preview = document.querySelector('.preview');
new ResizeObserver(() => {
  preview.querySelector('iframe').style.transform = `scale(${preview.clientWidth / OVERLAY_WIDTH})`;
}).observe(preview);

// ---------- Simulador ----------

const SIMULATOR_AMOUNTS = {
  bits: { label: 'Bits ', min: 1, max: 1_000_000, step: 1, value: 250 },
  gift: { label: 'Quantidade de gifts ', min: 1, max: 1000, step: 1, value: 5 },
  pix: { label: 'Valor (R$) ', min: 0.01, max: 1_000_000, step: 0.01, value: 25 },
};

function updateSimulatorFields() {
  const type = $('sim-type').value;
  const amountLabel = $('sim-amount-label');
  const amount = $('sim-amount');
  amountLabel.hidden = type === 'sub' || type === 'resub';
  amount.disabled = amountLabel.hidden;
  $('sim-tier-label').hidden = type === 'bits' || type === 'pix';
  const field = SIMULATOR_AMOUNTS[type];
  if (!field) return;
  amountLabel.firstChild.textContent = field.label;
  Object.assign(amount, { min: field.min, max: field.max, step: field.step, value: field.value });
}

$('sim-type').addEventListener('change', updateSimulatorFields);
$('simulate-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const type = $('sim-type').value;
  const amount = Number($('sim-amount').value);
  // Pix trafega em centavos, como chega do PixGG.
  const body = { type, user: $('sim-user').value, amount: type === 'pix' ? Math.round(amount * 100) : amount, tier: $('sim-tier').value };
  run(e.submitter, () => api('/api/simulate', body));
});

// ---------- Twitch ----------

function showView(cardId, state) {
  const view = state === 'connecting' || state === 'reconnecting' ? 'busy' : state;
  for (const el of document.querySelectorAll(`#${cardId} [data-view]`)) el.hidden = el.dataset.view !== view;
}

function renderTwitch(status) {
  showView('twitch-card', status.state);

  const pill = $('twitch-pill');
  pill.dataset.state = status.state;
  pill.textContent = status.state === 'connected' ? `Twitch: ${status.login}` : TWITCH_PILL[status.state];

  if (status.state === 'awaiting_code') {
    $('device-code').textContent = status.userCode;
    $('verify-link').href = status.verificationUri;
  }
  if (status.state === 'connected') {
    $('twitch-login').textContent = status.login;
    $('twitch-warning').textContent = status.warning ?? '';
    $('twitch-warning').hidden = !status.warning;
  }
  $('twitch-busy-text').textContent = TWITCH_PILL[status.state] ?? '';
  $('twitch-error').textContent = status.message ?? '';
}

$('twitch-form').addEventListener('submit', (e) => {
  e.preventDefault();
  run(e.submitter, () => api('/api/twitch/connect', { clientId: $('client-id').value }));
});

document.querySelector('[data-action="cancel-twitch"]').addEventListener('click', (e) => run(e.currentTarget, () => api('/api/twitch/disconnect', {})));
document.querySelector('[data-action="reset-twitch"]').addEventListener('click', (e) => run(e.currentTarget, () => api('/api/twitch/disconnect', {})));
document.querySelector('[data-action="disconnect-twitch"]').addEventListener('click', async (e) => {
  const button = e.currentTarget;
  const ok = await confirmDialog({
    title: 'Desconectar da Twitch?',
    text: 'Bits e subs param de entrar no timer até você conectar de novo. O timer em si continua igual.',
    ok: 'Desconectar',
  });
  if (ok) run(button, () => api('/api/twitch/disconnect', {}), 'Twitch desconectada.');
});

// ---------- PixGG ----------

function renderPixgg(status) {
  showView('pixgg-card', status.state);
  const pill = $('pixgg-pill');
  pill.dataset.state = status.state;
  pill.textContent = PIXGG_PILL[status.state];
  $('pixgg-busy-text').textContent = PIXGG_PILL[status.state] ?? '';
  $('pixgg-error').textContent = status.message ?? '';
}

$('pixgg-form').addEventListener('submit', (e) => {
  e.preventDefault();
  run(e.submitter, async () => {
    await api('/api/pixgg/connect', { widgetKey: $('pixgg-key').value });
    $('pixgg-key').value = ''; // o link é pessoal: não fica na tela
  });
});

for (const action of ['cancel-pixgg', 'reset-pixgg']) {
  document.querySelector(`[data-action="${action}"]`).addEventListener('click', (e) => run(e.currentTarget, () => api('/api/pixgg/disconnect', {})));
}
document.querySelector('[data-action="disconnect-pixgg"]').addEventListener('click', async (e) => {
  const button = e.currentTarget;
  const ok = await confirmDialog({
    title: 'Desconectar do PixGG?',
    text: 'Doações Pix param de entrar no timer até você colar o link do widget de novo.',
    ok: 'Desconectar',
  });
  if (ok) run(button, () => api('/api/pixgg/disconnect', {}), 'PixGG desconectado.');
});

// ---------- Tempo real ----------

const stream = new EventSource('/api/stream');
stream.addEventListener('open', () => {
  document.querySelector('.offline').hidden = true;
  loadHistory().catch((err) => toast(err.message, 'error')); // recupera o que chegou enquanto estava desconectado
});
stream.addEventListener('error', () => {
  document.querySelector('.offline').hidden = false;
});
stream.addEventListener('state', (e) => renderState(JSON.parse(e.data)));
stream.addEventListener('config', (e) => renderConfig(JSON.parse(e.data)));
stream.addEventListener('twitch', (e) => renderTwitch(JSON.parse(e.data)));
stream.addEventListener('pixgg', (e) => renderPixgg(JSON.parse(e.data)));
stream.addEventListener('event', (e) => addHistory(JSON.parse(e.data)));
stream.addEventListener('reset', () => loadHistory());

updateSimulatorFields();
setInterval(renderClock, 200);
