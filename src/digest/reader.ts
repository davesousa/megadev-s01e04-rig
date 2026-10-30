import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DigestRow, DigestStatus, ReadNight } from './types.js';

type RunEvent = {
  at: string;
  job: string;
  status: DigestStatus;
  owner: string | null;
  error?: string;
};

function isTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  // Require an explicit zone, real calendar date and valid clock fields. Date.parse
  // alone accepts local times and silently rolls dates such as February 30 forward.
  if (!/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value)) {
    return false;
  }
  const day = value.slice(0, 10);
  const midnight = new Date(`${day}T00:00:00Z`);
  return Number.isFinite(midnight.getTime()) && midnight.toISOString().startsWith(day)
    && Number.isFinite(Date.parse(value));
}

function isRunEvent(value: unknown): value is RunEvent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return 'at' in value && isTimestamp(value.at)
    && 'job' in value && typeof value.job === 'string' && value.job.trim().length > 0
    && 'status' in value && (value.status === 'ok' || value.status === 'retry' || value.status === 'fail')
    && 'owner' in value && (value.owner === null || typeof value.owner === 'string')
    && (!('error' in value) || typeof value.error === 'string');
}

export const readNight: ReadNight = (runsDir, night) => {
  // Validate before doing I/O: route input must never select a path outside runsDir.
  if (night.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/.test(night)) return null;

  let contents: string;
  try {
    contents = readFileSync(join(runsDir, `${night}.jsonl`), 'utf8');
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }

  const rows = new Map<string, DigestRow>();
  const counts = { ok: 0, retry: 0, fail: 0 };
  let malformedLines = 0;
  const lines = contents === '' ? [] : contents.split('\n');
  // A final newline terminates the preceding record; interior blank lines are bad records.
  if (lines.at(-1) === '') lines.pop();
  for (const line of lines) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      malformedLines++;
      continue;
    }
    if (!isRunEvent(event)) {
      malformedLines++;
      continue;
    }

    counts[event.status]++;
    const row = rows.get(event.job);
    if (!row) {
      rows.set(event.job, {
        job: event.job,
        owner: event.owner,
        runs: 1,
        retries: event.status === 'retry' ? 1 : 0,
        lastStatus: event.status,
        lastError: event.error ?? null,
        firstAt: event.at,
        lastAt: event.at,
      });
      continue;
    }
    row.owner = event.owner;
    row.runs++;
    if (event.status === 'retry') row.retries++;
    row.lastStatus = event.status;
    if (event.error !== undefined) row.lastError = event.error;
    const time = Date.parse(event.at);
    if (time < Date.parse(row.firstAt)) row.firstAt = event.at;
    if (time > Date.parse(row.lastAt)) row.lastAt = event.at;
  }

  return {
    night,
    rows: [...rows.values()].sort((a, b) => a.job < b.job ? -1 : a.job > b.job ? 1 : 0),
    malformedLines,
    counts,
  };
};
