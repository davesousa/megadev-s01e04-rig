export type DigestStatus = 'ok' | 'retry' | 'fail';

export type DigestRow = {
  job: string;
  // Owner from the job's last valid event, including an explicit null.
  owner: string | null;
  // All valid events for this job; retries counts only status === 'retry'.
  runs: number;
  retries: number;
  lastStatus: DigestStatus;
  // Error from the last event, or null when that event has no error.
  lastError: string | null;
  // Original at strings from the first/last events in file order; keep offsets.
  firstAt: string;
  lastAt: string;
};

// Counts of valid events, not counts of jobs grouped by their final status.
export type DigestCounts = Record<DigestStatus, number>;

export type DigestNight = {
  night: string;
  // One row per job, sorted ascending by job for both HTML and JSON consumers.
  rows: DigestRow[];
  malformedLines: number;
  counts: DigestCounts;
};

// Contract for the future readNight implementation (synchronous, like readStatus).
// Missing file: null. Empty file: a DigestNight with [], zero malformed lines and
// zero counts. Other I/O errors propagate rather than masquerading as a missing night.
export type ReadNight = (runsDir: string, night: string) => DigestNight | null;
