const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  addPlayerProfileIntegrityFilters,
  listCanonicalRecruitmentRecords
} = require('../services/recruitmentPolicy');

const source = fs.readFileSync(
  path.join(__dirname, 'aiRecruitmentController.js'),
  'utf8'
);

const sourceSection = (start, end) => {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert(startIndex >= 0, `missing source section: ${start}`);
  assert(endIndex > startIndex, `missing end marker for source section: ${start}`);
  return source.slice(startIndex, endIndex);
};

const matchSection = sourceSection(
  'const matchPlayersToTeam',
  'const analyzeApplication'
);
const interviewSection = sourceSection(
  'const generateInterviewQuestions',
  'const rankCandidates'
);
const searchSection = sourceSection(
  'const smartSearch',
  'module.exports'
);

for (const [name, section] of [
  ['matchPlayersToTeam', matchSection],
  ['generateInterviewQuestions', interviewSection],
  ['smartSearch', searchSection]
]) {
  assert(
    section.includes('findPrivacySafeCandidateProfiles'),
    `${name} must use the canonical privacy-safe candidate reader`
  );
}

assert(!matchSection.includes(".populate('player'"));
assert(!interviewSection.includes(".populate('player'"));
assert(!searchSection.includes(".populate('player'"));
assert(interviewSection.includes('mongoose.Types.ObjectId.isValid'));
assert(source.includes('viewerBlockedIds: viewer?.blockedUsers || []'));
assert(source.includes('ownerProjection: AI_CANDIDATE_OWNER_PROJECTION'));
assert(!source.match(/AI_CANDIDATE_OWNER_PROJECTION[\s\S]*?privacySettings:\s*1/));
assert(!source.match(/AI_CANDIDATE_OWNER_PROJECTION[\s\S]*?blockedUsers:\s*1/));

(async () => {
  const capturedPipelines = [];
  const records = [{ _id: 'profile-visible' }];
  const customOwnerProjection = {
    _id: 1,
    username: 1,
    'profile.displayName': 1,
    'playerInfo.gamingStats': 1
  };
  // $facet is unsupported on Amazon DocumentDB: the page and the count run as
  // two aggregations. The stub returns count rows only for the $count pipeline.
  const model = {
    aggregate(pipeline) {
      capturedPipelines.push(pipeline);
      const isCount = pipeline.some((stage) => stage.$count);
      return {
        allowDiskUse: async () => (isCount ? [{ total: 1 }] : records)
      };
    }
  };

  const query = addPlayerProfileIntegrityFilters({
    profileType: 'looking-for-team',
    game: 'BGMI',
    status: 'active',
    isActive: true
  });
  const result = await listCanonicalRecruitmentRecords({
    model,
    userModel: { collection: { name: 'users' } },
    query,
    ownerField: 'player',
    expectedUserType: 'player',
    countField: 'interestedTeamsCount',
    sortBy: 'createdAt',
    sortDirection: -1,
    page: 1,
    limit: 100,
    viewerId: '507f1f77bcf86cd799439011',
    viewerBlockedIds: ['507f1f77bcf86cd799439012'],
    ownerProjection: customOwnerProjection
  });

  assert.deepStrictEqual(result, { records, total: 1 });
  assert(!capturedPipelines.some((p) => p.some((stage) => stage.$facet)), 'candidate query must not use $facet');
  const capturedPipeline = capturedPipelines.find((p) => !p.some((stage) => stage.$count));
  const countPipeline = capturedPipelines.find((p) => p.some((stage) => stage.$count));
  assert(capturedPipeline && countPipeline, 'privacy filtering must precede pagination and count');

  // The owner validity lookup must not nest the relationship lookup inside its
  // sub-pipeline: Amazon DocumentDB rejects a correlated $lookup nested inside
  // another correlated $lookup ("$lookup on multiple join conditions").
  const ownerLookupStage = capturedPipeline.find(
    (stage) => stage.$lookup?.as === '__validOwner'
  );
  assert(ownerLookupStage, 'candidate owner lookup must exist');
  assert(
    !ownerLookupStage.$lookup.pipeline.some((stage) => stage.$lookup),
    'owner lookup must not embed a nested $lookup (DocumentDB rejects it)'
  );
  // The owner projection carries privacySettings/blockedUsers only so the
  // top-level privacy checks can read them; they must be stripped afterwards.
  const ownerProjectionStage = ownerLookupStage.$lookup.pipeline.find(
    (stage) => stage.$project?.['playerInfo.gamingStats'] === 1
  );
  assert(ownerProjectionStage, 'candidate owner fields must be projected');
  assert.strictEqual(ownerProjectionStage.$project.privacySettings, 1);
  assert.strictEqual(ownerProjectionStage.$project.blockedUsers, 1);

  // Follow lookup, block/visibility match, and the privacy-field strip all run at
  // the top level of the pipeline.
  const privacyFollowIndex = capturedPipeline.findIndex(
    (stage) => stage.$lookup?.from === 'follows'
  );
  const privacyMatchIndex = capturedPipeline.findIndex(
    (stage, index) => index > privacyFollowIndex && stage.$match?.$expr?.$and
  );
  const stripIndex = capturedPipeline.findIndex(
    (stage) => stage.$project?.['__validOwner.privacySettings'] === 0
  );

  assert(privacyFollowIndex >= 0, 'approved-follower lookup must be applied');
  assert(privacyMatchIndex > privacyFollowIndex, 'block and visibility checks must follow relationship lookup');
  assert(stripIndex > privacyMatchIndex, 'privacy fields must be stripped only after the privacy checks');
  assert.strictEqual(
    capturedPipeline[stripIndex].$project['__validOwner.blockedUsers'], 0,
    'blockedUsers must not leak to a narrow candidate projection'
  );
  assert(
    capturedPipeline.findIndex((stage) => stage.$limit) > privacyMatchIndex,
    'privacy filtering must happen before the candidate limit'
  );
  assert(countPipeline.some((stage) => stage.$count), 'total count must be a dedicated $count aggregation');

  console.log('AI recruitment privacy contracts passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
