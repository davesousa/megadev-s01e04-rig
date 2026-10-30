import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';

const night = '2026-10-28';
const config = {
  adapter: 'shim',
  installed: '2026-10-29T14:06:00+01:00',
  beatEverySeconds: 60,
  runsDir: '',
};
const laneMarker = process.env.LANE_MARKER;

describe('digest routes', () => {
  let dir: string;
  let runsDir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rig-digest-routes-'));
    runsDir = join(dir, 'runs');
    mkdirSync(runsDir);
    config.runsDir = runsDir;
    process.env.LANE_MARKER = 'DIGEST-TEST-LANE';
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (laneMarker === undefined) delete process.env.LANE_MARKER;
    else process.env.LANE_MARKER = laneMarker;
  });

  function write(contents: string) {
    writeFileSync(join(runsDir, `${night}.jsonl`), contents);
  }

  const routes = [
    { name: 'HTML', path: `/digest/${night}` },
    { name: 'JSON', path: `/api/digest/${night}` },
  ];

  it.each(routes)('$name route returns 404 for a missing night', async ({ path }) => {
    const response = await createApp(config).request(path);
    expect(response.status).toBe(404);
  });

  it.each(routes)('$name route renders an empty night', async ({ name, path }) => {
    write('');
    const response = await createApp(config).request(path);
    expect(response.status).toBe(200);
    if (name === 'HTML') {
      expect(response.headers.get('content-type')).toMatch(/^text\/html/);
      const html = await response.text();
      expect(html).toContain('DIGEST-TEST-LANE');
      expect(html).toContain('nothing ran');
      expect(html).not.toMatch(/<script\b/i);
    } else {
      expect(response.headers.get('content-type')).toMatch(/^application\/json/);
      expect(await response.json()).toEqual({
        night, rows: [], malformedLines: 0, counts: { ok: 0, retry: 0, fail: 0 },
      });
    }
  });

  it.each(routes)('$name route skips a malformed line and reports it', async ({ name, path }) => {
    const valid = { at: '2026-10-29T01:30:00+01:00', job: 'one-job', status: 'ok', owner: null };
    write(`${JSON.stringify(valid)}\n{bad json`);
    const response = await createApp(config).request(path);
    expect(response.status).toBe(200);
    if (name === 'HTML') {
      expect(response.headers.get('content-type')).toMatch(/^text\/html/);
      const html = await response.text();
      expect(html).toContain('malformed log lines: 1');
      expect(html).toContain('one-job');
      expect(html).toContain('2026-10-29T01:30:00+01:00');
      expect(html).toContain('—');
      expect(html).not.toMatch(/<script\b/i);
    } else {
      expect(response.headers.get('content-type')).toMatch(/^application\/json/);
      expect(await response.json()).toEqual({
        night,
        rows: [{
          job: 'one-job', owner: null, runs: 1, retries: 0, lastStatus: 'ok', lastError: null,
          firstAt: valid.at, lastAt: valid.at,
        }],
        malformedLines: 1,
        counts: { ok: 1, retry: 0, fail: 0 },
      });
    }
  });

  it('serves matching sorted rows, metadata, offsets and escaped fields as HTML and full JSON', async () => {
    const events = [
      { at: '2026-10-29T05:00:00+05:30', job: '<z & job>', status: 'fail', owner: null, error: '<script>alert("x")</script> & "quoted"' },
      { at: '2026-10-29T00:01:00-04:00', job: 'a-job', status: 'retry', owner: 'rook', error: 'temporary & trouble' },
      { at: '2026-10-29T00:02:00-04:00', job: 'a-job', status: 'retry', owner: 'rook' },
      { at: '2026-10-29T00:03:00-04:00', job: 'a-job', status: 'retry', owner: 'rook' },
      { at: '2026-10-29T00:04:00-04:00', job: 'a-job', status: 'ok', owner: 'rook' },
    ];
    write(`${events.map((event) => JSON.stringify(event)).join('\n')}\nnot-json`);

    const app = createApp(config);
    const [htmlResponse, jsonResponse] = await Promise.all([
      app.request(`/digest/${night}`), app.request(`/api/digest/${night}`),
    ]);
    expect(htmlResponse.status).toBe(200);
    expect(jsonResponse.status).toBe(200);
    expect(htmlResponse.headers.get('content-type')).toMatch(/^text\/html/);
    expect(jsonResponse.headers.get('content-type')).toMatch(/^application\/json/);

    const html = await htmlResponse.text();
    const json = await jsonResponse.json();
    const expectedRows = [
      {
        job: '<z & job>', owner: null, runs: 1, retries: 0, lastStatus: 'fail',
        lastError: '<script>alert("x")</script> & "quoted"',
        firstAt: '2026-10-29T05:00:00+05:30', lastAt: '2026-10-29T05:00:00+05:30',
      },
      {
        job: 'a-job', owner: 'rook', runs: 4, retries: 3, lastStatus: 'ok',
        lastError: 'temporary & trouble', firstAt: '2026-10-29T00:01:00-04:00', lastAt: '2026-10-29T00:04:00-04:00',
      },
    ];
    expect(json).toEqual({
      night, rows: expectedRows, malformedLines: 1, counts: { ok: 1, retry: 3, fail: 1 },
    });

    expect(html).toContain('DIGEST-TEST-LANE');
    expect(html).toContain('malformed log lines: 1');
    expect(html).toContain('a-job');
    expect(html).toContain('rook');
    expect(html).toContain('—');
    expect(html).toContain('2026-10-29T00:01:00-04:00');
    expect(html).toContain('2026-10-29T00:04:00-04:00');
    expect(html).toContain('2026-10-29T05:00:00+05:30');
    expect(html).toContain('high retries');
    expect(html).toContain('· failed');
    expect(html).toContain('&lt;z &amp; job&gt;');
    expect(html).toContain('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &quot;quoted&quot;');
    expect(html).not.toContain('<script>alert');
    expect(html).not.toMatch(/<script\b/i);
    expect(html.indexOf('&lt;z &amp; job&gt;')).toBeLessThan(html.indexOf('a-job'));
    expect(html.indexOf('&lt;script&gt;')).toBeLessThan(html.indexOf('temporary &amp; trouble'));
    expect(html.match(/<tbody>/)?.[0]).toBe('<tbody>');
    expect(html.match(/<tr>/g)).toHaveLength(3);
  });
});
