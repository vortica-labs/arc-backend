const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Scrim = require('../models/Scrim');
const { __testables } = require('./scrimController');

const {
  SCRIM_MATCH_COUNTS,
  SCRIM_BROADCAST_TYPES,
  MAX_BROADCAST_MESSAGE_LENGTH,
  validateScrimCreationInput,
  validateScrimResultInput,
  hasSubmittedResultsForEveryMatch,
  refreshScrimFinalResult
} = __testables;

const makeMatches = (count) => Array.from({ length: count }, (_, index) => ({
  matchNumber: index + 1,
  map: ['Erangel', 'Miramar', 'Sanhok', 'Vikendi', 'Livik', 'Karakin'][index] || 'Nusa',
  idpTime: '18:00',
  startTime: '18:30'
}));

const dailyPayload = (overrides = {}) => ({
  name: 'Evening Scrim',
  format: 'Squad',
  scrimType: 'Daily',
  timeSlot: '7-8',
  numberOfMatches: 1,
  date: '2026-07-03',
  maxTeams: 16,
  timezone: 'Asia/Kolkata',
  prizePoolType: 'without_prize',
  prizePoolCurrency: 'INR',
  matches: makeMatches(1),
  ...overrides
});

assert.deepStrictEqual(SCRIM_MATCH_COUNTS, [1, 2, 3, 4, 5, 6]);
assert.deepStrictEqual(Scrim.schema.path('numberOfMatches').options.enum, [1, 2, 3, 4, 5, 6]);
assert.strictEqual(Scrim.schema.path('matches').schema.path('matchNumber').options.max, 6);

const sameDay = validateScrimCreationInput(dailyPayload(), {
  now: new Date('2026-07-03T18:20:00.000Z')
});
assert.ok(sameDay.value, `same-day Scrim must be accepted: ${sameDay.error || ''}`);
assert.strictEqual(sameDay.value.date.toISOString(), '2026-07-03T00:00:00.000Z');

const nextCalendarDay = validateScrimCreationInput(dailyPayload(), {
  now: new Date('2026-07-03T18:40:00.000Z')
});
assert.match(nextCalendarDay.error, /past/i);

const sixMatches = validateScrimCreationInput(dailyPayload({
  numberOfMatches: 6,
  timeSlot: '7-10',
  matches: makeMatches(6)
}), { now: new Date('2026-07-03T10:00:00.000Z') });
assert.ok(sixMatches.value, `six-match Web contract must be accepted: ${sixMatches.error || ''}`);
assert.strictEqual(sixMatches.value.matches.length, 6);
assert.match(validateScrimCreationInput(dailyPayload({
  numberOfMatches: 6,
  timeSlot: '7-8',
  matches: makeMatches(6)
}), { now: new Date('2026-07-03T10:00:00.000Z') }).error, /valid Daily time slot/);

assert.match(validateScrimCreationInput(dailyPayload({ maxTeams: 15 }), {
  now: new Date('2026-07-03T10:00:00.000Z')
}).error, /16 and 25/);
assert.match(validateScrimCreationInput(dailyPayload({ maxTeams: 26 }), {
  now: new Date('2026-07-03T10:00:00.000Z')
}).error, /16 and 25/);

const weeklyMissingEnd = validateScrimCreationInput(dailyPayload({
  scrimType: 'Weekly',
  timeSlot: '',
  endDate: undefined
}), { now: new Date('2026-07-03T10:00:00.000Z') });
assert.match(weeklyMissingEnd.error, /End date is required/);
const weeklyValid = validateScrimCreationInput(dailyPayload({
  scrimType: 'Weekly',
  timeSlot: '',
  endDate: '2026-07-09'
}), { now: new Date('2026-07-03T10:00:00.000Z') });
assert.ok(weeklyValid.value);
assert.strictEqual(weeklyValid.value.timeSlot, null);

