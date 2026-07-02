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

const apply = process.argv.includes('--apply');
const verifyOnly = process.argv.includes('--verify');
if (apply && verifyOnly) {
  console.error('Use either --apply or --verify, not both');
  process.exit(1);
}

const root = path.resolve(__dirname, '..', 'src', 'legacy-src');
const User = require(path.join(root, 'models', 'User.js'));
const Follow = require(path.join(root, 'models', 'Follow.js'));
const FollowRequest = require(path.join(root, 'models', 'FollowRequest.js'));
const {
  normalizePrivacySettings,
  canonicalToLegacyAliases
} = require(path.join(root, 'utils', 'privacyPolicy.js'));

const connect = () => mongoose.connect(uri, {
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

const auditAndBackfill = async () => {
  let scanned = 0;
  let changed = 0;
  let operations = [];
  const cursor = User.find({}).select('_id privacySettings').lean().cursor();
  for await (const user of cursor) {
    scanned += 1;
    const canonical = normalizePrivacySettings(user.privacySettings);
    const aliases = canonicalToLegacyAliases(canonical);
    const current = user.privacySettings || {};
    const desired = { ...canonical, ...aliases };
    const needsUpdate = Object.entries(desired).some(([key, value]) => current[key] !== value);
    if (!needsUpdate) continue;
    changed += 1;
    if (apply) {
      operations.push({
        updateOne: {
          filter: { _id: user._id },
          update: {
            $set: Object.fromEntries(
              Object.entries(desired).map(([key, value]) => [`privacySettings.${key}`, value])
            )
          }
        }
      });
    }
    if (apply && operations.length >= 500) {
      await User.bulkWrite(operations, { ordered: false });
      operations = [];
    }
  }
  if (apply && operations.length) await User.bulkWrite(operations, { ordered: false });
  console.log(`${apply ? 'backfilled' : 'would backfill'} ${changed} of ${scanned} users`);
  return { scanned, changed };
};

const validUniqueIds = (values, selfId) => [...new Set((values || [])
  .map((value) => String(value))
  .filter((value) => mongoose.Types.ObjectId.isValid(value) && value !== String(selfId)))];

const chunksOf = (values, size = 500) => {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
};

/**
 * Follow is the authorization source of truth. Historical User arrays are
 * accepted only when both sides recorded the same edge; a one-sided array can
 * be the residue of a partial write and must not grant access to private data.
 */
const auditAcceptedFollowRelationships = async ({ backfill = false } = {}) => {
  let reciprocalEdges = 0;
  let missingCanonicalEdges = 0;
  let oneSidedFollowingEdges = 0;
  let oneSidedFollowerEdges = 0;

  const followingCursor = User.find({ 'following.0': { $exists: true } })
    .select('_id following')
    .lean()
    .cursor();
  for await (const follower of followingCursor) {
    for (const idChunk of chunksOf(validUniqueIds(follower.following, follower._id))) {
      const reciprocalTargetIds = await User.find({
        _id: { $in: idChunk },
        followers: follower._id
      }).distinct('_id');
      const reciprocalStrings = reciprocalTargetIds.map(String);
      reciprocalEdges += reciprocalStrings.length;
      oneSidedFollowingEdges += idChunk.length - reciprocalStrings.length;
      if (reciprocalStrings.length === 0) continue;

      const existing = new Set((await Follow.find({
        follower: follower._id,
        following: { $in: reciprocalTargetIds }
      }).select('following').lean()).map((edge) => String(edge.following)));
      const missing = reciprocalStrings.filter((targetId) => !existing.has(targetId));
      missingCanonicalEdges += missing.length;
      if (backfill && missing.length > 0) {
        await Follow.bulkWrite(missing.map((targetId) => ({
          updateOne: {
            filter: { follower: follower._id, following: targetId },
            update: { $setOnInsert: { follower: follower._id, following: targetId } },
            upsert: true
          }
        })), { ordered: false });
      }
    }
  }

  // Count the opposite one-sided shape as well: target.followers contains a
  // source whose source.following does not contain the target.
  const followerCursor = User.find({ 'followers.0': { $exists: true } })
    .select('_id followers')
    .lean()
    .cursor();
  for await (const target of followerCursor) {
    for (const idChunk of chunksOf(validUniqueIds(target.followers, target._id))) {
      const reciprocalSourceIds = await User.find({
        _id: { $in: idChunk },
        following: target._id
      }).distinct('_id');
      oneSidedFollowerEdges += idChunk.length - reciprocalSourceIds.length;
    }
  }

  console.log([
    `${backfill ? 'backfilled' : 'would backfill'} ${missingCanonicalEdges} canonical Follow edges`,
    `${reciprocalEdges} reciprocal legacy edges audited`,
    `${oneSidedFollowingEdges} following-only and ${oneSidedFollowerEdges} follower-only legacy edges ignored`
  ].join('; '));
  return { reciprocalEdges, missingCanonicalEdges, oneSidedFollowingEdges, oneSidedFollowerEdges };
};

const auditDuplicateRelationshipRecords = async ({ repair = false } = {}) => {
  const duplicateFollowGroups = await Follow.aggregate([
    { $sort: { createdAt: 1, _id: 1 } },
    { $group: { _id: { follower: '$follower', following: '$following' }, ids: { $push: '$_id' }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } }
  ]).allowDiskUse(true);
  const duplicatePendingGroups = await FollowRequest.aggregate([
    { $match: { status: 'pending' } },
    { $sort: { createdAt: 1, _id: 1 } },
    { $group: { _id: { requester: '$requester', target: '$target' }, ids: { $push: '$_id' }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } }
  ]).allowDiskUse(true);

  const duplicateFollowIds = duplicateFollowGroups.flatMap((group) => group.ids.slice(1));
  const duplicatePendingIds = duplicatePendingGroups.flatMap((group) => group.ids.slice(1));
  if (repair && duplicateFollowIds.length > 0) {
    for (const idChunk of chunksOf(duplicateFollowIds)) {
      await Follow.deleteMany({ _id: { $in: idChunk } });
    }
  }
  if (repair && duplicatePendingIds.length > 0) {
    const resolvedAt = new Date();
    for (const idChunk of chunksOf(duplicatePendingIds)) {
      await FollowRequest.updateMany(
        { _id: { $in: idChunk }, status: 'pending' },
        { $set: { status: 'cancelled', resolvedAt } }
      );
    }
  }
  console.log(`${repair ? 'repaired' : 'found'} ${duplicateFollowIds.length} duplicate Follow records and ${duplicatePendingIds.length} duplicate pending follow requests`);
  return { duplicateFollowRecords: duplicateFollowIds.length, duplicatePendingRequests: duplicatePendingIds.length };
};

const verifyCanonicalFields = async () => {
  const invalid = await User.countDocuments({
    $or: [
      { 'privacySettings.profileVisibility': { $nin: ['public', 'followers', 'private'] } },
      { 'privacySettings.allowMessageFrom': { $nin: ['everyone', 'followers', 'none'] } },
      { 'privacySettings.showOnlineStatus': { $not: { $type: 'bool' } } },
      { 'privacySettings.allowFollowRequests': { $not: { $type: 'bool' } } },
      { 'privacySettings.showPostsToFollowers': { $not: { $type: 'bool' } } }
    ]
  });
  if (invalid > 0) throw new Error(`${invalid} users have missing or invalid canonical privacy fields`);
  const aliasMismatch = await User.countDocuments({
    $expr: {
      $or: [
        {
          $ne: [
            '$privacySettings.accountType',
            {
              $cond: [
                { $eq: ['$privacySettings.profileVisibility', 'followers'] },
                'private',
                '$privacySettings.profileVisibility'
              ]
            }
          ]
        },
        {
          $ne: [
            '$privacySettings.whoCanMessage',
            {
              $switch: {
                branches: [
                  { case: { $eq: ['$privacySettings.allowMessageFrom', 'everyone'] }, then: 'anyone' },
                  { case: { $eq: ['$privacySettings.allowMessageFrom', 'followers'] }, then: 'people_you_follow' }
                ],
                default: 'nobody'
              }
            }
          ]
        },
        { $ne: ['$privacySettings.showActivityStatus', '$privacySettings.showOnlineStatus'] }
      ]
    }
  });
  if (aliasMismatch > 0) throw new Error(`${aliasMismatch} users have inconsistent canonical and legacy privacy fields`);
  console.log('verified canonical privacy fields for every user');
};

const privacyUserIndexKeys = [
  { isActive: 1, 'privacySettings.profileVisibility': 1, _id: 1 },
  { isActive: 1, 'privacySettings.showPostsToFollowers': 1, _id: 1 }
];

const verifyIndexes = async (Model, expectedIndexes = Model.schema.indexes()) => {
  const actual = await Model.collection.indexes();
  const canonical = (value) => {
    if (Array.isArray(value)) return value.map(canonical);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  };
  const missing = expectedIndexes.filter(([key, options]) => !actual.some((index) => (
    JSON.stringify(index.key) === JSON.stringify(key)
    && Boolean(index.unique) === Boolean(options.unique)
    && JSON.stringify(canonical(index.partialFilterExpression || null))
      === JSON.stringify(canonical(options.partialFilterExpression || null))
  )));
  if (missing.length) throw new Error(`${Model.modelName} is missing ${missing.length} declared index(es)`);
  console.log(`verified ${Model.modelName} indexes`);
};

const main = async () => {
  await connect();
  if (verifyOnly) {
    const duplicates = await auditDuplicateRelationshipRecords();
    if (duplicates.duplicateFollowRecords > 0 || duplicates.duplicatePendingRequests > 0) {
      throw new Error('Duplicate canonical follow records must be repaired before verification');
    }
    await verifyCanonicalFields();
    const followAudit = await auditAcceptedFollowRelationships();
    if (followAudit.missingCanonicalEdges > 0) {
      throw new Error(`${followAudit.missingCanonicalEdges} reciprocal legacy relationships are missing canonical Follow records`);
    }
    const userIndexes = User.schema.indexes().filter(([key]) => privacyUserIndexKeys.some((expected) => JSON.stringify(expected) === JSON.stringify(key)));
    await verifyIndexes(User, userIndexes);
    await verifyIndexes(Follow);
    await verifyIndexes(FollowRequest);
  } else {
    await auditDuplicateRelationshipRecords({ repair: apply });
    await auditAndBackfill();
    await auditAcceptedFollowRelationships({ backfill: apply });
    if (apply) {
      for (const key of privacyUserIndexKeys) await User.collection.createIndex(key);
      await Follow.createIndexes();
      await FollowRequest.createIndexes();
      const duplicates = await auditDuplicateRelationshipRecords();
      if (duplicates.duplicateFollowRecords > 0 || duplicates.duplicatePendingRequests > 0) {
        throw new Error('Duplicate canonical follow records remain after repair');
      }
      await verifyCanonicalFields();
      const followAudit = await auditAcceptedFollowRelationships();
      if (followAudit.missingCanonicalEdges > 0) {
        throw new Error(`${followAudit.missingCanonicalEdges} reciprocal legacy relationships remain missing after backfill`);
      }
      const userIndexes = User.schema.indexes().filter(([key]) => privacyUserIndexKeys.some((expected) => JSON.stringify(expected) === JSON.stringify(key)));
      await verifyIndexes(User, userIndexes);
      await verifyIndexes(Follow);
      await verifyIndexes(FollowRequest);
    } else {
      console.log('dry run only; rerun with --apply to write, then --verify during deployment');
    }
  }
  await mongoose.disconnect();
};

main().catch(async (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
