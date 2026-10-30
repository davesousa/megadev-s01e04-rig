import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readNight } from '../src/digest/reader.js';
import type { DigestRow, ReadNight } from '../src/digest/types.js';

const night = '2026-10-28';
const at = '2026-10-29T01:30:00+01:00';
const event = { at, job: 'task', status: 'ok', owner: 'rook' };
const read: ReadNight = readNight;

describe('supplied run logs (read only)', () => {
  it('aggregates every field, retains recovered errors and counts events for October 28', () => {
    const rows: DigestRow[] = [
      {
        job: 'digest/render', owner: null, runs: 1, retries: 0, lastStatus: 'ok', lastError: null,
        firstAt: '2026-10-29T05:41:09+01:00', lastAt: '2026-10-29T05:41:09+01:00',
      },
      {
        job: 'fixtures/refresh', owner: 'rook', runs: 4, retries: 3, lastStatus: 'ok', lastError: 'upstream 503',
        firstAt: '2026-10-29T01:30:00+01:00', lastAt: '2026-10-29T01:37:00+01:00',
      },
      {
        job: 'lane/sync', owner: 'rook', runs: 8, retries: 1, lastStatus: 'ok', lastError: 'lock held',
        firstAt: '2026-10-28T23:00:06+01:00', lastAt: '2026-10-29T05:00:04+01:00',
      },
      {
        job: 'notes/backup', owner: 'lane-07', runs: 1, retries: 0, lastStatus: 'fail', lastError: 'quota exceeded',
        firstAt: '2026-10-29T04:00:01+01:00', lastAt: '2026-10-29T04:00:01+01:00',
      },
      {
        job: 'rig/rotate-logs', owner: 'lane-07', runs: 1, retries: 0, lastStatus: 'ok', lastError: null,
        firstAt: '2026-10-28T23:00:02+01:00', lastAt: '2026-10-28T23:00:02+01:00',
      },
    ];
    expect(read('runs', night)).toEqual({ night, rows, malformedLines: 1, counts: { ok: 10, retry: 4, fail: 1 } });
    expect(rows.reduce((total, row) => total + row.runs, 0)).toBe(15);
  });

  it('reads the other supplied night without inventing errors or retries', () => {
    const result = read('runs', '2026-10-27');
    expect(result?.counts).toEqual({ ok: 7, retry: 0, fail: 0 });
    expect(result?.malformedLines).toBe(0);
    expect(result?.rows.map((row) => [row.job, row.runs, row.retries, row.lastError])).toEqual([
      ['fixtures/refresh', 1, 0, null], ['lane/sync', 4, 0, null],
      ['notes/backup', 1, 0, null], ['rig/rotate-logs', 1, 0, null],
    ]);
  });
});

