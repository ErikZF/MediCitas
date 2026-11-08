import assert from 'node:assert/strict';
import { describe, test } from 'vitest';
import {
  availableSlots,
  AvailabilityInputError,
  daysInRange,
  freeWindows,
  MAX_RANGE_DAYS,
  mergeIntervals,
  slotsFromWindows,
  subtractIntervals,
  type DayScheduleInput,
} from '../../domain/availability.ts';
import { zonedToUtc } from '../../domain/zoned-time.ts';

// 2026-12-07 is a Monday (weekday 1). Costa Rica is UTC-6 all year: 08:00 local = 14:00Z.
const MONDAY = '2026-12-07';
const CR = 'America/Costa_Rica';

function day(overrides: Partial<DayScheduleInput> = {}): DayScheduleInput {
  return {
    date: MONDAY,
    timeZone: CR,
    workingHours: [{ weekday: 1, startTime: '08:00:00', endTime: '12:00:00' }],
    blocks: [],
    appointments: [],
    ...overrides,
  };
}

const starts = (slots: { startsAt: string }[]) => slots.map((s) => s.startsAt.slice(11, 16));
const iso = (ms: number) => new Date(ms).toISOString();

describe('freeWindows', () => {
  test('a morning shift becomes one window in UTC using the clinic time zone', () => {
    const [window] = freeWindows(day());
    assert.equal(iso(window!.start), '2026-12-07T14:00:00.000Z');
    assert.equal(iso(window!.end), '2026-12-07T18:00:00.000Z');
  });

  test('a split shift gives two windows and nothing over lunch', () => {
    const windows = freeWindows(day({
      workingHours: [
        { weekday: 1, startTime: '08:00', endTime: '12:00' },
        { weekday: 1, startTime: '13:00', endTime: '17:00' },
      ],
    }));
    assert.deepEqual(windows.map((w) => [iso(w.start).slice(11, 16), iso(w.end).slice(11, 16)]), [
      ['14:00', '18:00'],
      ['19:00', '23:00'],
    ]);
  });

  test('only the working hours of that weekday count', () => {
    assert.deepEqual(freeWindows(day({ date: '2026-12-08' })), []); // Tuesday
  });

  test('a booked appointment splits the window', () => {
    const windows = freeWindows(day({
      appointments: [{ startsAt: '2026-12-07T15:00:00Z', endsAt: '2026-12-07T15:45:00Z' }],
    }));
    assert.deepEqual(windows.map((w) => [iso(w.start).slice(11, 16), iso(w.end).slice(11, 16)]), [
      ['14:00', '15:00'],
      ['15:45', '18:00'],
    ]);
  });

  test('a block covering the whole shift leaves no window', () => {
    const windows = freeWindows(day({
      blocks: [{ startsAt: '2026-12-07T06:00:00Z', endsAt: '2026-12-08T06:00:00Z' }],
    }));
    assert.deepEqual(windows, []);
  });

  test('overlapping blocks and appointments are merged before subtracting', () => {
    const windows = freeWindows(day({
      blocks: [{ startsAt: '2026-12-07T15:00:00Z', endsAt: '2026-12-07T16:00:00Z' }],
      appointments: [{ startsAt: '2026-12-07T15:30:00Z', endsAt: '2026-12-07T16:30:00Z' }],
    }));
    assert.deepEqual(windows.map((w) => [iso(w.start).slice(11, 16), iso(w.end).slice(11, 16)]), [
      ['14:00', '15:00'],
      ['16:30', '18:00'],
    ]);
  });

  test('accepts Date objects as well as ISO strings', () => {
    const fromStrings = freeWindows(day({ blocks: [{ startsAt: '2026-12-07T15:00:00Z', endsAt: '2026-12-07T16:00:00Z' }] }));
    const fromDates = freeWindows(day({
      blocks: [{ startsAt: new Date('2026-12-07T15:00:00Z'), endsAt: new Date('2026-12-07T16:00:00Z') }],
    }));
    assert.deepEqual(fromDates, fromStrings);
  });
});

describe('slotsFromWindows / availableSlots', () => {
  test('a 4-hour shift holds eight 30-minute slots', () => {
    const slots = availableSlots({ ...day(), durationMinutes: 30 });
    assert.equal(slots.length, 8);
    assert.deepEqual(slots[0], { startsAt: '2026-12-07T14:00:00.000Z', endsAt: '2026-12-07T14:30:00.000Z' });
    assert.equal(slots.at(-1)?.endsAt, '2026-12-07T18:00:00.000Z');
  });

  test('back-to-back is allowed: a slot may start exactly when an appointment ends', () => {
    const slots = availableSlots({
      ...day({ appointments: [{ startsAt: '2026-12-07T14:00:00Z', endsAt: '2026-12-07T14:30:00Z' }] }),
      durationMinutes: 30,
    });
    assert.equal(slots[0]?.startsAt, '2026-12-07T14:30:00.000Z');
  });

  test('no slot overlaps a booked appointment', () => {
    const booked = { start: Date.parse('2026-12-07T15:00:00Z'), end: Date.parse('2026-12-07T15:45:00Z') };
    const slots = availableSlots({
      ...day({ appointments: [{ startsAt: iso(booked.start), endsAt: iso(booked.end) }] }),
      durationMinutes: 30,
      stepMinutes: 15,
    });
    for (const slot of slots) {
      const start = Date.parse(slot.startsAt);
      const end = Date.parse(slot.endsAt);
      assert.ok(end <= booked.start || start >= booked.end, `${slot.startsAt} overlaps the appointment`);
    }
  });

  test('the leftover of a window shorter than the service is not offered', () => {
    const slots = availableSlots({ ...day({ workingHours: [{ weekday: 1, startTime: '08:00', endTime: '09:20' }] }), durationMinutes: 30 });
    assert.deepEqual(starts(slots), ['14:00', '14:30']);
  });

  test('a service longer than every window has no slots', () => {
    assert.deepEqual(availableSlots({ ...day(), durationMinutes: 300 }), []);
  });

  test('a smaller step offers overlapping candidate start times', () => {
    const slots = availableSlots({ ...day({ workingHours: [{ weekday: 1, startTime: '08:00', endTime: '09:00' }] }), durationMinutes: 30, stepMinutes: 15 });
    assert.deepEqual(starts(slots), ['14:00', '14:15', '14:30']);
  });

  test('slots that already started are left out', () => {
    const slots = availableSlots({ ...day(), durationMinutes: 60, notBefore: new Date('2026-12-07T15:10:00Z') });
    assert.deepEqual(starts(slots), ['16:00', '17:00']);
  });

  test('rejects invalid durations and steps', () => {
    for (const durationMinutes of [0, -30, 12.5, 2000]) {
      assert.throws(() => slotsFromWindows([], durationMinutes), AvailabilityInputError);
    }
    assert.throws(() => slotsFromWindows([], 30, { stepMinutes: 0 }), AvailabilityInputError);
  });
});

