const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');
const UserLoginEvent = require('./UserLoginEvent');

const allowedPaths = new Set([
  '_id',
  'user',
  'authMethod',
  'timestamp',
  'ip',
  'userAgent',
  'platform',
  'device',
]);
for (const pathName of Object.keys(UserLoginEvent.schema.paths)) {
  assert.ok(allowedPaths.has(pathName), `unexpected login audit field: ${pathName}`);
}
for (const forbidden of ['email', 'username', 'password', 'token', 'refreshToken', 'authorization', 'cookie', 'requestBody']) {
  assert.equal(UserLoginEvent.schema.path(forbidden), undefined, `${forbidden} must never be stored in login audit events`);
}

const indexes = UserLoginEvent.schema.indexes();
const ttl = indexes.find(([keys, options]) => keys.timestamp === 1 && options.expireAfterSeconds);
assert.ok(ttl, 'login events require a TTL retention index');
assert.equal(ttl[1].expireAfterSeconds, UserLoginEvent.RETENTION_SECONDS);
assert.ok(indexes.some(([keys]) => keys.user === 1 && keys.timestamp === -1), 'admin user history requires a user/timestamp index');

const hooks = UserLoginEvent.schema.s.hooks._pres;
for (const operation of [
  'updateOne',
  'updateMany',
  'findOneAndUpdate',
  'replaceOne',
  'findOneAndReplace',
  'deleteOne',
  'deleteMany',
  'findOneAndDelete',
  'bulkWrite',
]) assert.ok(hooks.get(operation)?.length, `${operation} must be blocked for immutable login events`);
assert.ok(hooks.get('deleteOne').some((hook) => hook.document === true && hook.query === false));

assert.throws(() => new UserLoginEvent({
  user: new mongoose.Types.ObjectId(),
  authMethod: 'password',
  token: 'must-not-be-accepted',
}), /not in schema|strict/i);

const root = path.resolve(__dirname, '..', '..', '..');
const controller = fs.readFileSync(path.join(root, 'src', 'legacy-src', 'controllers', 'authController.js'), 'utf8');
for (const method of ['password', 'otp', 'google_token', 'apple_mobile']) {
  assert.ok(controller.includes(`void recordSuccessfulLogin({ user, authMethod: '${method}', request: req });`), `${method} success must be audited fail-open`);
}
const modularRoutes = fs.readFileSync(path.join(root, 'src', 'modules', 'auth', 'auth.routes.ts'), 'utf8');
const legacyRoutes = fs.readFileSync(path.join(root, 'src', 'legacy-src', 'routes', 'auth.js'), 'utf8');
assert.ok(modularRoutes.includes('authMethod: "google_passport"'));
assert.ok(legacyRoutes.includes("authMethod: 'google_passport'"));

const migration = fs.readFileSync(path.join(root, 'scripts', 'migrate-premium-indexes.js'), 'utf8');
assert.ok(migration.includes("'UserLoginEvent'"), 'login event TTL/indexes must be included in explicit index migration');
assert.ok(migration.includes('index.expireAfterSeconds'), 'index verification must detect TTL retention drift');

console.log('User login event model and instrumentation tests passed');
