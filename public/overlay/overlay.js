import { applyOverlayStyle, createCountdown, describeEvent, describeLast, formatClock, formatMinutes } from '../shared/format.js';

const ALERT_MS = 5_000;
const ALERT_EXIT_MS = 450;
const BUMP_MS = 2_400;
const ICONS = { bits: '💎', sub: '⭐', resub: '🔁', gift: '🎁', pix: '💸' };
const BADGES = { idle: 'Em breve', running: 'Subathon', paused: 'Pausado', ended: 'Encerrado' };

const $ = (selector) => document.querySelector(selector);
const overlay = $('.overlay');
const clock = $('.clock');
const alertBox = $('.alert');
const countdown = createCountdown();
const alertQueue = [];
let showingAlert = false;

function renderClock() {
  const { state } = countdown;
  clock.textContent = state?.status === 'ended' ? 'FIM!' : formatClock(countdown.remainingMs());
}

function renderState(state) {
  overlay.dataset.status = state.status;
  $('.badge-text').textContent = BADGES[state.status];
  for (const [kind, last] of Object.entries(state.lastByType)) renderLast(kind, last);
  renderClock();
}

function renderLast(kind, last) {
  const item = $(`.last [data-kind="${kind}"]`);
  if (!item) return;
  const user = item.querySelector('.last-user');
  if (!last) {
    user.textContent = '—';
    item.querySelector('.last-detail').textContent = '';
    return;
  }
  if (item.dataset.at && item.dataset.at !== last.at) restartAnimation(item, 'flash');
  item.dataset.at = last.at;
  user.textContent = last.user; // textContent: nomes de usuário nunca viram HTML
  item.querySelector('.last-detail').textContent = describeLast(kind, last);
}

function restartAnimation(el, className) {
  el.classList.remove(className);
  void el.offsetWidth; // força o navegador a recomeçar a animação
  el.classList.add(className);
}

function showBump(minutes) {
  const bump = Object.assign(document.createElement('div'), { className: 'bump', textContent: `+${formatMinutes(minutes)}` });
  $('.bumps').append(bump);
  setTimeout(() => bump.remove(), BUMP_MS);
  restartAnimation(clock, 'pop');
}

// Alertas em fila: vários eventos seguidos aparecem um de cada vez.
function enqueueAlert(event) {
  alertQueue.push(event);
  if (!showingAlert) nextAlert();
}

function nextAlert() {
  const event = alertQueue.shift();
  if (!event) {
    showingAlert = false;
    return;
  }
  showingAlert = true;
  $('.alert-icon').textContent = ICONS[event.type];
  $('.alert-user').textContent = event.user;
  $('.alert-text').textContent = describeEvent(event);
  $('.alert-time').textContent = event.minutesAdded > 0 ? `+${formatMinutes(event.minutesAdded)}` : '';
  alertBox.classList.remove('leaving');
  alertBox.hidden = false;
  restartAnimation(alertBox, 'alert');

  setTimeout(() => {
    alertBox.classList.add('leaving');
    setTimeout(() => {
      alertBox.hidden = true;
      nextAlert();
    }, ALERT_EXIT_MS);
  }, ALERT_MS);
}

const stream = new EventSource('/api/stream');
stream.addEventListener('state', (e) => {
  countdown.set(JSON.parse(e.data));
  renderState(countdown.state);
});
stream.addEventListener('config', (e) => applyOverlayStyle(document.documentElement, JSON.parse(e.data).overlay));
stream.addEventListener('event', (e) => {
  const event = JSON.parse(e.data);
  if (event.minutesAdded > 0) showBump(event.minutesAdded);
  enqueueAlert(event);
});

setInterval(renderClock, 200);