describe('time zones and daylight saving', () => {
  const ny = (date: string, weekday: number, startTime = '08:00', endTime = '12:00'): DayScheduleInput => ({
    date,
    timeZone: 'America/New_York',
    workingHours: [{ weekday, startTime, endTime }],
    blocks: [],
    appointments: [],
  });

  test('08:00 in New York moves one hour in UTC across the spring change', () => {
    assert.equal(iso(freeWindows(ny('2026-03-07', 6))[0]!.start), '2026-03-07T13:00:00.000Z'); // EST, UTC-5
    assert.equal(iso(freeWindows(ny('2026-03-08', 0))[0]!.start), '2026-03-08T12:00:00.000Z'); // EDT, UTC-4
  });

  test('and back across the autumn change', () => {
    assert.equal(iso(freeWindows(ny('2026-10-31', 6))[0]!.start), '2026-10-31T12:00:00.000Z'); // EDT
    assert.equal(iso(freeWindows(ny('2026-11-01', 0))[0]!.start), '2026-11-01T13:00:00.000Z'); // EST
  });

  test('a shift across the skipped hour is one real hour shorter', () => {
    // 01:00 EST = 06:00Z; 02:00-03:00 does not exist; 04:00 EDT = 08:00Z.
    const slots = availableSlots({ ...ny('2026-03-08', 0, '01:00', '04:00'), durationMinutes: 60 });
    assert.deepEqual(starts(slots), ['06:00', '07:00']);
  });

  test('a zone without daylight saving is stable', () => {
    assert.equal(iso(zonedToUtc(Date.UTC(2026, 6, 1, 8), CR)), '2026-07-01T14:00:00.000Z');
    assert.equal(iso(zonedToUtc(Date.UTC(2026, 0, 1, 8), CR)), '2026-01-01T14:00:00.000Z');
  });
});

describe('input validation', () => {
  test('rejects impossible dates, unknown time zones and malformed times', () => {
    assert.throws(() => freeWindows(day({ date: '2026-02-30' })), AvailabilityInputError);
    assert.throws(() => freeWindows(day({ date: '07/12/2026' })), AvailabilityInputError);
    assert.throws(() => freeWindows(day({ timeZone: 'Mars/Olympus_Mons' })), AvailabilityInputError);
    assert.throws(() => freeWindows(day({ workingHours: [{ weekday: 1, startTime: '8am', endTime: '12:00' }] })), AvailabilityInputError);
    assert.throws(() => freeWindows(day({ workingHours: [{ weekday: 1, startTime: '12:00', endTime: '08:00' }] })), AvailabilityInputError);
    assert.throws(() => freeWindows(day({ blocks: [{ startsAt: 'not a date', endsAt: '2026-12-07T15:00:00Z' }] })), AvailabilityInputError);
  });

  test('accepts 24:00 as the end of the day', () => {
    const [window] = freeWindows(day({ workingHours: [{ weekday: 1, startTime: '20:00', endTime: '24:00' }] }));
    assert.equal(iso(window!.end), '2026-12-08T06:00:00.000Z');
  });

  test('the error answers 422', () => {
    assert.equal(new AvailabilityInputError('x').status, 422);
  });
});

describe('daysInRange (RF8)', () => {
  test('lists every day of the range, both ends included', () => {
    assert.deepEqual(daysInRange('2026-12-30', '2027-01-02'), ['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']);
  });

  test(`limits the range to ${MAX_RANGE_DAYS} days and rejects reversed ranges`, () => {
    assert.equal(daysInRange('2026-12-01', '2026-12-31').length, 31);
    assert.throws(() => daysInRange('2026-12-01', '2027-01-01'), AvailabilityInputError);
    assert.throws(() => daysInRange('2026-12-05', '2026-12-01'), AvailabilityInputError);
  });
});

describe('interval helpers', () => {
  test('mergeIntervals joins overlapping and touching intervals', () => {
    assert.deepEqual(mergeIntervals([{ start: 5, end: 8 }, { start: 0, end: 3 }, { start: 3, end: 4 }, { start: 7, end: 10 }]), [
      { start: 0, end: 4 },
      { start: 5, end: 10 },
    ]);
  });

  test('subtractIntervals removes busy time from every window', () => {
    assert.deepEqual(subtractIntervals([{ start: 0, end: 10 }, { start: 20, end: 30 }], [{ start: 5, end: 25 }]), [
      { start: 0, end: 5 },
      { start: 25, end: 30 },
    ]);
  });
});
