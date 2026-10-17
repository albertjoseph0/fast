import type { Clock } from "./ports.ts";

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
  iso(): string {
    return this.now().toISOString();
  }
  today(): string {
    return this.iso().slice(0, 10);
  }
}

/** Virtual clock for simulations and tests. Time only moves when advanced. */
export class SimClock implements Clock {
  private ms: number;

  constructor(start: string | Date = "2026-01-05T09:00:00.000Z") {
    this.ms = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.ms);
  }
  iso(): string {
    return this.now().toISOString();
  }
  today(): string {
    return this.iso().slice(0, 10);
  }
  advanceHours(hours: number): void {
    this.ms += hours * 3_600_000;
  }
  advanceDays(days: number): void {
    this.advanceHours(days * 24);
  }
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date.slice(0, 10)}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function hoursBetween(a: string, b: string): number {
  return (new Date(b).getTime() - new Date(a).getTime()) / 3_600_000;
}
