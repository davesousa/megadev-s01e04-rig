export type DigestStatus = 'ok' | 'retry' | 'fail';

export type DigestRow = {
  job: string;
  // Owner from the job's last valid event in file order, including an explicit null.
  owner: string | null;
  // All valid events for this job; retries counts only status === 'retry'.
  runs: number;
  retries: number;
  // Status from the job's last valid event in file order.
  lastStatus: DigestStatus;
  // Latest error encountered in file order; recovery does not clear it. Null if none.
  lastError: string | null;
  // Chronological bounds as original at strings, keeping offsets; first seen wins ties.
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

// Synchronous, like readStatus. Unsafe/non-YYYY-MM-DD night input returns null.
// Missing file: null. Empty file: a DigestNight with [], zero malformed lines and
// zero counts. Other I/O errors propagate rather than masquerading as a missing night.
export type ReadNight = (runsDir: string, night: string) => DigestNight | null;
