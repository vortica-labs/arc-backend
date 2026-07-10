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
  validateScrimUpdateInput,
  scrimPrizeConfigurationFingerprint,
  buildScrimJoinAdmission,
  scrimCapacityArrayPath,
  isValidScrimIdentifier,
  validateScrimResultInput,
  advanceScrimStatusForResult,
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
assert.strictEqual(isValidScrimIdentifier('64b000000000000000000001'), true);
assert.strictEqual(isValidScrimIdentifier('scr-bgm-a1b2c3d4'), true);
assert.strictEqual(isValidScrimIdentifier('not-an-id'), false);
assert.ok(
  Scrim.schema.indexes().some(([keys]) => keys.registeredTeams === 1 && keys.date === -1),
  'participating Scrim lists require a registeredTeams/date index'
);

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
assert.match(validateScrimCreationInput(dailyPayload({ prizeDistribution: { rank: 1 } }), {
  now: new Date('2026-07-03T10:00:00.000Z')
}).error, /must be arrays/);
assert.match(validateScrimCreationInput(dailyPayload({
  prizePoolType: 'with_prize',
  prizePool: 100,
  prizeDistribution: [{ rank: 1, amount: 101 }]
}), { now: new Date('2026-07-03T10:00:00.000Z') }).error, /over-budget/);
const createWithSpoofedWinner = validateScrimCreationInput(dailyPayload({
  prizePoolType: 'with_prize',
  prizePool: 100,
  specialPrizes: [{ category: 'MVP', amount: 100, winnerId: '64b000000000000000000099', winnerName: 'Spoofed' }]
}), { now: new Date('2026-07-03T10:00:00.000Z') });
assert.ok(createWithSpoofedWinner.value, createWithSpoofedWinner.error);
assert.strictEqual(createWithSpoofedWinner.value.specialPrizes[0].winnerId, undefined);
assert.strictEqual(createWithSpoofedWinner.value.specialPrizes[0].winnerName, undefined);

const participantA = '64b000000000000000000001';
const participantB = '64b000000000000000000002';
const persistedScrim = {
  ...dailyPayload({ date: new Date('2026-07-03T00:00:00.000Z') }),
  description: 'Existing description',
  registeredTeams: Array.from({ length: 16 }, (_, index) => (index + 16).toString(16).padStart(24, '0')),
  matches: makeMatches(1).map((match) => ({
    ...match,
    status: 'Completed',
    results: { teams: [{ teamId: participantA }], submittedAt: new Date('2026-07-03T12:00:00.000Z') }
  }))
};
const partialUpdate = validateScrimUpdateInput(persistedScrim, { name: ' Updated Scrim ' }, {
  now: new Date('2026-07-10T10:00:00.000Z')
});
assert.ok(partialUpdate.value, partialUpdate.error);
assert.strictEqual(partialUpdate.value.name, 'Updated Scrim');
assert.strictEqual(partialUpdate.value.date, undefined, 'partial edits must not rewrite unrelated fields');
const idempotentPastDate = validateScrimUpdateInput(persistedScrim, {
  name: 'Updated Scrim',
  date: '2026-07-03'
}, { now: new Date('2026-07-10T10:00:00.000Z') });
assert.ok(idempotentPastDate.value, idempotentPastDate.error);
assert.strictEqual(idempotentPastDate.value.date.toISOString(), '2026-07-03T00:00:00.000Z');
assert.match(validateScrimUpdateInput(persistedScrim, { date: '2026-07-02' }, {
  now: new Date('2026-07-03T10:00:00.000Z')
}).error, /past/i);
assert.match(validateScrimUpdateInput(persistedScrim, { maxTeams: 15 }, {
  now: new Date('2026-07-03T10:00:00.000Z')
}).error, /16 and 25|registered participants/i);
assert.match(validateScrimUpdateInput({
  ...persistedScrim,
  maxTeams: 18,
  registeredTeams: Array.from({ length: 17 }, (_, index) => (index + 16).toString(16).padStart(24, '0'))
}, { maxTeams: 16 }, { now: new Date('2026-07-03T10:00:00.000Z') }).error, /17 registered participants/i);
assert.match(validateScrimUpdateInput(persistedScrim, { matches: [] }, {
  now: new Date('2026-07-03T10:00:00.000Z')
}).error, /exactly 1 match/i);
const matchUpdate = validateScrimUpdateInput(persistedScrim, {
  matches: [{ matchNumber: 1, map: 'Miramar', idpTime: '19:00', startTime: '19:30' }]
}, { now: new Date('2026-07-03T10:00:00.000Z') });
assert.ok(matchUpdate.value, matchUpdate.error);
assert.strictEqual(matchUpdate.value.matches[0].status, 'Completed');
assert.strictEqual(matchUpdate.value.matches[0].results.teams.length, 1, 'editing schedule must preserve submitted results');
const disablePrize = validateScrimUpdateInput({
  ...persistedScrim,
  prizePoolType: 'with_prize',
  prizePool: 500,
  prizeDistribution: [{ rank: 1, amount: 500 }]
}, { prizePoolType: 'without_prize' }, { now: new Date('2026-07-03T10:00:00.000Z') });
assert.ok(disablePrize.value, disablePrize.error);
assert.strictEqual(disablePrize.value.prizePool, 0);
assert.deepStrictEqual(disablePrize.value.prizeDistribution, []);
const prizeFingerprintInput = {
  prizePoolType: 'with_prize',
  prizePool: 500,
  prizePoolCurrency: 'inr',
  prizeDistribution: [{ rank: 1, label: 'Winner', amount: 500, percentage: 100 }],
  specialPrizes: []
};
assert.strictEqual(
  scrimPrizeConfigurationFingerprint(prizeFingerprintInput),
  scrimPrizeConfigurationFingerprint({ ...prizeFingerprintInput, prizePoolCurrency: 'INR' }),
  'idempotent prize payloads must not require a fresh verification decision'
);
assert.notStrictEqual(
  scrimPrizeConfigurationFingerprint(prizeFingerprintInput),
  scrimPrizeConfigurationFingerprint({ ...prizeFingerprintInput, prizePool: 600 })
);
const persistedWinnerId = '64b000000000000000000088';
const protectedWinnerUpdate = validateScrimUpdateInput({
  ...persistedScrim,
  prizePoolType: 'with_prize',
  prizePool: 100,
  specialPrizes: [{ category: 'MVP', amount: 100, winnerId: persistedWinnerId, winnerName: 'Real Winner' }]
}, {
  specialPrizes: [{ category: 'MVP', amount: 100, winnerId: participantA, winnerName: 'Spoofed' }]
}, { now: new Date('2026-07-03T10:00:00.000Z') });
assert.ok(protectedWinnerUpdate.value, protectedWinnerUpdate.error);
assert.strictEqual(String(protectedWinnerUpdate.value.specialPrizes[0].winnerId), persistedWinnerId);
assert.strictEqual(protectedWinnerUpdate.value.specialPrizes[0].winnerName, 'Real Winner');

