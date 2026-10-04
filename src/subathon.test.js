import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { eventsToCsv } from './csv.js';
import { createConfigStore, DEFAULT_CONFIG, validateSettings } from './config.js';
import { MINUTE_MS, createSubathon, minutesFor, validateEvent } from './subathon.js';
import { normalizeDonation, parseWidgetKey } from './pixgg.js';
import { normalize } from './twitch.js';

const RULES = { bits: { per: 100, minutes: 1 }, sub: { t1: 5, t2: 10, t3: 25 }, pix: { per: 10, minutes: 5 } };

/** Subathon num diretório temporário, com relógio controlado pelo teste. */
function setup({ dir = mkdtempSync(join(tmpdir(), 'subathon-')), initialMinutes = 60 } = {}) {
  const clock = { t: 1_700_000_000_000 };
  const emitted = [];
  const config = { initialMinutes, rules: RULES };
  const sub = createSubathon({ dataDir: dir, getConfig: () => config, now: () => clock.t, emit: (name, data) => emitted.push({ name, data }) });
  const advance = (ms) => (clock.t += ms);
  return { sub, dir, clock, advance, emitted, config };
}

const bits = (amount, user = 'fulano') => ({ type: 'bits', user, amount });
const subEvent = (tier, type = 'sub', user = 'ciclano') => ({ type, user, tier });

// ---------- Regras ----------

test('bits: proporcional, sem arredondar', () => {
  assert.equal(minutesFor(validateEvent(bits(100)), RULES), 1);
  assert.equal(minutesFor(validateEvent(bits(250)), RULES), 2.5);
  assert.equal(minutesFor(validateEvent(bits(1)), RULES), 0.01);
  assert.equal(minutesFor(validateEvent(bits(150)), { ...RULES, bits: { per: 100, minutes: 1.5 } }), 2.25);
});

test('bits: 0, negativos e fracionários são rejeitados', () => {
  for (const amount of [0, -100, 2.5, 'abc', null, 1e9]) {
    assert.throws(() => validateEvent(bits(amount)), /bits/);
  }
});

test('subs: cada tier tem seu valor; Prime (1000) vale como T1', () => {
  assert.equal(minutesFor(validateEvent(subEvent('1000')), RULES), 5);
  assert.equal(minutesFor(validateEvent(subEvent('2000')), RULES), 10);
  assert.equal(minutesFor(validateEvent(subEvent('3000')), RULES), 25);
  assert.throws(() => validateEvent(subEvent('4000')), /Tier/);
});

test('resub conta pelo tier', () => {
  assert.equal(minutesFor(validateEvent(subEvent('2000', 'resub')), RULES), 10);
});

test('gift: quantidade × minutos do tier', () => {
  const gift = (amount, tier) => minutesFor(validateEvent({ type: 'gift', user: 'beltrano', amount, tier }), RULES);
  assert.equal(gift(1, '1000'), 5);
  assert.equal(gift(5, '1000'), 25);
  assert.equal(gift(5, '2000'), 50);
  assert.equal(gift(5, '3000'), 125);
});

test('evento inválido: tipo desconhecido, usuário vazio ou gigante', () => {
  assert.throws(() => validateEvent({ type: 'follow', user: 'a', amount: 1 }), /Tipo/);
  assert.throws(() => validateEvent(bits(100, '   ')), /usuário/);
  assert.throws(() => validateEvent(bits(100, 'x'.repeat(51))), /usuário/);
  assert.throws(() => validateEvent(null), /inválido/);
});

// ---------- Normalização da Twitch ----------

test('twitch: sub recebido de presente NÃO conta de novo', () => {
  assert.equal(normalize('channel.subscribe', { user_name: 'presenteado', tier: '1000', is_gift: true }), null);
  assert.deepEqual(normalize('channel.subscribe', { user_name: 'fulano', tier: '1000', is_gift: false }), { type: 'sub', user: 'fulano', amount: 1, tier: '1000' });
});

