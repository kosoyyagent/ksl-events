// KSL tender events (append-only JSONL) + daily report section.
// emit(event) validates and appends; reportSection(events, day) -> markdown.
import fs from 'node:fs';

const SCHEMAS = {
  listing:           ['listing_id', 'ts'],
  airlock_decision:  ['listing_id', 'decision', 'ts'],
  bid:               ['job_id', 'bid_id', 'price_usdc', 'ts'],
  selection:         ['job_id', 'bid_id', 'ts'],
  award:             ['job_id', 'bid_id', 'ts'],
  delivery:          ['job_id', 'bid_id', 'ts'],
  review:            ['job_id', 'bid_id', 'verdict', 'ts'],
  payment:           ['job_id', 'bid_id', 'amount_usdc', 'tx', 'ts'],
};

export function validateEvent(e) {
  if (!e || typeof e !== 'object') return 'event must be an object';
  if (!SCHEMAS[e.type]) return `unknown event type: ${e.type}`;
  for (const f of SCHEMAS[e.type]) if (e[f] === undefined) return `missing field: ${f}`;
  if (e.type === 'airlock_decision' && !['admit', 'refuse'].includes(e.decision)) return 'bad decision';
  if (e.type === 'review' && !['accepted', 'rejected'].includes(e.verdict)) return 'bad verdict';
  return null;
}

export function makeEmitter(path, { fsync = true } = {}) {
  const fd = fs.openSync(path, 'a');
  return {
    emit(event) {
      const err = validateEvent(event);
      if (err) throw new Error(`invalid event: ${err}`);
      fs.writeSync(fd, JSON.stringify(event) + '\n');
      if (fsync) fs.fsyncSync(fd);
      return event;
    },
    close() { fs.closeSync(fd); },
  };
}
// injectable variant for tests / non-fs environments
export const emit = (sink) => (e) => {
  const err = validateEvent(e);
  if (err) throw new Error(`invalid event: ${err}`);
  sink.push(JSON.stringify(e) + '\n');
  return e;
};

export function reportSection(events, day) {
  const rows = events.filter(e => String(e.ts || '').startsWith(day));
  const count = t => rows.filter(e => e.type === t).length;
  const anomalies = [];
  const bidsWithAirlock = new Set(rows.filter(e => e.type === 'airlock_decision').map(e => e.listing_id));
  for (const e of rows.filter(e => e.type === 'bid'))
    if (![...bidsWithAirlock].some(l => l === e.job_id)) anomalies.push(`bid ${e.bid_id} without an airlock decision`);
  const awarded = new Set(rows.filter(e => e.type === 'award').map(e => e.bid_id));
  for (const e of rows.filter(e => e.type === 'selection'))
    if (!rows.some(a => a.type === 'award' && a.bid_id === e.bid_id)) anomalies.push(`selection ${e.bid_id} without award`);
  const acceptedDelivery = new Set(rows.filter(e => e.type === 'review' && e.verdict === 'accepted').map(e => e.bid_id));
  for (const e of rows.filter(e => e.type === 'payment'))
    if (!acceptedDelivery.has(e.bid_id)) anomalies.push(`payment ${e.bid_id} without an accepted delivery`);
  for (const e of rows.filter(e => e.type === 'delivery'))
    if (!awarded.has(e.bid_id)) anomalies.push(`delivery ${e.bid_id} without an award`);

  const paid = rows.filter(e => e.type === 'payment').reduce((s, e) => s + Number(e.amount_usdc || 0), 0);
  return [
    `## Tender report — ${day}`, '',
    `| step | count |`, `|---|---|`,
    ...Object.keys(SCHEMAS).map(t => `| ${t} | ${count(t)} |`), '',
    `Payments settled: ${paid.toFixed(2)} USDC`, '',
    anomalies.length ? `### Anomalies\n${anomalies.map(a => `- ${a}`).join('\n')}` : 'No anomalies.',
  ].join('\n');
}
