const assert = require('assert');
const { calculateManualDeliveryBatch } = require('./boostService');

const campaignId = '507f1f77bcf86cd799439011';
const startedAt = new Date('2026-06-29T00:00:00.000Z');
const endsAt = new Date('2026-06-29T06:00:00.000Z');

const firstHour = calculateManualDeliveryBatch({
  campaignId,
  targetViews: 5000,
  deliveredViews: 0,
  startedAt,
  endsAt,
  now: new Date('2026-06-29T01:00:00.000Z')
});

assert(firstHour.delta > 0, 'first hour should deliver a positive batch');
assert(firstHour.delta < 5000, 'first hour must not deliver the full campaign');
assert(firstHour.nextDelivered <= 5000, 'first hour must not over-deliver');

const duplicateBucket = calculateManualDeliveryBatch({
  campaignId,
  targetViews: 5000,
  deliveredViews: firstHour.nextDelivered,
  startedAt,
  endsAt,
  now: new Date('2026-06-29T01:00:20.000Z'),
  lastDeliveryBucket: firstHour.bucket
});

assert.strictEqual(duplicateBucket.delta, 0, 'same minute bucket must not deliver twice');

const finalBatch = calculateManualDeliveryBatch({
  campaignId,
  targetViews: 5000,
  deliveredViews: 4300,
  startedAt,
  endsAt,
  now: new Date('2026-06-29T06:00:01.000Z')
});

assert.strictEqual(finalBatch.nextDelivered, 5000, 'final batch must complete at target');
assert.strictEqual(finalBatch.nextRemaining, 0, 'final batch must leave no remaining reach');
assert.strictEqual(finalBatch.shouldComplete, true, 'final batch must mark completion');

const exhausted = calculateManualDeliveryBatch({
  campaignId,
  targetViews: 5000,
  deliveredViews: 5000,
  startedAt,
  endsAt,
  now: new Date('2026-06-29T04:00:00.000Z')
});

assert.strictEqual(exhausted.delta, 0, 'exhausted campaign must not deliver more views');
assert.strictEqual(exhausted.nextDelivered, 5000, 'exhausted campaign must stay capped at target');

console.log('boostService delivery calculator tests passed');