test('twitch: gift é creditado a quem presenteou; anônimos viram "Anônimo"', () => {
  assert.deepEqual(normalize('channel.subscription.gift', { user_name: 'generoso', total: 5, tier: '2000', is_anonymous: false }), { type: 'gift', user: 'generoso', amount: 5, tier: '2000' });
  assert.equal(normalize('channel.subscription.gift', { user_name: null, total: 1, tier: '1000', is_anonymous: true }).user, 'Anônimo');
  assert.equal(normalize('channel.cheer', { user_name: null, bits: 100, is_anonymous: true }).user, 'Anônimo');
});

test('twitch: resub e cheer', () => {
  assert.deepEqual(normalize('channel.subscription.message', { user_name: 'fiel', tier: '3000', cumulative_months: 12 }), { type: 'resub', user: 'fiel', amount: 1, tier: '3000' });
  assert.deepEqual(normalize('channel.cheer', { user_name: 'fulano', bits: 250, is_anonymous: false }), { type: 'bits', user: 'fulano', amount: 250, tier: null });
  assert.equal(normalize('channel.follow', {}), null);
});

// ---------- Timer ----------

test('timer: antes de iniciar mostra o tempo inicial e acompanha mudanças na configuração', () => {
  const { sub, config } = setup();
  assert.equal(sub.getState().status, 'idle');
  assert.equal(sub.getState().remainingMs, 60 * MINUTE_MS);
  config.initialMinutes = 90;
  assert.equal(sub.getState().remainingMs, 90 * MINUTE_MS);
});

test('timer: iniciar, descontar tempo real, pausar e continuar', () => {
  const { sub, advance } = setup();
  sub.start();
  advance(10_000);
  sub.tick();
  assert.equal(sub.getState().remainingMs, 60 * MINUTE_MS - 10_000);

  sub.pause();
  advance(30_000); // pausado: não desconta
  assert.equal(sub.getState().remainingMs, 60 * MINUTE_MS - 10_000);

  sub.resume();
  advance(5_000);
  assert.equal(sub.getState().remainingMs, 60 * MINUTE_MS - 15_000);
});

test('timer: o desconto usa o tempo real mesmo com ticks atrasados (sem drift)', () => {
  const { sub, advance } = setup();
  sub.start();
  advance(2_700); // um tick que atrasou
  sub.tick();
  advance(300);
  sub.tick();
  assert.equal(sub.getState().remainingMs, 60 * MINUTE_MS - 3_000);
});

test('timer: transições inválidas dão erro claro', () => {
  const { sub } = setup();
  assert.throws(() => sub.pause(), /não está rodando/);
  assert.throws(() => sub.resume(), /não está pausado/);
  sub.start();
  assert.throws(() => sub.start(), /já foi iniciado/);
});

test('timer: ajuste ± e proteção contra zerar por engano', () => {
  const { sub } = setup();
  sub.start();
  sub.adjust(10);
  assert.equal(sub.getState().remainingMs, 70 * MINUTE_MS);
  sub.adjust(-20);
  assert.equal(sub.getState().remainingMs, 50 * MINUTE_MS);
  assert.throws(() => sub.adjust(-50), /remover mais tempo/);
  for (const bad of [0, 'abc', NaN, Infinity, 1e9]) assert.throws(() => sub.adjust(bad), /minutos/);
  assert.equal(sub.getState().remainingMs, 50 * MINUTE_MS);
});

test('timer: chega a zero → ended, remaining 0, e não reabre', () => {
  const { sub, advance, emitted } = setup({ initialMinutes: 1 });
  sub.start();
  advance(MINUTE_MS + 5_000);
  sub.tick();
  const state = sub.getState();
  assert.equal(state.status, 'ended');
  assert.equal(state.remainingMs, 0);
  assert.ok(emitted.some((e) => e.name === 'state' && e.data.status === 'ended'));

  const record = sub.apply(bits(1000));
  assert.equal(record.minutesAdded, 0);
  assert.equal(sub.getState().status, 'ended');
  assert.equal(sub.getState().remainingMs, 0);
  assert.equal(sub.listEvents().total, 1); // continua no histórico

  assert.throws(() => sub.resume(), /já terminou/);
  assert.throws(() => sub.adjust(10), /já terminou/);
  assert.throws(() => sub.start(), /já terminou/);
});

