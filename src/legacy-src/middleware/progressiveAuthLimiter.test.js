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
  res.locals = {};
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

function sendRateLimit(res, limit) {
  res.setHeader('Retry-After', String(limit.retryAfter));
  return res.status(429).json({
    success: false,
    message: limit.message,
    error: 'RATE_LIMIT_EXCEEDED',
    retryAfter: limit.retryAfter
  });
}

async function simulateInvalidCredentials(limiter, req) {
  const res = createRes();
  let nextCalled = false;

  await limiter(req, res, async () => {
    nextCalled = true;
    const limit = await res.locals.progressiveAuthLimiter.recordFailure();
    if (limit) return sendRateLimit(res, limit);
    return res.status(401).json({
      success: false,
      message: 'Invalid email or password.'
    });
  });

  await waitForFinishTracking();
  return { res, nextCalled };
}

async function simulateSuccessfulLogin(limiter, req) {
  const res = createRes();
  let nextCalled = false;

  await limiter(req, res, async () => {
    nextCalled = true;
    await res.locals.progressiveAuthLimiter.reset();
    return res.status(200).json({ success: true });
  });

  await waitForFinishTracking();
  return { res, nextCalled };
}

(async () => {
  localStore.clear();
  const limiter = createProgressiveAuthLimiter({ kind: 'password', name: 'login_test' });
  const lockedUserReq = createReq({
    ip: '203.0.113.10',
    body: { email: 'user@example.com', password: 'wrong-password' }
  });

  const firstFailure = await simulateInvalidCredentials(limiter, lockedUserReq);
  assert.strictEqual(firstFailure.nextCalled, true);
  assert.strictEqual(firstFailure.res.statusCode, 401);
  assert.strictEqual(firstFailure.res.body.message, 'Invalid email or password.');

  const secondFailure = await simulateInvalidCredentials(limiter, lockedUserReq);
  assert.strictEqual(secondFailure.nextCalled, true);
  assert.strictEqual(secondFailure.res.statusCode, 401);
  assert.strictEqual(secondFailure.res.body.message, 'Invalid email or password.');

  const thirdFailure = await simulateInvalidCredentials(limiter, lockedUserReq);
  assert.strictEqual(thirdFailure.nextCalled, true);
  assert.strictEqual(thirdFailure.res.statusCode, 429);
  assert.strictEqual(thirdFailure.res.body.error, 'RATE_LIMIT_EXCEEDED');
  assert.strictEqual(thirdFailure.res.body.retryAfter, 30);
  assert.match(thirdFailure.res.body.message, /Too many failed login attempts/);

  const correctPasswordDuringCooldown = await simulateSuccessfulLogin(
    limiter,
    createReq({
      ip: '203.0.113.10',
      body: { email: 'user@example.com', password: 'correct-password' }
    }),
  );

  assert.strictEqual(correctPasswordDuringCooldown.nextCalled, false);
  assert.strictEqual(correctPasswordDuringCooldown.res.statusCode, 429);
  assert.strictEqual(correctPasswordDuringCooldown.res.body.error, 'RATE_LIMIT_EXCEEDED');
  assert.ok(Number(correctPasswordDuringCooldown.res.headers['Retry-After']) > 0);

  const accountBlockedFromDifferentIp = await simulateSuccessfulLogin(
    limiter,
    createReq({
      ip: '203.0.113.11',
      body: { email: 'user@example.com', password: 'correct-password' }
    })
  );

  assert.strictEqual(accountBlockedFromDifferentIp.nextCalled, false);
  assert.strictEqual(accountBlockedFromDifferentIp.res.statusCode, 429);

  const ipBlockedForDifferentAccount = await simulateSuccessfulLogin(
    limiter,
    createReq({
      ip: '203.0.113.10',
      body: { email: 'other@example.com', password: 'correct-password' }
    })
  );

  assert.strictEqual(ipBlockedForDifferentAccount.nextCalled, false);
  assert.strictEqual(ipBlockedForDifferentAccount.res.statusCode, 429);

  const unrelatedLogin = await simulateSuccessfulLogin(
    limiter,
    createReq({
      ip: '203.0.113.12',
      body: { email: 'other@example.com', password: 'correct-password' }
    })
  );

  assert.strictEqual(unrelatedLogin.nextCalled, true);
  assert.strictEqual(unrelatedLogin.res.statusCode, 200);

  assert.deepStrictEqual(
    getLimitKeys(createReq({ ip: '203.0.113.10', body: { username: 'PlayerOne' } }), 'login_test', 'password'),
    ['login_test|ip|203.0.113.10', 'login_test|pair|203.0.113.10|playerone', 'login_test|account|playerone']
  );

  const expiredAt = Date.now() - 1000;
  for (const key of getLimitKeys(lockedUserReq, 'login_test', 'password')) {
    const entry = localStore.get(key);
    if (entry) {
      entry.blockedUntilMs = expiredAt;
      localStore.set(key, entry);
    }
  }

  const afterCooldown = await simulateSuccessfulLogin(limiter, lockedUserReq);
  assert.strictEqual(afterCooldown.nextCalled, true);
  assert.strictEqual(afterCooldown.res.statusCode, 200);

  localStore.clear();
  const resetReq = createReq({
    ip: '198.51.100.3',
    body: { email: 'reset@example.com', password: 'wrong-password' }
  });
  assert.strictEqual((await simulateInvalidCredentials(limiter, resetReq)).res.statusCode, 401);
  assert.strictEqual((await simulateSuccessfulLogin(limiter, resetReq)).res.statusCode, 200);
  assert.strictEqual((await simulateInvalidCredentials(limiter, resetReq)).res.statusCode, 401);
  assert.strictEqual((await simulateInvalidCredentials(limiter, resetReq)).res.statusCode, 401);

  localStore.clear();
  console.log('Progressive auth limiter tests passed');
})();
