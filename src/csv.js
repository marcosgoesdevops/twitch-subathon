const TYPE_LABELS = { bits: 'Bits', sub: 'Sub', resub: 'Resub', gift: 'Gift', pix: 'Pix' };
const TIER_LABELS = { 1000: '1', 2000: '2', 3000: '3' };
const HEADER = ['Data/hora', 'Tipo', 'Usuário', 'Quantidade', 'Tier', 'Minutos adicionados', 'Simulado'];

/**
 * Sempre entre aspas, e com apóstrofo antes de =, +, -, @: sem isso o Excel executaria um nome
 * de usuário como fórmula (CSV injection).
 */
function cell(value) {
  let text = value == null ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * CSV no formato que o Excel em português abre direto: separador ";", vírgula decimal
 * e BOM para os acentos aparecerem certo.
 */
export function eventsToCsv(events) {
  const rows = events.map((e) => [
    new Date(e.at).toLocaleString('pt-BR'),
    TYPE_LABELS[e.type] ?? e.type,
    e.user,
    e.type === 'pix' ? (e.amount / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : e.amount, // Pix: reais
    TIER_LABELS[e.tier] ?? '',
    e.minutesAdded.toLocaleString('pt-BR', { maximumFractionDigits: 2 }),
    e.simulated ? 'Sim' : 'Não',
  ]);
  return '\uFEFF' + [HEADER, ...rows].map((row) => row.map(cell).join(';')).join('\r\n') + '\r\n';
}