test('timer: evento que chega no mesmo instante em que o tempo zera não reabre', () => {
  const { sub, advance } = setup({ initialMinutes: 1 });
  sub.start();
  advance(MINUTE_MS); // zerou, mas o tick ainda não rodou
  const record = sub.apply(bits(500));
  assert.equal(record.minutesAdded, 0);
  assert.equal(sub.getState().status, 'ended');
});

test('eventos somam tempo e atualizam o último doador por frente', () => {
  const { sub } = setup();
  sub.start();
  sub.apply(bits(250));
  sub.apply({ type: 'gift', user: 'generoso', amount: 5, tier: '2000' });
  sub.apply(subEvent('1000', 'resub', 'fiel'));
  const state = sub.getState();
  assert.equal(state.remainingMs, (60 + 2.5 + 50 + 5) * MINUTE_MS);
  assert.equal(state.lastByType.bits.user, 'fulano');
  assert.equal(state.lastByType.gift.amount, 5);
  assert.equal(state.lastByType.sub.user, 'fiel');
});

test('eventos antes de iniciar entram como tempo extra', () => {
  const { sub } = setup();
  sub.apply(bits(500));
  assert.equal(sub.getState().remainingMs, 65 * MINUTE_MS);
  sub.start();
  assert.equal(sub.getState().remainingMs, 65 * MINUTE_MS);
});

// ---------- Deduplicação ----------

test('resub: channel.subscribe + channel.subscription.message da mesma pessoa contam uma vez', () => {
  const { sub } = setup();
  sub.start();
  assert.ok(sub.apply(subEvent('1000', 'sub', 'fiel'), { id: 'a' }));
  assert.equal(sub.apply(subEvent('1000', 'resub', 'fiel'), { id: 'b' }), null);
  assert.ok(sub.apply(subEvent('1000', 'resub', 'outro'), { id: 'c' }));
  assert.ok(sub.apply(subEvent('1000', 'resub', 'fiel'), { simulated: true })); // simulador não é afetado
  assert.equal(sub.getState().remainingMs, (60 + 5 + 5 + 5) * MINUTE_MS);
});

test('mesmo message_id duas vezes: processa uma vez só (inclusive após reiniciar)', () => {
  const { sub, dir } = setup();
  sub.start();
  assert.ok(sub.apply(bits(100), { id: 'msg-1' }));
  assert.equal(sub.apply(bits(100), { id: 'msg-1' }), null);
  assert.equal(sub.listEvents().total, 1);
  assert.equal(sub.getState().remainingMs, 61 * MINUTE_MS);

  const { sub: reloaded } = setup({ dir });
  assert.equal(reloaded.apply(bits(100), { id: 'msg-1' }), null);
});

// ---------- Persistência e reinicialização ----------

test('reiniciar com timer rodando: volta pausado e não desconta o tempo desligado', () => {
  const { sub, dir, advance } = setup();
  sub.start();
  advance(10_000);
  sub.tick();
  sub.apply(bits(100));

  const { sub: reloaded, advance: later } = setup({ dir });
  later(3_600_000); // uma hora com o programa desligado
  const state = reloaded.getState();
  assert.equal(state.status, 'paused');
  assert.equal(state.remainingMs, 61 * MINUTE_MS - 10_000);
  assert.equal(reloaded.listEvents().total, 1);
  assert.equal(state.lastByType.bits.user, 'fulano');
});

test('primeira execução e arquivos corrompidos não derrubam o programa', () => {
  const dir = mkdtempSync(join(tmpdir(), 'subathon-'));
  writeFileSync(join(dir, 'state.json'), '{ isso não é json');
  writeFileSync(join(dir, 'events.jsonl'), '{"id":"a","type":"bits","user":"x","amount":1,"minutesAdded":0.01}\n{"id":"b","ty');
  const { sub } = setup({ dir });
  assert.equal(sub.getState().status, 'idle');
  assert.equal(sub.listEvents().total, 1); // a linha cortada é ignorada
  assert.ok(readdirSync(dir).some((f) => f.startsWith('state.json.corrompido-')));
});

