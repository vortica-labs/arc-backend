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
  'RandomConnection',
  'ConnectionQueue',
  'RandomConnectAdmission',
  'RandomConnectGenderQuota'
].map((name) => require(
  path.resolve(__dirname, '..', 'src', 'legacy-src', 'models', `${name}.js`)
));

const canonicalize = (value) => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.keys(value).sort().reduce((result, key) => {
    result[key] = canonicalize(value[key]);
    return result;
  }, {});
};

const normalizeKey = (key) => JSON.stringify(Object.entries(key || {}));
const normalizeIndexOptions = (options = {}) => ({
  unique: options.unique === true,
  sparse: options.sparse === true,
  expireAfterSeconds: Object.prototype.hasOwnProperty.call(options, 'expireAfterSeconds')
    ? Number(options.expireAfterSeconds)
    : null,
  partialFilterExpression: options.partialFilterExpression
    ? canonicalize(options.partialFilterExpression)
    : null
});

const indexesMatch = (expectedKey, expectedOptions, actualIndex) => (
  normalizeKey(actualIndex.key) === normalizeKey(expectedKey) &&
  JSON.stringify(normalizeIndexOptions(actualIndex)) ===
    JSON.stringify(normalizeIndexOptions(expectedOptions))
);

const verifyModelIndexes = async (Model) => {
  const expected = Model.schema.indexes();
  const actual = await Model.collection.indexes();
  const missing = expected.filter(([expectedKey, expectedOptions]) => !actual.some((index) => (
    indexesMatch(expectedKey, expectedOptions, index)
  )));
  if (missing.length) {
    throw new Error(`${Model.modelName} is missing or has incompatible indexes: ${missing
      .map(([key, options]) => `${normalizeKey(key)} ${JSON.stringify(normalizeIndexOptions(options))}`)
      .join(', ')}`);
  }
  console.log(`verified ${Model.modelName}: ${expected.length} declared indexes`);
};

const verifyTransactionSupport = async (AdmissionModel) => {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      // Force a real database command; an empty transaction would not prove
      // that the deployment topology supports the atomic match commit.
      await AdmissionModel.findOne({}, { _id: 1 }, { session }).lean();
    }, {
      readPreference: 'primary',
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' }
    });
    console.log('verified MongoDB transaction support for Random Connect');
  } catch (error) {
    throw new Error(`Random Connect requires MongoDB transaction support: ${String(error?.message || error)}`);
  } finally {
    await session.endSession().catch(() => {});
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

  const models = loadModels();
  if (!process.argv.includes('--verify')) {
    for (const Model of models) {
      await Model.createIndexes();
      console.log(`created/confirmed indexes for ${Model.modelName}`);
    }
  }
  for (const Model of models) await verifyModelIndexes(Model);
  if (process.argv.includes('--verify')) {
    const AdmissionModel = models.find((Model) => Model.modelName === 'RandomConnectAdmission');
    if (!AdmissionModel) throw new Error('RandomConnectAdmission model was not loaded');
    await verifyTransactionSupport(AdmissionModel);
  }
  await mongoose.disconnect();
};

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
