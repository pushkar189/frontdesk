import * as crypto from 'crypto';

export interface WorkingTimeConfig {
  startHour: number;
  startMinute: number;
  endHour: number;
  endMinute: number;
  timezone: string;
  workdayMinutes: number;
}

export type HolidayFetcher = () => Promise<Set<string>>; // 'YYYY-MM-DD' in target tz

const DEFAULT_CONFIG: WorkingTimeConfig = {
  startHour: 9,
  startMinute: 30,
  endHour: 18,
  endMinute: 30,
  timezone: 'Asia/Kolkata',
  workdayMinutes: 540,
};

function toIST(date: Date, tz: string): Date {
  // Returns a Date where getHours/getMinutes/getDay reflect the target timezone
  const str = date.toLocaleString('en-CA', { timeZone: tz, hour12: false });
  // en-CA gives YYYY-MM-DD, HH:MM:SS
  return new Date(str.replace(',', ''));
}

function getLocalParts(date: Date, tz: string) {
  const local = toIST(date, tz);
  return {
    year: local.getFullYear(),
    month: local.getMonth(), // 0-based
    day: local.getDate(),
    dayOfWeek: local.getDay(), // 0=Sun, 6=Sat
    hours: local.getHours(),
    minutes: local.getMinutes(),
    totalMinutes: local.getHours() * 60 + local.getMinutes(),
  };
}

function localDateString(date: Date, tz: string): string {
  return date.toLocaleDateString('en-CA', { timeZone: tz }); // 'YYYY-MM-DD'
}

function isWeekend(dayOfWeek: number): boolean {
  return dayOfWeek === 0 || dayOfWeek === 6;
}

/**
 * Returns whether a UTC date falls on a working day (not weekend, not holiday)
 */
async function isWorkingDay(
  date: Date,
  tz: string,
  holidays: Set<string>
): Promise<boolean> {
  const parts = getLocalParts(date, tz);
  if (isWeekend(parts.dayOfWeek)) return false;
  const dateStr = localDateString(date, tz);
  if (holidays.has(dateStr)) return false;
  return true;
}

/**
 * Working minutes elapsed between two UTC timestamps.
 * start and end must be actual UTC Date objects.
 * Clamps start to working window start if before it.
 * Returns 0 if end <= start.
 */
export async function workingMinutesBetween(
  start: Date,
  end: Date,
  config: WorkingTimeConfig = DEFAULT_CONFIG,
  getHolidays: HolidayFetcher = async () => new Set()
): Promise<number> {
  if (end <= start) return 0;

  const holidays = await getHolidays();
  const { timezone, startHour, startMinute, endHour, endMinute } = config;
  const workStart = startHour * 60 + startMinute; // minutes from midnight
  const workEnd = endHour * 60 + endMinute;

  let total = 0;
  // Walk day by day
  let cursor = new Date(start);

  // Max iteration guard: 10 years of days
  let maxIter = 365 * 10;

  while (cursor < end && maxIter-- > 0) {
    const parts = getLocalParts(cursor, timezone);
    const dateStr = localDateString(cursor, timezone);

    if (!isWeekend(parts.dayOfWeek) && !holidays.has(dateStr)) {
      // This is a working day
      const dayStartUTC = getStartOfWorkdayUTC(cursor, timezone, startHour, startMinute);
      const dayEndUTC = getEndOfWorkdayUTC(cursor, timezone, endHour, endMinute);

      const intervalStart = cursor < dayStartUTC ? dayStartUTC : cursor;
      const intervalEnd = end < dayEndUTC ? end : dayEndUTC;

      if (intervalEnd > intervalStart) {
        total += (intervalEnd.getTime() - intervalStart.getTime()) / 60000;
      }
    }

    // Advance to next calendar day at midnight in target tz
    cursor = nextCalendarDay(cursor, timezone);
  }

  return Math.floor(total);
}

/**
 * Returns start UTC of the working day for a given UTC date (in that tz).
 */
function getStartOfWorkdayUTC(date: Date, tz: string, sh: number, sm: number): Date {
  const dateStr = localDateString(date, tz);
  const timeStr = `${String(sh).padStart(2, '0')}:${String(sm).padStart(2, '0')}:00`;
  return new Date(`${dateStr}T${timeStr}${tzOffset(date, tz)}`);
}

function getEndOfWorkdayUTC(date: Date, tz: string, eh: number, em: number): Date {
  const dateStr = localDateString(date, tz);
  const timeStr = `${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}:00`;
  return new Date(`${dateStr}T${timeStr}${tzOffset(date, tz)}`);
}

