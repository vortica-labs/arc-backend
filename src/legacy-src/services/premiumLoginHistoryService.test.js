const assert = require('node:assert/strict');
const fs = require('node:fs');
const mongoose = require('mongoose');
const path = require('node:path');
const PremiumMembership = require('../models/PremiumMembership');
const UserLoginEvent = require('../models/UserLoginEvent');
const { listPremiumMemberLogins } = require('./premiumLoginHistoryService');

const originals = {
  membershipFindOne: PremiumMembership.findOne,
  loginFind: UserLoginEvent.find,
  loginCount: UserLoginEvent.countDocuments,
};

const chain = (result) => ({
  select() { return this; },
  sort() { return this; },
  skip() { return this; },
  limit() { return this; },
  lean: async () => result,
});

async function run() {
  const routes = fs.readFileSync(path.resolve(__dirname, '..', '..', 'modules', 'admin', 'premium-membership.routes.ts'), 'utf8');
  assert.match(routes, /\/:id\/login-history.*requireAdminPermission\("premium:read"\)/);

  await assert.rejects(
    listPremiumMemberLogins('not-an-object-id'),
    (error) => error?.code === 'MEMBERSHIP_NOT_FOUND' && error?.statusCode === 404,
  );

  const membershipId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const loginId = new mongoose.Types.ObjectId();
  PremiumMembership.findOne = () => chain({ _id: membershipId, user: userId });
  UserLoginEvent.find = (filter) => {
    assert.equal(String(filter.user), String(userId));
    return chain([{
      _id: loginId,
      authMethod: 'password',
      timestamp: new Date('2026-07-01T10:00:00.000Z'),
      ip: '127.0.0.1',
      userAgent: 'test-agent',
      platform: 'web',
      device: 'Web browser',
      secret: 'must-not-serialize',
    }]);
  };
  UserLoginEvent.countDocuments = async (filter) => {
    assert.equal(String(filter.user), String(userId));
    return 1;
  };

  const result = await listPremiumMemberLogins(membershipId, { page: '1', limit: '25' });
  assert.equal(result.pagination.total, 1);
  assert.equal(result.retentionDays, 180);
  assert.deepEqual(Object.keys(result.logins[0]).sort(), [
    '_id', 'authMethod', 'device', 'id', 'ip', 'platform', 'timestamp', 'userAgent',
  ].sort());
  assert.equal(result.logins[0].secret, undefined);

  console.log('Premium login history service tests passed');
}

run()
  .finally(() => {
    PremiumMembership.findOne = originals.membershipFindOne;
    UserLoginEvent.find = originals.loginFind;
    UserLoginEvent.countDocuments = originals.loginCount;
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
