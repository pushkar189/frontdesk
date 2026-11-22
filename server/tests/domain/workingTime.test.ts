import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  workingMinutesBetween,
  addWorkingMinutes,
  WorkingTimeConfig,
} from '../../src/domain/workingTime';

// Asia/Kolkata = UTC+5:30
// Working hours: 09:30 – 18:30 IST (Mon-Fri)
// 09:30 IST = 04:00 UTC
// 18:30 IST = 13:00 UTC

const TZ = 'Asia/Kolkata';

const CONFIG: WorkingTimeConfig = {
  startHour: 9,
  startMinute: 30,
  endHour: 18,
  endMinute: 30,
  timezone: TZ,
  workdayMinutes: 540,
};

// Fixed holidays for testing: 2024-01-26 (Friday)
const TEST_HOLIDAYS = new Set(['2024-01-26']); // Republic Day
const getHolidays = async () => TEST_HOLIDAYS;
const noHolidays = async () => new Set<string>();

// Helper: IST datetime string → UTC Date
function ist(dateStr: string): Date {
  // dateStr like '2024-01-19 18:00' (IST)
  return new Date(dateStr.replace(' ', 'T') + '+05:30');
}

describe('workingMinutesBetween', () => {
  it('returns 0 when end <= start', async () => {
    const a = ist('2024-01-15 10:00'); // Monday
    const b = ist('2024-01-15 09:00'); // Earlier same day
    expect(await workingMinutesBetween(a, b, CONFIG, noHolidays)).toBe(0);
  });

  it('counts minutes within the same working day', async () => {
    const start = ist('2024-01-15 10:00'); // Monday 10:00 IST
    const end   = ist('2024-01-15 11:00'); // Monday 11:00 IST
    expect(await workingMinutesBetween(start, end, CONFIG, noHolidays)).toBe(60);
  });

  it('a ticket created Friday at 18:00 is NOT late on Saturday or Sunday', async () => {
    // Created Friday 18:00 IST — 30 min before EOD
    const created  = ist('2024-01-19 18:00'); // Friday
    const saturday = ist('2024-01-20 12:00'); // Saturday noon
    const sunday   = ist('2024-01-21 23:59'); // Sunday night

    const minSat = await workingMinutesBetween(created, saturday, CONFIG, noHolidays);
    const minSun = await workingMinutesBetween(created, sunday, CONFIG, noHolidays);

    // Only 30 working minutes elapsed Friday (18:00–18:30)
    expect(minSat).toBe(30);
    expect(minSun).toBe(30);
  });

  it('created on Saturday — clock starts at Monday 09:30', async () => {
    const created = ist('2024-01-20 10:00'); // Saturday
    const monday  = ist('2024-01-22 10:00'); // Monday 10:00 IST (30 min into work)
    const mins = await workingMinutesBetween(created, monday, CONFIG, noHolidays);
    // Saturday and Sunday are skipped; Monday 09:30–10:00 = 30 min
    expect(mins).toBe(30);
  });

  it('created at 3 AM — clock starts at 09:30 that day', async () => {
    const created = ist('2024-01-15 03:00'); // Monday 3 AM IST
    const later   = ist('2024-01-15 10:30'); // Monday 10:30 IST (1 hr into work)
    const mins = await workingMinutesBetween(created, later, CONFIG, noHolidays);
    expect(mins).toBe(60);
  });

  it('a holiday in the middle is skipped', async () => {
    // 2024-01-26 is a Friday holiday in our test set
    // Thursday 2024-01-25 to Monday 2024-01-29
    const start = ist('2024-01-25 09:30'); // Thursday start of day
    const end   = ist('2024-01-29 09:30'); // Monday start of day
    const mins = await workingMinutesBetween(start, end, CONFIG, getHolidays);
    // Thu: 540 min, Fri: 0 (holiday), Sat: 0, Sun: 0, Mon: 0 (not yet started)
    expect(mins).toBe(540);
  });

  it('ranges crossing weekends accumulate correctly', async () => {
    // Monday 09:30 → Wednesday 09:30 = 2 full days = 1080
    const start = ist('2024-01-15 09:30'); // Monday
    const end   = ist('2024-01-17 09:30'); // Wednesday
    const mins = await workingMinutesBetween(start, end, CONFIG, noHolidays);
    expect(mins).toBe(1080);
  });

  it('boundary at exactly 09:30 — start of day counts as 0 elapsed', async () => {
    const start = ist('2024-01-15 09:30'); // Monday exactly at start
    const end   = ist('2024-01-15 09:30'); // Same moment
    expect(await workingMinutesBetween(start, end, CONFIG, noHolidays)).toBe(0);
  });

  it('boundary at exactly 18:30 — full day = 540 min', async () => {
    const start = ist('2024-01-15 09:30'); // Monday
    const end   = ist('2024-01-15 18:30'); // Monday end
    expect(await workingMinutesBetween(start, end, CONFIG, noHolidays)).toBe(540);
  });

  it('after 18:30 — capped at end of day', async () => {
    const start = ist('2024-01-15 09:30'); // Monday
    const end   = ist('2024-01-15 20:00'); // After hours
    // Only counts up to 18:30
    expect(await workingMinutesBetween(start, end, CONFIG, noHolidays)).toBe(540);
  });
});

