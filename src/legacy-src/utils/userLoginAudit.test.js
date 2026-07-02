const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const {
  createLoginEventRecorder,
  safeLoginEvent,
} = require('./userLoginAudit');

const userId = new mongoose.Types.ObjectId();
const event = safeLoginEvent({
  user: { _id: userId },
  authMethod: 'apple_mobile',
  request: {
    ip: '203.0.113.10',
    headers: {
      'user-agent': `iPhone ${'x'.repeat(700)}`,
      'x-app-platform': 'ios',
      'x-device-name': `Test iPhone ${'y'.repeat(200)}`,
      authorization: 'Bearer must-never-be-copied',
      cookie: 'session=must-never-be-copied',
    },
  },
});

assert.deepEqual(Object.keys(event).sort(), [
  'authMethod',
  'device',
  'ip',
  'platform',
  'timestamp',
  'user',
  'userAgent',
]);
assert.equal(String(event.user), String(userId));
assert.equal(event.authMethod, 'apple_mobile');
assert.equal(event.ip, '203.0.113.10');
assert.equal(event.platform, 'ios');
assert.equal(event.userAgent.length, 512);
assert.equal(event.device.length, 120);
assert.equal(JSON.stringify(event).includes('must-never-be-copied'), false);
assert.equal(safeLoginEvent({ user: userId, authMethod: 'unsupported', request: {} }), null);
assert.equal(safeLoginEvent({ user: 'not-an-object-id', authMethod: 'password', request: {} }), null);

async function run() {
  const created = [];
  const recorder = createLoginEventRecorder({
    model: { create: async (value) => { created.push(value); } },
    connection: { readyState: 1 },
    logger: { warn: () => assert.fail('successful writes must not warn') },
  });
  assert.equal(await recorder({ user: userId, authMethod: 'password', request: { headers: { 'user-agent': 'Mozilla/5.0' } } }), true);
  assert.equal(created.length, 1);
  assert.equal(created[0].platform, 'web');

  let warned = false;
  const failingRecorder = createLoginEventRecorder({
    model: { create: async () => { throw Object.assign(new Error('database detail must not escape'), { code: 'WRITE_FAILED' }); } },
    connection: { readyState: 1 },
    logger: {
      warn: (message, metadata) => {
        warned = true;
        assert.equal(message, 'Successful login audit could not be stored');
        assert.deepEqual(metadata, { code: 'WRITE_FAILED' });
      },
    },
  });
  assert.equal(await failingRecorder({ user: userId, authMethod: 'otp', request: {} }), false, 'audit storage failures must never fail login');
  assert.equal(warned, true);

  const failingLoggerRecorder = createLoginEventRecorder({
    model: { create: async () => { throw new Error('storage unavailable'); } },
    connection: { readyState: 1 },
    logger: { warn: () => { throw new Error('logger unavailable'); } },
  });
  assert.equal(await failingLoggerRecorder({ user: userId, authMethod: 'password', request: {} }), false, 'audit diagnostics must also remain fail-open');

  let disconnectedWrites = 0;
  const disconnectedRecorder = createLoginEventRecorder({
    model: { create: async () => { disconnectedWrites += 1; } },
    connection: { readyState: 0 },
    logger: { warn: () => {} },
  });
  assert.equal(await disconnectedRecorder({ user: userId, authMethod: 'google_token', request: {} }), false);
  assert.equal(disconnectedWrites, 0, 'disconnected audit storage must short-circuit without buffering');

  console.log('User login audit utility tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