const admission = buildScrimJoinAdmission({
  scrimId: '64b000000000000000000099',
  userId: participantA,
  maxTeams: 16
});
assert.strictEqual(Array.isArray(admission.update), false, 'DocumentDB rejects aggregation-pipeline updates');
assert.deepStrictEqual(admission.update, { $addToSet: { registeredTeams: participantA } });
assert.deepStrictEqual(admission.filter['registeredTeams.15'], { $exists: false });
assert.strictEqual(admission.filter.maxTeams, 16);
assert.deepStrictEqual(admission.filter.$and[0].registeredTeams, { $ne: participantA });
assert.deepStrictEqual(admission.filter.$and[1].$or[1].registeredTeams, { $type: 'array' });
assert.strictEqual(scrimCapacityArrayPath(25), 'registeredTeams.24');

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
const openLifecycle = { status: 'Open' };
assert.strictEqual(advanceScrimStatusForResult(openLifecycle), 'In Progress');
assert.strictEqual(openLifecycle.status, 'In Progress');
const fullLifecycle = { status: 'Full' };
assert.strictEqual(advanceScrimStatusForResult(fullLifecycle), 'In Progress');
const completedLifecycle = { status: 'Completed' };
assert.strictEqual(advanceScrimStatusForResult(completedLifecycle), 'Completed');

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
assert.doesNotMatch(controllerSource, /findOneAndUpdate\([\s\S]{0,800}?\n\s*\[/, 'Scrim mutations must not use update pipelines');
assert.match(controllerSource, /\$addToSet:\s*\{\s*registeredTeams:\s*userId\s*\}/);
assert.match(controllerSource, /\$pull:\s*\{\s*registeredTeams:\s*userId\s*\}/);
assert.doesNotMatch(controllerSource, /scrim\.host\.toString\(/, 'legacy missing host references must not throw');
assert.match(controllerSource, /eventType:\s*'scrim_updated'/);
assert.ok(
  controllerSource.indexOf('const updatedScrim = await Scrim.findOneAndUpdate')
    < controllerSource.indexOf("eventType: 'scrim_updated'"),
  'edit notifications must be produced only after persistence'
);
assert.match(controllerSource, /scrim:\s*sanitizePublicScrim\(leftScrim\)/);
assert.match(controllerSource, /Special prize winner must be a registered scrim participant/);
assert.match(controllerSource, /winner\.profile\?\.displayName \|\| winner\.username/);
assert.match(controllerSource, /Completed scrims cannot be cancelled/);
assert.match(controllerSource, /expandScrimRecipientIds/);
assert.match(controllerSource, /teamInfo\.members\.user teamInfo\.rosters\.players/);
assert.match(controllerSource, /const broadcastRecipients = await expandScrimRecipientIds/);
assert.match(controllerSource, /getTimezoneDayBounds\(DEFAULT_SCRIM_TIMEZONE\)/);
assert.match(controllerSource, /createdAt:\s*\{\s*\$gte:\s*startOfDay,\s*\$lt:\s*nextDay\s*\}/);
assert.match(controllerSource, /Cannot submit results for a cancelled scrim/);
assert.match(controllerSource, /Cannot generate results for a cancelled scrim/);
assert.match(controllerSource, /Cannot update prize distribution for a completed or cancelled scrim/);
assert.match(controllerSource, /Cannot assign prizes for a cancelled scrim/);
assert.match(controllerSource, /Promise\.allSettled\(recipientIds\.map/);
assert.match(controllerSource, /username userType profile\.displayName profile\.avatar/);
assert.match(controllerSource, /if \(scrim\.finalResult\?\.generatedAt\)[\s\S]*refreshScrimFinalResult\(scrim\)/);
assert.match(controllerSource, /normalizedMessage\.length > MAX_BROADCAST_MESSAGE_LENGTH/);
assert.match(controllerSource, /SCRIM_BROADCAST_TYPES\.has\(normalizedType\)/);

console.log('Scrim controller/model parity and security contracts passed');
