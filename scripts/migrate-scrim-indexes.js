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

const Scrim = require(path.resolve(__dirname, '..', 'src', 'legacy-src', 'models', 'Scrim.js'));
const User = require(path.resolve(__dirname, '..', 'src', 'legacy-src', 'models', 'User.js'));

const normalizeKey = (key) => JSON.stringify(Object.entries(key || {}));
const normalizeOptions = (options = {}) => ({
  unique: options.unique === true,
  sparse: options.sparse === true,
  expireAfterSeconds: Object.prototype.hasOwnProperty.call(options, 'expireAfterSeconds')
    ? Number(options.expireAfterSeconds)
    : null
});

const verifyIndexes = async (Model) => {
  const expected = Model.schema.indexes();
  const actual = await Model.collection.indexes();
  const missing = expected.filter(([key, options]) => !actual.some((index) => (
    normalizeKey(index.key) === normalizeKey(key)
    && JSON.stringify(normalizeOptions(index)) === JSON.stringify(normalizeOptions(options))
  )));
  if (missing.length > 0) {
    throw new Error(`Scrim is missing or has incompatible indexes: ${missing
      .map(([key, options]) => `${normalizeKey(key)} ${JSON.stringify(normalizeOptions(options))}`)
      .join(', ')}`);
  }
  console.log(`verified Scrim indexes: ${expected.length}`);
};

