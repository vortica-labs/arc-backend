const partsFor = (date, timezone) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  return Object.fromEntries(
    parts.filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)])
  );
};

const wallTime = (parts) => Date.UTC(
  parts.year,
  parts.month - 1,
  parts.day,
  parts.hour || 0,
  parts.minute || 0,
  parts.second || 0
);

const sameWallTime = (left, right) => (
  left.year === right.year
  && left.month === right.month
  && left.day === right.day
  && (left.hour || 0) === (right.hour || 0)
  && (left.minute || 0) === (right.minute || 0)
  && (left.second || 0) === (right.second || 0)
);

const wallPartsToDate = (parts, timezone) => {
  const desired = wallTime(parts);
  const offsets = new Set();
  for (const hours of [-48, -24, -12, 0, 12, 24, 48]) {
    const sample = new Date(desired + (hours * 60 * 60 * 1000));
    offsets.add(wallTime(partsFor(sample, timezone)) - sample.getTime());
  }
  const exact = [...offsets]
    .map((offset) => {
      const candidate = new Date(desired - offset);
      return { candidate, actual: partsFor(candidate, timezone) };
    })
    .filter(({ actual }) => sameWallTime(actual, parts))
    .sort((left, right) => left.candidate - right.candidate);
  if (exact.length > 0) return exact[0].candidate;
  throw new Error(`Unable to resolve calendar day boundary in timezone ${timezone}`);
};

const getTimezoneDayBounds = (timezone = 'Asia/Kolkata', nowValue = new Date()) => {
  const now = new Date(nowValue);
  if (Number.isNaN(now.getTime())) throw new Error('now must be a valid date');
  // Intl validates the IANA timezone before any query can run.
  const current = partsFor(now, timezone);
  const start = wallPartsToDate({
    year: current.year,
    month: current.month,
    day: current.day,
    hour: 0,
    minute: 0,
    second: 0
  }, timezone);
  const nextDay = new Date(Date.UTC(current.year, current.month - 1, current.day + 1));
  const end = wallPartsToDate({
    year: nextDay.getUTCFullYear(),
    month: nextDay.getUTCMonth() + 1,
    day: nextDay.getUTCDate(),
    hour: 0,
    minute: 0,
    second: 0
  }, timezone);
  return { timezone, start, end };
};

module.exports = { getTimezoneDayBounds };