assert.match(validateScrimCreationInput(dailyPayload({
  prizePoolType: 'with_prize',
  prizePool: 0
}), { now: new Date('2026-07-03T10:00:00.000Z') }).error, /greater than zero/);
assert.match(validateScrimCreationInput(dailyPayload({ prizePoolCurrency: 'EUR' }), {
  now: new Date('2026-07-03T10:00:00.000Z')
}).error, /INR or USD/);
assert.strictEqual(validateScrimCreationInput(dailyPayload({ prizePoolType: 'no_prize' }), {
  now: new Date('2026-07-03T10:00:00.000Z')
}).value.prizePoolType, 'without_prize');

const participantA = '64b000000000000000000001';
const participantB = '64b000000000000000000002';
const validResults = validateScrimResultInput([
  { teamId: participantA, placement: 1, kills: 4 },
  { teamId: participantB, placement: 2, kills: 0 }
], [participantA, participantB]);
assert.ok(validResults.value);
assert.match(validateScrimResultInput([
  { teamId: participantA, placement: 1, kills: 1 },
  { teamId: participantA, placement: 2, kills: 1 }
], [participantA, participantB]).error, /only once|every registered/i);
assert.match(validateScrimResultInput([
  { teamId: participantA, placement: 1, kills: 1 },
  { teamId: participantB, placement: 1, kills: 1 }
], [participantA, participantB]).error, /unique placement/i);
assert.match(validateScrimResultInput([
  { teamId: participantA, placement: 1, kills: 51 },
  { teamId: participantB, placement: 2, kills: 1 }
], [participantA, participantB]).error, /between 0 and 50/);
assert.match(validateScrimResultInput([
  { teamId: participantA, placement: 1, kills: 1 }
], [participantA, participantB]).error, /every registered participant/);

assert.strictEqual(hasSubmittedResultsForEveryMatch([
  { results: { submittedAt: new Date(), teams: [{ teamId: participantA }] } },
  { results: { submittedAt: new Date(), teams: [{ teamId: participantB }] } }
]), true);
assert.strictEqual(hasSubmittedResultsForEveryMatch([
  { results: { submittedAt: new Date(), teams: [{ teamId: participantA }] } },
  { results: { submittedAt: null, teams: [] } }
]), false);

const finalizedScrim = {
  overallStandings: {
    teams: [
      { teamId: participantA, teamName: 'Alpha', totalPoints: 25 },
      { teamId: participantB, teamName: 'Bravo', totalPoints: 18 }
    ]
  },
  prizeDistribution: [{ rank: 1, amount: 500 }],
  specialPrizes: []
};
refreshScrimFinalResult(finalizedScrim, new Date('2026-07-03T12:00:00.000Z'));
assert.strictEqual(finalizedScrim.finalResult.standings[0].rank, 1);
assert.strictEqual(finalizedScrim.finalResult.standings[0].prizeAmount, 500);
assert.strictEqual(finalizedScrim.finalResult.standings[1].prizeAmount, 0);

assert.deepStrictEqual([...SCRIM_BROADCAST_TYPES].sort(), ['custom', 'info', 'match_starting', 'warning']);
assert.strictEqual(MAX_BROADCAST_MESSAGE_LENGTH, 2000);

const controllerSource = fs.readFileSync(path.join(__dirname, 'scrimController.js'), 'utf8');
assert.match(controllerSource, /\$expr:[\s\S]*\$lt:[\s\S]*\$size:[\s\S]*\$maxTeams/);
assert.match(controllerSource, /registeredTeams:\s*\{\s*\$ne:\s*userId\s*\}/);
assert.match(controllerSource, /host:\s*\{\s*\$ne:\s*userId\s*\}/);
assert.match(controllerSource, /Promise\.allSettled\(recipientIds\.map/);
assert.match(controllerSource, /username userType profile\.displayName profile\.avatar/);
assert.match(controllerSource, /if \(scrim\.finalResult\?\.generatedAt\)[\s\S]*refreshScrimFinalResult\(scrim\)/);
assert.match(controllerSource, /normalizedMessage\.length > MAX_BROADCAST_MESSAGE_LENGTH/);
assert.match(controllerSource, /SCRIM_BROADCAST_TYPES\.has\(normalizedType\)/);

console.log('Scrim controller/model parity and security contracts passed');
