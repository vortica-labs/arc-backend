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

const loadModels = () => [
  require(path.resolve(__dirname, '..', 'src', 'legacy-src', 'models', 'Tournament.js')),
  require(path.resolve(__dirname, '..', 'src', 'legacy-src', 'models', 'TournamentHostActiveLock.js'))
];

const normalizeKey = (key) => JSON.stringify(Object.entries(key || {}));
const normalizeOptions = (options = {}) => ({
  unique: options.unique === true,
  sparse: options.sparse === true,
  expireAfterSeconds: Object.prototype.hasOwnProperty.call(options, 'expireAfterSeconds')
    ? Number(options.expireAfterSeconds)
    : null
});

const matches = (expectedKey, expectedOptions, actual) => (
  normalizeKey(actual.key) === normalizeKey(expectedKey)
  && JSON.stringify(normalizeOptions(actual)) === JSON.stringify(normalizeOptions(expectedOptions))
);

const verifyIndexes = async (Model) => {
  const expected = Model.schema.indexes();
  const actual = await Model.collection.indexes();
  const missing = expected.filter(([key, options]) => (
    !actual.some((index) => matches(key, options, index))
  ));
  if (missing.length > 0) {
    throw new Error(`${Model.modelName} is missing or has incompatible indexes: ${missing
      .map(([key, options]) => `${normalizeKey(key)} ${JSON.stringify(normalizeOptions(options))}`)
      .join(', ')}`);
  }
  console.log(`verified ${Model.modelName}: ${expected.length} declared indexes`);
};

const verifyNoDuplicateHostLocks = async (HostLock) => {
  const duplicates = await HostLock.aggregate([
    { $group: { _id: '$host', count: { $sum: 1 } } },
    { $match: { _id: { $ne: null }, count: { $gt: 1 } } },
    { $limit: 1 }
  ]);
  if (duplicates.length > 0) {
    throw new Error('TournamentHostActiveLock contains duplicate hosts; reconcile them before creating the unique index');
  }
};

const main = async () => {
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

  const [Tournament, HostLock] = loadModels();
  await verifyNoDuplicateHostLocks(HostLock);
  if (!process.argv.includes('--verify')) {
    await Tournament.createIndexes();
    await HostLock.createIndexes();
    console.log('created/confirmed Tournament indexes');
  }
  await verifyIndexes(Tournament);
  await verifyIndexes(HostLock);
  await mongoose.disconnect();
};

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
