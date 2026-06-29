const assert = require('assert');
const { EventEmitter } = require('events');
const {
  _private: {
    createProgressiveAuthLimiter,
    getLimitKeys,
    localStore
  }
} = require('./progressiveAuthLimiter');

function createReq({ ip = '127.0.0.1', body = {} } = {}) {
  return { ip, body };
}

function createRes() {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.headers = {};
  res.body = null;
  res.setHeader = (key, value) => {
    res.headers[key] = value;
  };
  res.status = (statusCode) => {
    res.statusCode = statusCode;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    res.emit('finish');
    return res;
  };
  return res;
}

function waitForFinishTracking() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function passThroughLimiter(limiter, req, controllerStatusCode) {
  const res = createRes();
  let nextCalled = false;

  await limiter(req, res, () => {
    nextCalled = true;
    res.statusCode = controllerStatusCode;
    res.emit('finish');
  });

  await waitForFinishTracking();
  return { res, nextCalled };
}

async function recordFailedAttempts(limiter, req, count) {
  for (let i = 0; i < count; i += 1) {
    const result = await passThroughLimiter(limiter, req, 401);
    assert.strictEqual(result.nextCalled, true);
  }
}

(async () => {
  localStore.clear();
  const limiter = createProgressiveAuthLimiter({ kind: 'password', name: 'login_test' });
  const lockedUserReq = createReq({
    ip: '203.0.113.10',
    body: { email: 'user@example.com', password: 'wrong-password' }
  });

  await recordFailedAttempts(limiter, lockedUserReq, 6);

  const correctPasswordDuringCooldown = await passThroughLimiter(
    limiter,
    createReq({
      ip: '203.0.113.10',
      body: { email: 'user@example.com', password: 'correct-password' }
    }),
    200
  );

  assert.strictEqual(correctPasswordDuringCooldown.nextCalled, false);
  assert.strictEqual(correctPasswordDuringCooldown.res.statusCode, 429);
  assert.strictEqual(correctPasswordDuringCooldown.res.body.error, 'RATE_LIMIT_EXCEEDED');
  assert.ok(Number(correctPasswordDuringCooldown.res.headers['Retry-After']) > 0);

  const accountBlockedFromDifferentIp = await passThroughLimiter(
    limiter,
    createReq({
      ip: '203.0.113.11',
      body: { email: 'user@example.com', password: 'correct-password' }
    }),
    200
  );

  assert.strictEqual(accountBlockedFromDifferentIp.nextCalled, false);
  assert.strictEqual(accountBlockedFromDifferentIp.res.statusCode, 429);

  const ipBlockedForDifferentAccount = await passThroughLimiter(
    limiter,
    createReq({
      ip: '203.0.113.10',
      body: { email: 'other@example.com', password: 'correct-password' }
    }),
    200
  );

  assert.strictEqual(ipBlockedForDifferentAccount.nextCalled, false);
  assert.strictEqual(ipBlockedForDifferentAccount.res.statusCode, 429);

  const unrelatedLogin = await passThroughLimiter(
    limiter,
    createReq({
      ip: '203.0.113.12',
      body: { email: 'other@example.com', password: 'correct-password' }
    }),
    200
  );

  assert.strictEqual(unrelatedLogin.nextCalled, true);
  assert.strictEqual(unrelatedLogin.res.statusCode, 200);

  assert.deepStrictEqual(
    getLimitKeys(createReq({ ip: '203.0.113.10', body: { username: 'PlayerOne' } }), 'login_test', 'password'),
    ['login_test|ip|203.0.113.10', 'login_test|pair|203.0.113.10|playerone', 'login_test|account|playerone']
  );

  localStore.clear();
  console.log('Progressive auth limiter tests passed');
})();