test('finalizar arquiva tudo e começa um subathon novo', () => {
  const { sub, dir } = setup();
  sub.start();
  sub.apply(bits(100), { id: 'msg-1' });
  const { archivedTo, state } = sub.finish();
  assert.equal(state.status, 'idle');
  assert.equal(sub.listEvents().total, 0);
  const archive = JSON.parse(readFileSync(archivedTo, 'utf8'));
  assert.equal(archive.events.length, 1);
  assert.equal(archive.state.remainingMs, 61 * MINUTE_MS);
  assert.equal(readdirSync(join(dir, 'archive')).length, 1);
  assert.equal(sub.apply(bits(100), { id: 'msg-1' }), null); // reenvio antigo não entra no novo
});

// ---------- Configuração ----------

test('config: cria o arquivo na primeira execução e valida o que vem do painel', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'subathon-')), 'config.json');
  const store = createConfigStore(path);
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), DEFAULT_CONFIG);
  assert.equal(store.publicView().twitch.accessToken, undefined);

  store.update({ initialMinutes: 120 });
  assert.equal(createConfigStore(path).get().initialMinutes, 120);

  assert.throws(() => validateSettings({ initialMinutes: -5 }), /tempo inicial/);
  assert.throws(() => validateSettings({ rules: { bits: { per: 0, minutes: 1 }, sub: RULES.sub } }), /bits/);
  assert.throws(() => validateSettings({ overlay: { primaryColor: 'red;}', textColor: '#fff', font: 'Poppins' } }), /Cor/);
  assert.throws(() => validateSettings({ overlay: { primaryColor: '#000000', textColor: '#ffffff', font: 'Comic"</style>' } }), /Fonte/);
});

test('config: valor inválido salvo à mão volta ao padrão', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'subathon-')), 'config.json');
  writeFileSync(path, JSON.stringify({ initialMinutes: 'muito', rules: RULES }));
  assert.equal(createConfigStore(path).get().initialMinutes, DEFAULT_CONFIG.initialMinutes);
});

// ---------- CSV ----------

test('csv: escapa aspas, ponto e vírgula e bloqueia fórmulas', () => {
  const csv = eventsToCsv([
    { at: '2026-10-03T18:00:00Z', type: 'gift', user: '=HYPERLINK("x"); "oi"', amount: 5, tier: '2000', minutesAdded: 2.5, simulated: true },
  ]);
  assert.ok(csv.startsWith('\uFEFF"Data/hora";'));
  const row = csv.split('\r\n')[1];
  assert.match(row, /;"Gift";"'=HYPERLINK\(""x""\); ""oi""";"5";"2";"2,5";"Sim"$/);
});

// ---------- PixGG ----------

const pixMessage = (fields) => ({ TransactionId: 9876, DonatorNickname: 'doador', DonatorMessage: 'oi', TotalAmount: 25, Currency: 'BRL', ...fields });

test('pixgg: doação vira evento pix em centavos, com id da transação', () => {
  assert.deepEqual(normalizeDonation(pixMessage()), { id: 'pixgg:9876', event: { type: 'pix', user: 'doador', amount: 2500, tier: null } });
  assert.equal(normalizeDonation(pixMessage({ TotalAmount: 25.5 })).event.amount, 2550);
  assert.equal(normalizeDonation(pixMessage({ TotalAmount: 0.1 + 0.2 })).event.amount, 30);
  assert.equal(normalizeDonation(pixMessage({ TotalAmount: '12.34' })).event.amount, 1234);
});

