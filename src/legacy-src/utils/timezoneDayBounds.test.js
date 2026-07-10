const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { getTimezoneDayBounds } = require('./timezoneDayBounds');

const beforeMidnight = getTimezoneDayBounds('Asia/Kolkata', new Date('2026-07-09T18:29:59.999Z'));
assert.strictEqual(beforeMidnight.start.toISOString(), '2026-07-08T18:30:00.000Z');
assert.strictEqual(beforeMidnight.end.toISOString(), '2026-07-09T18:30:00.000Z');

const atMidnight = getTimezoneDayBounds('Asia/Kolkata', new Date('2026-07-09T18:30:00.000Z'));
assert.strictEqual(atMidnight.start.toISOString(), '2026-07-09T18:30:00.000Z');
assert.strictEqual(atMidnight.end.toISOString(), '2026-07-10T18:30:00.000Z');

// DST days must use calendar boundaries, not a hard-coded 24-hour duration.
const springForward = getTimezoneDayBounds('America/New_York', new Date('2026-03-08T12:00:00.000Z'));
assert.strictEqual(springForward.start.toISOString(), '2026-03-08T05:00:00.000Z');
assert.strictEqual(springForward.end.toISOString(), '2026-03-09T04:00:00.000Z');
assert.strictEqual(springForward.end.getTime() - springForward.start.getTime(), 23 * 60 * 60 * 1000);

assert.throws(() => getTimezoneDayBounds('Not/A_Timezone'), /time zone|timezone/i);

const scrimController = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'scrimController.js'), 'utf8');
const tournamentController = fs.readFileSync(path.join(__dirname, '..', 'controllers', 'tournamentController.js'), 'utf8');
for (const source of [scrimController, tournamentController]) {
  assert.match(source, /getTimezoneDayBounds\(/);
  assert.match(source, /createdAt:\s*\{\s*\$gte:\s*startOfDay,\s*\$lt:\s*nextDay\s*\}/);
}
assert.doesNotMatch(scrimController, /startOfDay\.setHours\(/);

console.log('Timezone calendar-day boundary contracts passed');
