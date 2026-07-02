const assert = require('assert');
const {
  getGroupMembershipWindow,
  groupHistoryBoundary,
  canReadGroupMessageAt
} = require('./groupMembershipPrivacy');

const userId = '507f1f77bcf86cd799439011';
const joinedFirst = new Date('2026-01-01T00:00:00.000Z');
const removedFirst = new Date('2026-01-03T00:00:00.000Z');
const joinedAgain = new Date('2026-01-05T00:00:00.000Z');
const removedAgain = new Date('2026-01-07T00:00:00.000Z');

const rejoinedRoom = {
  createdAt: new Date('2025-12-31T00:00:00.000Z'),
  members: [{ user: userId, joinedAt: joinedAgain }],
  removedMembers: [{ user: userId, joinedAt: joinedFirst, removedAt: removedFirst }]
};
const currentWindow = getGroupMembershipWindow(rejoinedRoom, userId);
assert.strictEqual(currentWindow.current, true);
assert.strictEqual(currentWindow.from.toISOString(), joinedAgain.toISOString());
assert.strictEqual(canReadGroupMessageAt(currentWindow, '2026-01-02T00:00:00.000Z'), false);
assert.strictEqual(canReadGroupMessageAt(currentWindow, '2026-01-04T00:00:00.000Z'), false);
assert.strictEqual(canReadGroupMessageAt(currentWindow, '2026-01-06T00:00:00.000Z'), true);
assert.deepStrictEqual(groupHistoryBoundary(currentWindow), {
  createdAt: { $gte: joinedAgain }
});

const removedAgainRoom = {
  members: [],
  removedMembers: [
    { user: userId, joinedAt: joinedFirst, removedAt: removedFirst },
    { user: userId, joinedAt: joinedAgain, removedAt: removedAgain }
  ]
};
const removedWindow = getGroupMembershipWindow(removedAgainRoom, userId);
assert.strictEqual(removedWindow.current, false);
assert.strictEqual(removedWindow.from.toISOString(), joinedAgain.toISOString());
assert.strictEqual(removedWindow.to.toISOString(), removedAgain.toISOString());
assert.strictEqual(canReadGroupMessageAt(removedWindow, '2026-01-02T00:00:00.000Z'), false);
assert.strictEqual(canReadGroupMessageAt(removedWindow, '2026-01-04T00:00:00.000Z'), false);
assert.strictEqual(canReadGroupMessageAt(removedWindow, '2026-01-06T00:00:00.000Z'), true);
assert.strictEqual(canReadGroupMessageAt(removedWindow, '2026-01-08T00:00:00.000Z'), false);

const legacyRemoval = new Date('2026-02-01T00:00:00.000Z');
const legacyWindow = getGroupMembershipWindow({
  members: [],
  removedMembers: [{ user: userId, removedAt: legacyRemoval }]
}, userId);
assert.strictEqual(legacyWindow.from.toISOString(), legacyRemoval.toISOString());
assert.strictEqual(legacyWindow.to.toISOString(), legacyRemoval.toISOString());
assert.strictEqual(canReadGroupMessageAt(legacyWindow, '2026-01-31T23:59:59.000Z'), false);

console.log('group membership privacy epoch tests passed');