describe('readNight with temporary run logs', () => {
  let dir: string;
  let runsDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rig-reader-'));
    runsDir = join(dir, 'runs');
    mkdirSync(runsDir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function write(contents: string) {
    writeFileSync(join(runsDir, `${night}.jsonl`), contents);
  }

  it('distinguishes a missing night from an empty file and an all-bad file', () => {
    expect(read(runsDir, night)).toBeNull();
    expect(read(join(dir, 'absent'), night)).toBeNull();
    write('');
    expect(read(runsDir, night)).toEqual({ night, rows: [], malformedLines: 0, counts: { ok: 0, retry: 0, fail: 0 } });
    write('broken\nnull\n');
    expect(read(runsDir, night)).toEqual({ night, rows: [], malformedLines: 2, counts: { ok: 0, retry: 0, fail: 0 } });
  });

  it('keeps the latest encountered error through recovery, and the latest valid owner/status', () => {
    write([
      { ...event, status: 'retry', error: 'first error' },
      { ...event, status: 'fail', owner: 'new owner', error: 'latest error' },
      { ...event, owner: null },
      { ...event, owner: 42, error: 'invalid record must not replace state' },
    ].map((record) => JSON.stringify(record)).join('\n'));
    expect(read(runsDir, night)).toEqual({
      night, counts: { ok: 1, retry: 1, fail: 1 }, malformedLines: 1,
      rows: [{ job: 'task', owner: null, runs: 3, retries: 1, lastStatus: 'ok', lastError: 'latest error', firstAt: at, lastAt: at }],
    });
  });

  it('uses chronological bounds across offsets but preserves file-order owner, status and error', () => {
    const earliest = '2026-10-29T03:00:00+05:30'; // October 28, 21:30Z
    const latest = '2026-10-28T23:00:00-04:00'; // October 29, 03:00Z
    write([
      { ...event, at: '2026-10-29T00:00:00Z', status: 'fail', error: 'first error' },
      { ...event, at: latest, status: 'retry', error: 'later encountered error' },
      { ...event, at: earliest, owner: null },
      // Ties keep the first encountered spelling, without normalizing its offset.
      { ...event, at: '2026-10-29T03:00:00Z', owner: 'final owner' },
      { ...event, at: '2026-10-28T21:30:00Z', owner: null },
    ].map((record) => JSON.stringify(record)).join('\n'));
    expect(read(runsDir, night)?.rows).toEqual([{
      job: 'task', owner: null, runs: 5, retries: 1, lastStatus: 'ok',
      lastError: 'later encountered error', firstAt: earliest, lastAt: latest,
    }]);
  });

  it('orders fractional-second events without altering their timestamps', () => {
    const firstAt = '2026-10-29T01:30:00.001+01:00';
    const lastAt = '2026-10-29T00:30:00.1Z';
    write([lastAt, firstAt].map((timestamp) => JSON.stringify({ ...event, at: timestamp })).join('\n'));
    expect(read(runsDir, night)?.rows[0]).toMatchObject({ firstAt, lastAt });
  });

  it('validates record shapes and timestamps at the edge, then continues after every bad line', () => {
    const invalid: unknown[] = [
      null, [], 7, 'record', {},
      { job: 'task', status: 'ok', owner: null },
      { ...event, at: null }, { ...event, at: 'yesterday' },
      { ...event, at: '2026-10-29T01:30:00' },
      { ...event, at: '2026-02-30T01:30:00+01:00' },
      { ...event, at: '2026-13-01T01:30:00Z' },
      { ...event, at: '2026-10-29T24:00:00Z' },
      { ...event, at: '2026-10-29T01:60:00Z' },
      { ...event, at: '2026-10-29T01:30:00+25:00' },
      { at, status: 'ok', owner: 'rook' },
      { ...event, job: 1 }, { ...event, job: '  ' },
      { at, job: 'task', owner: 'rook' }, { ...event, status: 'unknown' },
      { at, job: 'task', status: 'ok' }, { ...event, owner: false },
      { ...event, error: null }, { ...event, error: { message: 'oops' } },
    ];
    write([
      JSON.stringify(event), '{unfinished', ...invalid.map((value) => JSON.stringify(value)),
      JSON.stringify({ ...event, owner: null, error: '', extra: 'allowed' }),
    ].join('\n'));
    expect(read(runsDir, night)).toEqual({
      night, counts: { ok: 2, retry: 0, fail: 0 }, malformedLines: invalid.length + 1,
      rows: [{ job: 'task', owner: null, runs: 2, retries: 0, lastStatus: 'ok', lastError: '', firstAt: at, lastAt: at }],
    });
  });

  it('accepts leap days and JSON whitespace, counts interior blanks, and handles CRLF', () => {
    const leap = { ...event, at: '2024-02-29T01:30:00Z' };
    write(`  ${JSON.stringify(leap)}  \r\n\r\n \r\n${JSON.stringify(event)}\r\n`);
    expect(read(runsDir, night)).toMatchObject({ malformedLines: 2, counts: { ok: 2, retry: 0, fail: 0 } });
    expect(read(runsDir, night)?.rows[0]).toMatchObject({ runs: 2, firstAt: leap.at, lastAt: at });
  });

  it('groups unusual job names safely and sorts by job independently of input order', () => {
    write(['z', '__proto__', 'a', 'constructor', 'a'].map((job) => JSON.stringify({ ...event, job })).join('\n'));
    expect(read(runsDir, night)?.rows.map((row) => [row.job, row.runs])).toEqual([
      ['__proto__', 1], ['a', 2], ['constructor', 1], ['z', 1],
    ]);
  });

  it('rejects unsafe night input before attempting file access', () => {
    // If read, this directory would throw EISDIR (or its contents would be treated as a log).
    mkdirSync(join(dir, 'outside.jsonl'));
    const unsafe = ['../outside', '..\\outside', join(dir, 'outside'), '%2e%2e%2foutside',
      '', '.', '2026-10-28/../../outside', '2026-10-28.jsonl', '2026-10-28\0', '2026-10-28\n'];
    for (const value of unsafe) expect(read(runsDir, value)).toBeNull();
    // ENOTDIR would propagate if the invalid name reached the filesystem at all.
    const file = join(dir, 'not-a-directory');
    writeFileSync(file, '');
    expect(read(file, '../outside')).toBeNull();
  });

  it('propagates I/O failures other than a missing file', () => {
    mkdirSync(join(runsDir, `${night}.jsonl`));
    expect(() => read(runsDir, night)).toThrow();
    const file = join(dir, 'not-a-directory');
    writeFileSync(file, '');
    expect(() => read(file, night)).toThrow();
  });
});
