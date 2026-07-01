const assert = require('assert');

const stubModule = (request, exportsValue) => {
  const filename = require.resolve(request);
  require.cache[filename] = {
    id: filename,
    filename,
    loaded: true,
    exports: exportsValue,
    children: [],
    paths: []
  };
};

let cachedUser = null;
let decodedToken = { id: 'user-id' };

stubModule('../utils/jwt', {
  extractToken: () => 'test-token',
  verifyToken: () => decodedToken
});
stubModule('../models/User', {});
stubModule('mongoose', { connection: { readyState: 1 } });
stubModule('../utils/redisCache', {
  getJson: async () => cachedUser,
  setJson: async () => {},
  del: async () => {}
});
stubModule('../utils/logger', { error: () => {} });

const { optionalAuth, protect, protectAllowIncomplete } = require('./auth');

const createRes = () => ({
  statusCode: 200,
  body: null,
  status(statusCode) {
    this.statusCode = statusCode;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  }
});

const run = async (middleware) => {
  const req = {};
  const res = createRes();
  let nextCalls = 0;
  await middleware(req, res, () => {
    nextCalls += 1;
  });
  return { req, res, nextCalls };
};

(async () => {
  cachedUser = {
    _id: 'user-id',
    username: 'pending-user',
    userType: 'player',
    isActive: true,
    needsProfileCompletion: true
  };

  const blocked = await run(protect);
  assert.strictEqual(blocked.res.statusCode, 403);
  assert.strictEqual(blocked.res.body.code, 'PROFILE_COMPLETION_REQUIRED');
  assert.strictEqual(blocked.nextCalls, 0);

  const onboardingAllowed = await run(protectAllowIncomplete);
  assert.strictEqual(onboardingAllowed.res.statusCode, 200);
  assert.strictEqual(onboardingAllowed.nextCalls, 1);
  assert.strictEqual(onboardingAllowed.req.user._id, 'user-id');

  const optionalBlocked = await run(optionalAuth);
  assert.strictEqual(optionalBlocked.res.statusCode, 403);
  assert.strictEqual(optionalBlocked.res.body.code, 'PROFILE_COMPLETION_REQUIRED');
  assert.strictEqual(optionalBlocked.nextCalls, 0);

  cachedUser = {
    _id: 'legacy-user-id',
    username: 'legacy-user',
    userType: 'player',
    isActive: true
  };
  const legacyCompleteUser = await run(protect);
  assert.strictEqual(legacyCompleteUser.res.statusCode, 200);
  assert.strictEqual(legacyCompleteUser.nextCalls, 1);

  decodedToken = { id: 'guest-id', userType: 'guest', username: 'Guest' };
  const guest = await run(optionalAuth);
  assert.strictEqual(guest.res.statusCode, 200);
  assert.strictEqual(guest.nextCalls, 1);
  assert.strictEqual(guest.req.user.userType, 'guest');

  console.log('Auth profile-completion middleware tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
