import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeEmitter, emit, reportSection, validateEvent } from './index.mjs';

const D = '2026-10-23';
const ts = h => `${D}T${h}:00:00Z`;
const log = [
  { type: 'listing', listing_id: 'L1', ts: ts('01') },
  { type: 'airlock_decision', listing_id: 'J1', decision: 'admit', ts: ts('02') },
  { type: 'bid', job_id: 'J1', bid_id: 'B1', price_usdc: 50, ts: ts('03') },
  { type: 'selection', job_id: 'J1', bid_id: 'B1', ts: ts('04') },
  { type: 'award', job_id: 'J1', bid_id: 'B1', ts: ts('05') },
  { type: 'delivery', job_id: 'J1', bid_id: 'B1', ts: ts('06') },
  { type: 'review', job_id: 'J1', bid_id: 'B1', verdict: 'accepted', ts: ts('07') },
  { type: 'payment', job_id: 'J1', bid_id: 'B1', amount_usdc: 50, tx: '0x1', ts: ts('08') },
];

test('emit validates and appends JSONL', () => {
  const p = path.join(os.tmpdir(), `ksl-${Date.now()}.jsonl`);
  const e = makeEmitter(p);
  e.emit(log[0]); e.emit(log[2]); e.close();
  const lines = fs.readFileSync(p, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[0]).type, 'listing');
  fs.unlinkSync(p);
});

test('emit rejects invalid events before writing', () => {
  const p = path.join(os.tmpdir(), `ksl2-${Date.now()}.jsonl`);
  const e = makeEmitter(p);
  assert.throws(() => e.emit({ type: 'bid', job_id: 'J1', ts: ts('01') }), /missing field: bid_id/);
  assert.throws(() => e.emit({ type: 'nope', ts: ts('01') }), /unknown event type/);
  assert.throws(() => e.emit({ type: 'airlock_decision', listing_id: 'L', decision: 'maybe', ts: ts('01') }), /bad decision/);
  e.close();
  assert.equal(fs.readFileSync(p, 'utf8'), '');
  fs.unlinkSync(p);
});

test('reportSection counts each step and totals payments', () => {
  const md = reportSection(log, D);
  for (const t of Object.keys(log.reduce((m, e) => (m[e.type] = 1, m), {})))
    assert.match(md, new RegExp(`\\| ${t} \\| \\d+ \\|`));
  assert.match(md, /Payments settled: 50\.00 USDC/);
  assert.match(md, /No anomalies/);
});

test('anomalies flagged', () => {
  const messy = [
    { type: 'bid', job_id: 'JX', bid_id: 'BX', price_usdc: 5, ts: ts('03') },          // no airlock
    { type: 'delivery', job_id: 'JY', bid_id: 'BY', ts: ts('06') },                     // no award
    { type: 'payment', job_id: 'JZ', bid_id: 'BZ', amount_usdc: 9, tx: '0x2', ts: ts('08') }, // no accepted review
  ];
  const md = reportSection(messy, D);
  assert.match(md, /bid BX without an airlock decision/);
  assert.match(md, /delivery BY without an award/);
  assert.match(md, /payment BZ without an accepted delivery/);
});

test('day filter isolates the window', () => {
  const md = reportSection([...log, { ...log[0], ts: '2026-10-24T01:00:00Z' }], D);
  assert.match(md, /\| listing \| 1 \|/);
});

test('injectable emit for non-fs sinks', () => {
  const sink = [];
  emit(sink)(log[0]);
  assert.match(sink[0], /"type":"listing"/);
});
