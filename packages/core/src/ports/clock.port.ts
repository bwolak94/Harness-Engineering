export interface ClockPort {
  /** Returns current epoch time in milliseconds. */
  now(): number;

  /** Returns current time as an ISO 8601 string. */
  nowIso(): string;
}

/** Real-time wall clock. */
export class WallClock implements ClockPort {
  now(): number {
    return Date.now();
  }

  nowIso(): string {
    return new Date().toISOString();
  }
}