describe('addWorkingMinutes', () => {
  it('adds minutes within same day', async () => {
    const start = ist('2024-01-15 10:00'); // Monday 10:00
    const result = await addWorkingMinutes(start, 60, CONFIG, noHolidays);
    // Should be Monday 11:00
    const resultIST = result.toLocaleString('en-CA', { timeZone: TZ, hour12: false });
    expect(resultIST).toContain('11:00');
  });

  it('wraps to next working day when minutes exceed current day', async () => {
    const start = ist('2024-01-15 17:00'); // Monday 17:00 — 90 min left in day
    const result = await addWorkingMinutes(start, 120, CONFIG, noHolidays); // 120 min
    // 90 min today (Mon until 18:30) + 30 min Tuesday = Tue 10:00
    const resultIST = result.toLocaleString('en-CA', { timeZone: TZ, hour12: false });
    expect(resultIST).toContain('2024-01-16');
    expect(resultIST).toContain('10:00');
  });

  it('skips weekend when adding minutes that cross Friday EOD', async () => {
    const start = ist('2024-01-19 18:00'); // Friday 18:00 — 30 min left
    const result = await addWorkingMinutes(start, 60, CONFIG, noHolidays);
    // 30 min Fri + 30 min Mon = Mon 10:00
    const resultIST = result.toLocaleString('en-CA', { timeZone: TZ, hour12: false });
    expect(resultIST).toContain('2024-01-22');
    expect(resultIST).toContain('10:00');
  });

  it('skips holidays', async () => {
    // 2024-01-25 (Thursday) 18:00 → add 60 min
    // 30 min Thu + 30 min Mon (Fri holiday, skip weekend)
    const start = ist('2024-01-25 18:00'); // Thursday
    const result = await addWorkingMinutes(start, 60, CONFIG, getHolidays);
    const resultIST = result.toLocaleString('en-CA', { timeZone: TZ, hour12: false });
    expect(resultIST).toContain('2024-01-29'); // Monday (Fri is holiday)
    expect(resultIST).toContain('10:00');
  });

  it('adding 0 minutes returns same time', async () => {
    const start = ist('2024-01-15 10:00');
    const result = await addWorkingMinutes(start, 0, CONFIG, noHolidays);
    expect(result.getTime()).toBe(start.getTime());
  });

  it('adding from Saturday snaps to Monday 09:30 first', async () => {
    const start = ist('2024-01-20 10:00'); // Saturday
    const result = await addWorkingMinutes(start, 30, CONFIG, noHolidays);
    const resultIST = result.toLocaleString('en-CA', { timeZone: TZ, hour12: false });
    // Start snaps to Mon 09:30, then +30 min = Mon 10:00
    expect(resultIST).toContain('2024-01-22');
    expect(resultIST).toContain('10:00');
  });
});