const auditIntegrity = async () => {
  // Use the raw collection so missing legacy arrays are visible instead of
  // being materialized from Mongoose defaults during hydration.
  const scrims = await Scrim.collection.find({}, {
    projection: {
      _id: 1,
      name: 1,
      description: 1,
      host: 1,
      format: 1,
      status: 1,
      date: 1,
      endDate: 1,
      maxTeams: 1,
      numberOfMatches: 1,
      matches: 1,
      registeredTeams: 1,
      scrimCode: 1,
      prizePool: 1,
      prizeDistribution: 1,
      specialPrizes: 1,
      broadcasts: 1
    }
  }).toArray();
  const referencedUserIds = new Set();
  scrims.forEach((scrim) => {
    if (scrim.host) referencedUserIds.add(String(scrim.host));
    (scrim.registeredTeams || []).forEach((participant) => referencedUserIds.add(String(participant)));
  });
  const validReferencedUserIds = [...referencedUserIds].filter((id) => mongoose.Types.ObjectId.isValid(id));
  const users = validReferencedUserIds.length > 0
    ? await User.find({ _id: { $in: validReferencedUserIds } }).select('_id userType isActive moderationStatus').lean()
    : [];
  const usersById = new Map(users.map((user) => [String(user._id), user]));

  const counters = {
    scanned: scrims.length,
    invalidHostReferences: 0,
    invalidParticipantReferences: 0,
    invalidSquadParticipantTypes: 0,
    missingParticipantArrays: 0,
    duplicateParticipants: 0,
    overCapacity: 0,
    invalidCapacity: 0,
    invalidDates: 0,
    invalidStatuses: 0,
    invalidMatchConfiguration: 0,
    invalidCodes: 0,
    invalidDescriptions: 0,
    invalidPrizeConfigurations: 0,
    invalidBroadcastEntries: 0
  };
  const affected = [];
  const validStatuses = new Set(['Open', 'Full', 'In Progress', 'Completed', 'Cancelled']);
  const codePattern = /^SCR-BGM-[A-F0-9]{8}$/;

  let cleaned = 0;
  const applyCleanup = process.argv.includes('--apply-cleanup');
  for (const scrim of scrims) {
    const issues = [];
    const host = usersById.get(String(scrim.host || ''));
    if (!host || host.isActive === false || ['banned', 'soft_deleted'].includes(host.moderationStatus)) {
      counters.invalidHostReferences += 1;
      issues.push('host');
    }
    const rawParticipants = Array.isArray(scrim.registeredTeams) ? scrim.registeredTeams : [];
    if (!Array.isArray(scrim.registeredTeams)) {
      counters.missingParticipantArrays += 1;
      issues.push('missingParticipantArray');
    }
    const participantIds = rawParticipants.map(String);
    const uniqueIds = new Set(participantIds);
    if (uniqueIds.size !== participantIds.length) {
      counters.duplicateParticipants += participantIds.length - uniqueIds.size;
      issues.push('duplicateParticipants');
    }
    for (const participantId of uniqueIds) {
      const participant = usersById.get(participantId);
      if (!participant || participant.isActive === false || ['banned', 'soft_deleted'].includes(participant.moderationStatus)) {
        counters.invalidParticipantReferences += 1;
        issues.push('participantReference');
      } else if (scrim.format === 'Squad' && participant.userType !== 'team') {
        counters.invalidSquadParticipantTypes += 1;
        issues.push('participantType');
      }
    }

    const activeRegistration = ['Open', 'Full'].includes(scrim.status);
    const participantCleanupAllowed = ['Open', 'Full', 'In Progress'].includes(scrim.status);
    if (applyCleanup && (participantCleanupAllowed || !Array.isArray(scrim.registeredTeams))) {
      const seen = new Set();
      const normalizedParticipants = (participantCleanupAllowed ? rawParticipants : []).filter((participantId) => {
        const key = String(participantId);
        if (seen.has(key)) return false;
        seen.add(key);
        const participant = usersById.get(key);
        if (!participant || participant.isActive === false || ['banned', 'soft_deleted'].includes(participant.moderationStatus)) {
          return false;
        }
        return scrim.format !== 'Squad' || participant.userType === 'team';
      });
      const validCapacity = Number.isInteger(scrim.maxTeams) && scrim.maxTeams >= 16 && scrim.maxTeams <= 25;
      const normalizedStatus = activeRegistration && validCapacity
        ? (normalizedParticipants.length >= scrim.maxTeams ? 'Full' : 'Open')
        : scrim.status;
      const participantsChanged = normalizedParticipants.length !== rawParticipants.length
        || normalizedParticipants.some((value, index) => String(value) !== String(rawParticipants[index]));
      if (participantsChanged || !Array.isArray(scrim.registeredTeams) || normalizedStatus !== scrim.status) {
        const cleanupResult = await Scrim.collection.updateOne(
          { _id: scrim._id, status: scrim.status },
          {
            $set: {
              registeredTeams: normalizedParticipants,
              status: normalizedStatus,
              updatedAt: new Date()
            }
          }
        );
        cleaned += Number(cleanupResult?.modifiedCount || cleanupResult?.nModified || 0);
      }
    }
    if (!Number.isInteger(scrim.maxTeams) || scrim.maxTeams < 16 || scrim.maxTeams > 25) {
      counters.invalidCapacity += 1;
      issues.push('capacity');
    } else if (participantIds.length > scrim.maxTeams) {
      counters.overCapacity += 1;
      issues.push('overCapacity');
    }
    const dateTime = new Date(scrim.date).getTime();
    const endTime = scrim.endDate == null ? null : new Date(scrim.endDate).getTime();
    if (Number.isNaN(dateTime) || Number.isNaN(endTime) || (endTime != null && endTime < dateTime)) {
      counters.invalidDates += 1;
      issues.push('dates');
    }
    if (!validStatuses.has(scrim.status)) {
      counters.invalidStatuses += 1;
      issues.push('status');
    }
    if (!Number.isInteger(scrim.numberOfMatches)
      || scrim.numberOfMatches < 1
      || scrim.numberOfMatches > 6
      || !Array.isArray(scrim.matches)
      || scrim.matches.length !== scrim.numberOfMatches) {
      counters.invalidMatchConfiguration += 1;
      issues.push('matches');
    }
    if (!codePattern.test(String(scrim.scrimCode || ''))) {
      counters.invalidCodes += 1;
      issues.push('code');
    }
    if (scrim.description != null && (typeof scrim.description !== 'string' || scrim.description.length > 5000)) {
      counters.invalidDescriptions += 1;
      issues.push('description');
    }

    const distribution = Array.isArray(scrim.prizeDistribution) ? scrim.prizeDistribution : [];
    const specialPrizes = Array.isArray(scrim.specialPrizes) ? scrim.specialPrizes : [];
    const ranks = distribution.map((entry) => Number(entry?.rank));
    const categories = specialPrizes.map((entry) => String(entry?.category || '').trim().toLowerCase());
    const prizeAmounts = [...distribution, ...specialPrizes].map((entry) => Number(entry?.amount));
    const percentages = distribution.map((entry) => Number(entry?.percentage || 0));
    const invalidPrizeConfiguration = (scrim.prizeDistribution != null && !Array.isArray(scrim.prizeDistribution))
      || (scrim.specialPrizes != null && !Array.isArray(scrim.specialPrizes))
      || !Number.isFinite(Number(scrim.prizePool || 0))
      || Number(scrim.prizePool || 0) < 0
      || ranks.some((rank) => !Number.isInteger(rank) || rank < 1)
      || new Set(ranks).size !== ranks.length
      || distribution.some((entry) => String(entry?.label || '').length > 120)
      || categories.some((category) => !category || category.length > 120)
      || new Set(categories).size !== categories.length
      || prizeAmounts.some((amount) => !Number.isFinite(amount) || amount < 0)
      || percentages.some((percentage) => !Number.isFinite(percentage) || percentage < 0 || percentage > 100)
      || prizeAmounts.reduce((sum, amount) => sum + amount, 0) > Number(scrim.prizePool || 0);
    if (invalidPrizeConfiguration) {
      counters.invalidPrizeConfigurations += 1;
      issues.push('prizes');
    }

    const invalidBroadcastCount = (scrim.broadcasts != null && !Array.isArray(scrim.broadcasts) ? 1 : 0)
      + (Array.isArray(scrim.broadcasts) ? scrim.broadcasts : [])
      .filter((broadcast) => (
        typeof broadcast?.message !== 'string'
        || !broadcast.message
        || broadcast.message.length > 2000
        || !['info', 'warning', 'match_starting', 'custom'].includes(broadcast.type || 'info')
        || (broadcast.senderName != null && String(broadcast.senderName).length > 120)
      )).length;
    if (invalidBroadcastCount > 0) {
      counters.invalidBroadcastEntries += invalidBroadcastCount;
      issues.push('broadcasts');
    }
    if (issues.length > 0 && affected.length < 20) {
      affected.push({ id: String(scrim._id), name: scrim.name, issues: [...new Set(issues)] });
    }
  }

  const duplicateCodes = await Scrim.aggregate([
    { $group: { _id: '$scrimCode', count: { $sum: 1 } } },
    { $match: { _id: { $ne: null }, count: { $gt: 1 } } },
    { $limit: 20 }
  ]);
  const summary = { ...counters, duplicateScrimCodes: duplicateCodes.length, cleaned, samples: affected };
  console.log(`scrim integrity audit: ${JSON.stringify(summary)}`);
  const issueCount = Object.entries(summary)
    .filter(([key, value]) => !['scanned', 'cleaned', 'samples'].includes(key) && typeof value === 'number')
    .reduce((total, [, value]) => total + value, 0);
  if (process.argv.includes('--strict-integrity') && issueCount > 0) {
    throw new Error('Scrim integrity verification failed; reconcile the reported records before deployment');
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

  if (process.argv.includes('--apply')) {
    await Scrim.createIndexes();
    console.log('created/confirmed Scrim indexes');
  }
  await verifyIndexes(Scrim);
  await auditIntegrity();
  await mongoose.disconnect();
};

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
