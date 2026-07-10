const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { extractToken } = require('./jwt');

assert.equal(extractToken({ headers: {}, query: { token: 'must-not-be-accepted' } }), null);
assert.equal(extractToken({ headers: { authorization: 'Bearer header-token' } }), 'header-token');
assert.equal(extractToken({ headers: {}, cookies: { token: 'secure-cookie-token' } }), 'secure-cookie-token');

const backendRoot = path.resolve(__dirname, '../../..');
const infrastructureNotes = fs.readFileSync(path.join(backendRoot, 'aws-infra.txt'), 'utf8');
assert.doesNotMatch(
  infrastructureNotes,
  /mongodb(?:\+srv)?:\/\/[^\s:@/]+:[^\s@/]+@/i,
  'Infrastructure documentation must not contain credential-bearing MongoDB URIs'
);
const documentedDatabasePassword = infrastructureNotes
  .split(/\r?\n/)
  .find((line) => line.startsWith('DocumentDB Pass'));
assert.equal(
  documentedDatabasePassword?.split(':').slice(1).join(':').trim(),
  '<stored in AWS Secrets Manager>',
  'Infrastructure documentation must reference Secrets Manager instead of embedding the database password'
);
const noPayloadKey = spawnSync(process.execPath, ['-e', `
  delete process.env.ENCRYPTION_KEY;
  process.env.ENABLE_PAYLOAD_ENCRYPTION = 'true';
  require('./src/legacy-src/middleware/encryption');
`], { cwd: backendRoot, encoding: 'utf8', env: { ...process.env, ENABLE_PAYLOAD_ENCRYPTION: 'true', ENCRYPTION_KEY: '' } });
assert.notEqual(noPayloadKey.status, 0, 'Enabled payload encryption must fail closed without a key');

const bankRoundTrip = spawnSync(process.execPath, ['-e', `
  process.env.BANK_DETAILS_ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef';
  const crypto = require('crypto');
  const Model = require('./src/legacy-src/models/CreatorBankDetails');
  const encrypted = Model.encryptSensitiveValue('1234567890');
  if (!encrypted.startsWith('v2:')) process.exit(2);
  if (Model.decryptAccountNumber(encrypted) !== '1234567890') process.exit(2);
  const tampered = encrypted.slice(0, -1) + (encrypted.endsWith('0') ? '1' : '0');
  try { Model.decryptAccountNumber(tampered); process.exit(3); } catch (_) {}
  const key = Buffer.from(process.env.BANK_DETAILS_ENCRYPTION_KEY.slice(0, 32).padEnd(32, '0'));
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  const legacy = iv.toString('hex') + ':' + cipher.update('legacy-value', 'utf8', 'hex') + cipher.final('hex');
  if (Model.decryptAccountNumber(legacy) !== 'legacy-value') process.exit(4);
`], { cwd: backendRoot, encoding: 'utf8', env: { ...process.env, BANK_DETAILS_ENCRYPTION_KEY: '0123456789abcdef0123456789abcdef' } });
assert.equal(bankRoundTrip.status, 0, bankRoundTrip.stderr);

const releaseConfig = spawnSync(process.execPath, ['scripts/verify-bank-details-config.js', '--release'], {
  cwd: backendRoot,
  encoding: 'utf8',
  env: {
    ...process.env,
    BANK_DETAILS_ENCRYPTION_KEY: 'bank-key-0123456789abcdef0123456789',
    JWT_SECRET: 'user-jwt-0123456789abcdef0123456789',
    ADMIN_JWT_SECRET: 'admin-jwt-0123456789abcdef012345678'
  }
});
assert.equal(releaseConfig.status, 0, releaseConfig.stderr);

const sharedAdminSecret = spawnSync(process.execPath, ['scripts/verify-bank-details-config.js', '--release'], {
  cwd: backendRoot,
  encoding: 'utf8',
  env: {
    ...process.env,
    BANK_DETAILS_ENCRYPTION_KEY: 'bank-key-0123456789abcdef0123456789',
    JWT_SECRET: 'shared-jwt-0123456789abcdef01234567',
    ADMIN_JWT_SECRET: 'shared-jwt-0123456789abcdef01234567'
  }
});
assert.notEqual(sharedAdminSecret.status, 0, 'Admin and user JWT secrets must be isolated');

const sharedBankAndUserSecret = spawnSync(process.execPath, ['scripts/verify-bank-details-config.js', '--release'], {
  cwd: backendRoot,
  encoding: 'utf8',
  env: {
    ...process.env,
    BANK_DETAILS_ENCRYPTION_KEY: 'shared-bank-jwt-0123456789abcdef0123',
    JWT_SECRET: 'shared-bank-jwt-0123456789abcdef0123',
    ADMIN_JWT_SECRET: 'admin-jwt-0123456789abcdef012345678'
  }
});
assert.notEqual(sharedBankAndUserSecret.status, 0, 'Bank encryption and user JWT secrets must be isolated');

const sharedBankAndAdminSecret = spawnSync(process.execPath, ['scripts/verify-bank-details-config.js', '--release'], {
  cwd: backendRoot,
  encoding: 'utf8',
  env: {
    ...process.env,
    BANK_DETAILS_ENCRYPTION_KEY: 'shared-bank-admin-0123456789abcdef01',
    JWT_SECRET: 'user-jwt-0123456789abcdef0123456789',
    ADMIN_JWT_SECRET: 'shared-bank-admin-0123456789abcdef01'
  }
});
assert.notEqual(sharedBankAndAdminSecret.status, 0, 'Bank encryption and admin JWT secrets must be isolated');

console.log('Credential transport and encryption-key contracts passed');