/**
 * Returns the UTC offset string for a given date in the given timezone.
 * e.g. '+05:30' for Asia/Kolkata
 */
function tzOffset(date: Date, tz: string): string {
  const utcStr = date.toLocaleString('en-US', { timeZone: 'UTC', timeZoneName: 'short' });
  const localStr = date.toLocaleString('en-US', { timeZone: tz, timeZoneName: 'short' });
  // Use Intl to get offset
  const formatter = new Intl.DateTimeFormat('en', {
    timeZone: tz,
    timeZoneName: 'longOffset',
  });
  const parts = formatter.formatToParts(date);
  const tzPart = parts.find(p => p.type === 'timeZoneName');
  if (tzPart) {
    // "GMT+05:30" → "+05:30"
    return tzPart.value.replace('GMT', '');
  }
  return '+05:30';
}

/**
 * Advance cursor to the beginning of the next calendar day in target tz.
 */
function nextCalendarDay(cursor: Date, tz: string): Date {
  const dateStr = localDateString(cursor, tz);
  const [y, m, d] = dateStr.split('-').map(Number);
  // Next day
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  // We want 00:00:00 local time — convert the next day's midnight in local tz to UTC
  const nextDateStr = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
  const offset = tzOffset(next, tz);
  return new Date(`${nextDateStr}T00:00:00${offset}`);
}

/**
 * Returns the first valid working-window start at or after `from`.
 * Used to snap a timestamp to a working moment.
 */
export async function snapToWorkingWindow(
  from: Date,
  config: WorkingTimeConfig = DEFAULT_CONFIG,
  getHolidays: HolidayFetcher = async () => new Set()
): Promise<Date> {
  const holidays = await getHolidays();
  const { timezone, startHour, startMinute, endHour, endMinute } = config;
  const workEnd = endHour * 60 + endMinute;

  let cursor = new Date(from);
  let maxIter = 365 * 2;

  while (maxIter-- > 0) {
    const parts = getLocalParts(cursor, timezone);
    const dateStr = localDateString(cursor, timezone);

    if (!isWeekend(parts.dayOfWeek) && !holidays.has(dateStr)) {
      const workStart = getStartOfWorkdayUTC(cursor, timezone, startHour, startMinute);
      const workEndUTC = getEndOfWorkdayUTC(cursor, timezone, endHour, endMinute);

      if (cursor < workStart) {
        return workStart;
      }
      if (cursor < workEndUTC) {
        return cursor;
      }
      // Past end of day — go to next day
    }
    cursor = nextCalendarDay(cursor, timezone);
    // Reset to start of that day's working hours
    const nextStart = getStartOfWorkdayUTC(cursor, timezone, startHour, startMinute);
    cursor = nextStart;
  }

  throw new Error('Could not find working window within 2 years');
}

/**
 * Adds `minutes` working minutes to `from` and returns the resulting UTC timestamp.
 */
export async function addWorkingMinutes(
  from: Date,
  minutes: number,
  config: WorkingTimeConfig = DEFAULT_CONFIG,
  getHolidays: HolidayFetcher = async () => new Set()
): Promise<Date> {
  if (minutes <= 0) return from;

  const holidays = await getHolidays();
  const { timezone, startHour, startMinute, endHour, endMinute, workdayMinutes } = config;

  // Start from the first valid working moment
  let cursor = await snapToWorkingWindow(from, config, async () => holidays);
  let remaining = minutes;

  let maxIter = 365 * 10;

  while (remaining > 0 && maxIter-- > 0) {
    const parts = getLocalParts(cursor, timezone);
    const dateStr = localDateString(cursor, timezone);

    if (!isWeekend(parts.dayOfWeek) && !holidays.has(dateStr)) {
      const workEndUTC = getEndOfWorkdayUTC(cursor, timezone, endHour, endMinute);
      const minutesLeftToday =
        (workEndUTC.getTime() - cursor.getTime()) / 60000;

      if (remaining <= minutesLeftToday) {
        return new Date(cursor.getTime() + remaining * 60000);
      }

      remaining -= minutesLeftToday;
    }

    // Move to next working day start
    const nextDayStart = nextCalendarDay(cursor, timezone);
    cursor = getStartOfWorkdayUTC(nextDayStart, timezone, startHour, startMinute);
  }

  throw new Error('addWorkingMinutes: exceeded iteration limit');
}
