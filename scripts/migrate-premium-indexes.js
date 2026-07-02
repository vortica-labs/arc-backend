#!/usr/bin/env node
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const uri = process.env.MONGODB_URI;
if (!uri) {
  console.error('MONGODB_URI is required');
  process.exit(1);
}

const modelNames = [
  'PremiumMembership',
  'PremiumMembershipEvent',
  'PremiumMutationClaim',
  'RazorpayWebhookEvent',
  'PaymentTransaction',
  'AdminAuditLog',
  'UserLoginEvent'
];
const loadModels = () => modelNames.map((name) => require(
  path.resolve(__dirname, '..', 'src', 'legacy-src', 'models', `${name}.js`)
));
const stable = (value) => {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = stable(value[key]);
    return result;
  }, {});
};
const same = (left, right) => JSON.stringify(stable(left || {})) === JSON.stringify(stable(right || {}));

async function verifyModel(Model) {
  const expected = Model.schema.indexes();
  const actual = await Model.collection.indexes();
  const missing = expected.filter(([key, options]) => !actual.some((index) =>
    same(index.key, key) &&
    Boolean(index.unique) === Boolean(options.unique) &&
    Boolean(index.sparse) === Boolean(options.sparse) &&
    Number(index.expireAfterSeconds ?? -1) === Number(options.expireAfterSeconds ?? -1) &&
    same(index.partialFilterExpression, options.partialFilterExpression)
  ));
  if (missing.length) {
    throw new Error(`${Model.modelName} is missing indexes: ${missing.map(([key]) => JSON.stringify(key)).join(', ')}`);
  }
  console.log(`verified ${Model.modelName}: ${expected.length} declared indexes`);
}

async function main() {
  await mongoose.connect(uri, {
    autoIndex: false,
    autoCreate: false,
    retryWrites: process.env.MONGODB_TLS === 'true' ? false : true,
    serverSelectionTimeoutMS: 15000,
    ...(process.env.MONGODB_TLS === 'true' ? {
      tls: true,
      ...(process.env.MONGODB_TLS_CA_FILE && fs.existsSync(process.env.MONGODB_TLS_CA_FILE)
        ? { tlsCAFile: process.env.MONGODB_TLS_CA_FILE }
        : {})
    } : {})
  });
  const models = loadModels();
  if (!process.argv.includes('--verify')) {
    for (const Model of models) {
      await Model.createIndexes();
      console.log(`created/confirmed indexes for ${Model.modelName}`);
    }
  }
  for (const Model of models) await verifyModel(Model);
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error?.message || String(error));
  await mongoose.disconnect().catch(() => null);
  process.exit(1);
});
