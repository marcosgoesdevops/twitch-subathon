import { appendFileSync, closeSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs';
import { basename } from 'node:path';

/** Lê um JSON. Arquivo inexistente → fallback; arquivo corrompido → guarda uma cópia e usa o fallback. */
export function readJson(path, fallback) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch {
    const backup = `${path}.corrompido-${Date.now()}`;
    renameSync(path, backup);
    console.warn(`[aviso] ${basename(path)} estava corrompido. Uma cópia foi salva em ${backup} e os valores padrão foram usados.`);
    return fallback;
  }
}

/**
 * Escreve no .tmp, força para o disco e só então renomeia: se o processo morrer no meio,
 * o arquivo original continua intacto.
 */
export function writeJsonAtomic(path, data) {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, 'w');
  try {
    writeSync(fd, JSON.stringify(data, null, 2));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

/** Histórico em JSON Lines: cada evento é uma linha, então salvar um evento não reescreve o arquivo todo. */
export function appendJsonLine(path, data) {
  appendFileSync(path, JSON.stringify(data) + '\n');
}

export function readJsonLines(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const items = [];
  let skipped = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      items.push(JSON.parse(line));
    } catch {
      skipped++; // geralmente a última linha, cortada por um desligamento no meio da escrita
    }
  }
  if (skipped) console.warn(`[aviso] ${skipped} linha(s) inválida(s) ignorada(s) em ${basename(path)}.`);
  return items;
}
