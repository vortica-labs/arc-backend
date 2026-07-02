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

const modelPath = (name) => path.resolve(
  __dirname,
  '..',
  'src',
  'legacy-src',
  'models',
  `${name}.js`
);
const User = require(modelPath('User'));
const TeamRecruitment = require(modelPath('TeamRecruitment'));
const PlayerProfile = require(modelPath('PlayerProfile'));
const RecruitmentApplication = require(modelPath('RecruitmentApplication'));
const {
  addTeamRecruitmentIntegrityFilters,
  addPlayerProfileIntegrityFilters,
  getValidRecruitmentOwnerMatch
} = require(path.resolve(
  __dirname,
  '..',
  'src',
  'legacy-src',
  'services',
  'recruitmentPolicy.js'
));

const apply = process.argv.includes('--apply');

const ownerLookup = (localField, expectedUserType, as) => ({
  $lookup: {
    from: User.collection.name,
    let: { ownerId: `$${localField}` },
    pipeline: [
      { $match: { $expr: { $eq: ['$_id', '$$ownerId'] } } },
      { $match: getValidRecruitmentOwnerMatch(expectedUserType) },
      { $project: { _id: 1 } }
    ],
    as
  }
});

const findInvalidRecruitments = async (Model, ownerField, expectedUserType, integrityQuery) => {
  const structuralCondition = integrityQuery.$and[0];
  return Model.aggregate([
    ownerLookup(ownerField, expectedUserType, '__validOwner'),
    {
      $match: {
        $or: [
          { '__validOwner.0': { $exists: false } },
          { $nor: [structuralCondition] }
        ]
      }
    },
    { $project: { _id: 1 } }
  ]);
};

const findInvalidApplications = () => RecruitmentApplication.aggregate([
  {
    $lookup: {
      from: TeamRecruitment.collection.name,
      let: { recruitmentId: '$recruitment' },
      pipeline: [
        { $match: { $expr: { $eq: ['$_id', '$$recruitmentId'] } } },
        { $match: { isActive: true } },
        { $match: addTeamRecruitmentIntegrityFilters({}) },
        ownerLookup('team', 'team', '__validTeam'),
        { $match: { '__validTeam.0': { $exists: true } } },
        { $project: { _id: 1 } }
      ],
      as: '__validRecruitment'
    }
  },
  ownerLookup('applicant', 'player', '__validApplicant'),
  {
    $match: {
      $or: [
        { '__validRecruitment.0': { $exists: false } },
        { '__validApplicant.0': { $exists: false } }
      ]
    }
  },
  { $project: { _id: 1 } }
]);

const findInvalidEmbeddedReferences = async (Model, arrayField, referenceField, expectedUserType) => (
  Model.aggregate([
    { $unwind: `$${arrayField}` },
    ownerLookup(`${arrayField}.${referenceField}`, expectedUserType, '__validReference'),
    { $match: { '__validReference.0': { $exists: false } } },
    {
      $group: {
        _id: `$${arrayField}.${referenceField}`,
        ownerRecords: { $addToSet: '$_id' }
      }
    },
    { $project: { _id: 1, affectedRecords: { $size: '$ownerRecords' } } }
  ])
);

const ids = (records) => records.map(record => record._id);
const printReport = (report) => {
  console.log(JSON.stringify({
    mode: apply ? 'apply' : 'audit-only',
    invalidTeamRecruitments: report.teamRecruitments.length,
    invalidPlayerProfiles: report.playerProfiles.length,
    invalidApplications: report.applications.length,
    invalidEmbeddedApplicants: report.embeddedApplicants.length,
    invalidEmbeddedInterestedTeams: report.embeddedInterestedTeams.length
  }, null, 2));
};

const cleanupEmbeddedReferences = async (Model, arrayField, referenceField, records) => {
  if (!records.length) return;
  await Model.bulkWrite(records.map(record => ({
    updateMany: {
      filter: { [`${arrayField}.${referenceField}`]: record._id },
      update: { $pull: { [arrayField]: { [referenceField]: record._id } } }
    }
  })), { ordered: false });
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

  const [teamRecruitments, playerProfiles, applications, embeddedApplicants, embeddedInterestedTeams] = await Promise.all([
    findInvalidRecruitments(
      TeamRecruitment,
      'team',
      'team',
      addTeamRecruitmentIntegrityFilters({})
    ),
    findInvalidRecruitments(
      PlayerProfile,
      'player',
      'player',
      addPlayerProfileIntegrityFilters({})
    ),
    findInvalidApplications(),
    findInvalidEmbeddedReferences(TeamRecruitment, 'applicants', 'user', 'player'),
    findInvalidEmbeddedReferences(PlayerProfile, 'interestedTeams', 'team', 'team')
  ]);
  const report = { teamRecruitments, playerProfiles, applications, embeddedApplicants, embeddedInterestedTeams };
  printReport(report);

  if (!apply) {
    console.log('No data changed. Re-run with --apply after reviewing the audit counts.');
    return;
  }

  await Promise.all([
    ids(teamRecruitments).length
      ? TeamRecruitment.updateMany(
        { _id: { $in: ids(teamRecruitments) } },
        { $set: { status: 'closed', isActive: false } }
      )
      : null,
    ids(playerProfiles).length
      ? PlayerProfile.updateMany(
        { _id: { $in: ids(playerProfiles) } },
        { $set: { status: 'inactive', isActive: false } }
      )
      : null,
    ids(applications).length
      ? RecruitmentApplication.updateMany(
        { _id: { $in: ids(applications) } },
        { $set: { status: 'withdrawn', isActive: false } }
      )
      : null,
    cleanupEmbeddedReferences(TeamRecruitment, 'applicants', 'user', embeddedApplicants),
    cleanupEmbeddedReferences(PlayerProfile, 'interestedTeams', 'team', embeddedInterestedTeams)
  ]);

  console.log('Recruitment integrity cleanup applied. Run the audit again to verify zero invalid active references.');
};

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
