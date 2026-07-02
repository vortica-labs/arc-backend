#!/usr/bin/env node
require('dotenv').config();

const { createPrivateKey } = require('crypto');

const strict = process.argv.includes('--release') || process.env.REQUIRE_PUSH_PROVIDER_CREDENTIALS === '1';
const failures = [];
const warnings = [];
const value = (name) => String(process.env[name] || '').trim();

const readPrivateKey = () => {
  const raw = value('APNS_PRIVATE_KEY') || value('APNS_PRIVATE_KEY_BASE64');
  if (!raw) return '';
  if (raw.includes('BEGIN PRIVATE KEY')) return raw.replace(/\\n/g, '\n');
  try { return Buffer.from(raw, 'base64').toString('utf8'); } catch { return ''; }
};

if (value('PUSH_NOTIFICATION_PROVIDER') && value('PUSH_NOTIFICATION_PROVIDER') !== 'expo') {
  failures.push('PUSH_NOTIFICATION_PROVIDER must be expo for standard push delivery');
}

const apnsFields = ['APNS_TEAM_ID', 'APNS_KEY_ID'];
for (const name of apnsFields) {
  if (!value(name)) failures.push(`${name} is required for killed/locked iOS incoming calls`);
}
const privateKey = readPrivateKey();
if (!privateKey.includes('BEGIN PRIVATE KEY')) {
  failures.push('APNS_PRIVATE_KEY or APNS_PRIVATE_KEY_BASE64 must contain an APNs .p8 private key');
} else {
  try {
    const key = createPrivateKey(privateKey);
    if (key.asymmetricKeyType !== 'ec') failures.push('APNs private key must be an EC key');
  } catch {
    failures.push('APNs private key could not be parsed');
  }
}

const bundleId = value('APNS_BUNDLE_ID') || 'com.arcSquadHunt';
const topic = value('APNS_VOIP_TOPIC') || `${bundleId}.voip`;
if (!/^[A-Za-z0-9.-]+$/.test(bundleId)) failures.push('APNS_BUNDLE_ID is invalid');
if (topic !== `${bundleId}.voip`) {
  const message = `APNS_VOIP_TOPIC must equal ${bundleId}.voip (received ${topic})`;
  if (strict) failures.push(message); else warnings.push(message);
}
const apnsEnvironment = value('APNS_ENVIRONMENT') || (process.env.NODE_ENV === 'production' ? 'production' : 'sandbox');
if (apnsEnvironment !== 'production') {
  const message = 'APNS_ENVIRONMENT must be production for a release build';
  if (strict) failures.push(message); else warnings.push(message);
}
const expoSecurityMode = value('EXPO_PUSH_SECURITY_MODE').toLowerCase() || 'enabled';
if (!['enabled', 'disabled'].includes(expoSecurityMode)) {
  failures.push('EXPO_PUSH_SECURITY_MODE must be enabled or disabled');
}
if (!value('EXPO_ACCESS_TOKEN') && expoSecurityMode !== 'disabled') {
  const message = 'EXPO_ACCESS_TOKEN is required unless EXPO_PUSH_SECURITY_MODE=disabled is explicitly asserted';
  if (strict) failures.push(message); else warnings.push(message);
}

const result = {
  strict,
  standardProvider: 'expo',
  apnsVoip: {
    configured: failures.length === 0,
    teamIdPresent: Boolean(value('APNS_TEAM_ID')),
    keyIdPresent: Boolean(value('APNS_KEY_ID')),
    privateKeyPresent: Boolean(privateKey),
    bundleId,
    topic,
    environment: apnsEnvironment
  },
  expoPushSecurity: { mode: expoSecurityMode, accessTokenPresent: Boolean(value('EXPO_ACCESS_TOKEN')) },
  warnings,
  failures
};
console.log(JSON.stringify(result, null, 2));

if (strict && failures.length) {
  console.error('Push provider release readiness failed:');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}
if (!strict && failures.length) failures.forEach((failure) => console.warn(`Warning: ${failure}.`));