test('pixgg: o que não é doação é ignorado', () => {
  assert.equal(normalizeDonation(pixMessage({ TransactionId: undefined })), null);
  assert.equal(normalizeDonation({ RemainingTime: { IsPaused: false } }), null); // mensagem do widget PixAthon
  for (const TotalAmount of [0, -5, 'abc', null, NaN, Infinity, 0.001]) {
    assert.equal(normalizeDonation(pixMessage({ TotalAmount })), null, String(TotalAmount));
  }
  assert.equal(normalizeDonation(null), null);
});

test('pixgg: apelido vazio vira "Anônimo" e apelido estranho nunca recusa a doação', () => {
  assert.equal(normalizeDonation(pixMessage({ DonatorNickname: '   ' })).event.user, 'Anônimo');
  assert.equal(normalizeDonation(pixMessage({ DonatorNickname: null })).event.user, 'Anônimo');
  const long = normalizeDonation(pixMessage({ DonatorNickname: 'x'.repeat(80) + '\n\u200b' }));
  assert.equal(validateEvent(long.event).user.length, 50);
});

test('pixgg: aceita o link do widget ou só a chave', () => {
  assert.equal(parseWidgetKey('https://api.pixgg.com/?apikey=AbC123-xyz_9'), 'AbC123-xyz_9');
  assert.equal(parseWidgetKey('  api.pixgg.com/?apikey=AbC123xyz  '), 'AbC123xyz');
  assert.equal(parseWidgetKey('AbC123xyz'), 'AbC123xyz');
  for (const bad of ['', 'abc', 'javascript:alert(1)', 'https://api.pixgg.com/', 'chave com espaço', null]) {
    assert.throws(() => parseWidgetKey(bad), /inválido/, String(bad));
  }
});

test('pix: proporcional (R$ 25 com R$ 10 = 5 min → 12,5 min) e valida centavos', () => {
  assert.equal(minutesFor(validateEvent({ type: 'pix', user: 'a', amount: 2500 }), RULES), 12.5);
  assert.equal(minutesFor(validateEvent({ type: 'pix', user: 'a', amount: 1 }), RULES), 0.005);
  assert.throws(() => validateEvent({ type: 'pix', user: 'a', amount: 25.5 }), /Pix/);
});

test('pix: reenvio do alerta pelo PixGG (mesmo TransactionId) conta uma vez só', () => {
  const { sub } = setup();
  sub.start();
  const first = normalizeDonation(pixMessage());
  const replay = normalizeDonation(pixMessage({ ForceToPlay: true }));
  assert.ok(sub.apply(first.event, { id: first.id }));
  assert.equal(sub.apply(replay.event, { id: replay.id }), null);
  assert.equal(sub.getState().remainingMs, (60 + 12.5) * MINUTE_MS);
  assert.equal(sub.getState().lastByType.pix.amount, 2500);
});

test('config: arquivo antigo sem regra de pix mantém bits/subs personalizados', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'subathon-')), 'config.json');
  writeFileSync(path, JSON.stringify({ rules: { bits: { per: 50, minutes: 2 }, sub: { t1: 7, t2: 14, t3: 30 } } }));
  const { rules } = createConfigStore(path).get();
  assert.deepEqual(rules.bits, { per: 50, minutes: 2 });
  assert.equal(rules.sub.t1, 7);
  assert.deepEqual(rules.pix, DEFAULT_CONFIG.rules.pix);
});

test('csv: pix mostra o valor em reais', () => {
  const csv = eventsToCsv([{ at: '2026-10-03T18:00:00Z', type: 'pix', user: 'doador', amount: 2550, tier: null, minutesAdded: 12.75, simulated: false }]);
  assert.match(csv.split('\r\n')[1], /;"Pix";"doador";"25,50";"";"12,75";"Não"$/);
});

test('config: chave do PixGG nunca vai para o navegador', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'subathon-')), 'config.json');
  const store = createConfigStore(path);
  store.setPixgg({ widgetKey: 'segredo123' });
  assert.ok(!JSON.stringify(store.publicView()).includes('segredo123'));
  assert.equal(createConfigStore(path).get().pixgg.widgetKey, 'segredo123');
});
