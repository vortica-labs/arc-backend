const assert = require('assert');
const fs = require('fs');
const path = require('path');
const TeamRecruitment = require('../models/TeamRecruitment');
const { publicOptionalAuth } = require('../middleware/auth');
const { validateRecruitment, validateRecruitmentUpdate } = require('../middleware/validation');
const {
  serializeTeamRecruitment,
  serializePlayerProfile,
  isRecruitmentLive,
  isPlayerProfileLive,
  addTeamRecruitmentIntegrityFilters,
  addPlayerProfileIntegrityFilters,
  getValidRecruitmentOwnerMatch,
  isValidRecruitmentOwner,
  isTeamRecruitmentStructurallyValid,
  isPlayerProfileStructurallyValid,
  listCanonicalRecruitmentRecords,
  buildRecruitmentOwnerPrivacyStages,
  listCanonicalRecruitmentApplications,
  sameId,
  parsePagination,
  mergeAllowedObject
} = require('./recruitmentPolicy');

const future = new Date(Date.now() + 60_000);
const past = new Date(Date.now() - 60_000);

const recruitment = {
  _id: 'recruitment-1',
  status: 'active',
  isActive: true,
  expiresAt: future,
  applicants: [
    { user: 'player-1', message: 'private', resume: 'https://private.example/resume' },
    { user: 'player-2', portfolio: 'https://private.example/portfolio' }
  ]
};
const serializedRecruitment = serializeTeamRecruitment(recruitment);
assert.strictEqual(serializedRecruitment.applicantCount, 2);
assert.strictEqual(Object.prototype.hasOwnProperty.call(serializedRecruitment, 'applicants'), false);
assert.strictEqual(recruitment.applicants.length, 2, 'serialization must not mutate the source object');

const profile = {
  _id: 'profile-1',
  status: 'active',
  isActive: true,
  expiresAt: future,
  interestedTeams: [{ team: 'team-1', message: 'private' }]
};
const serializedProfile = serializePlayerProfile(profile);
assert.strictEqual(serializedProfile.interestedTeamsCount, 1);
assert.strictEqual(Object.prototype.hasOwnProperty.call(serializedProfile, 'interestedTeams'), false);
const ownerSerializedProfile = serializePlayerProfile(profile, { includeInterestedTeams: true });
assert.strictEqual(ownerSerializedProfile.interestedTeams.length, 1);

assert.strictEqual(isRecruitmentLive(recruitment), true);
assert.strictEqual(isRecruitmentLive({ ...recruitment, status: 'closed' }), false);
assert.strictEqual(isRecruitmentLive({ ...recruitment, status: 'paused' }), false);
assert.strictEqual(isRecruitmentLive({ ...recruitment, status: 'filled' }), false);
assert.strictEqual(isRecruitmentLive({ ...recruitment, isActive: false }), false);
assert.strictEqual(isRecruitmentLive({ ...recruitment, expiresAt: past }), false);
assert.strictEqual(isPlayerProfileLive(profile), true);
assert.strictEqual(isPlayerProfileLive({ ...profile, status: 'inactive' }), false);
assert.strictEqual(isPlayerProfileLive({ ...profile, expiresAt: past }), false);

assert.deepStrictEqual(getValidRecruitmentOwnerMatch('player'), {
  userType: 'player',
  isActive: true,
  needsProfileCompletion: { $ne: true },
  username: { $type: 'string' },
  $expr: {
    $gt: [
      {
        $strLenCP: {
          $trim: {
            input: { $convert: { input: '$username', to: 'string', onError: '', onNull: '' } }
          }
        }
      },
      0
    ]
  }
});
assert.strictEqual(isValidRecruitmentOwner({
  _id: 'player-1', username: 'active_player', userType: 'player', isActive: true
}, 'player'), true);
assert.strictEqual(isValidRecruitmentOwner({
  _id: 'player-1', username: 'inactive_player', userType: 'player', isActive: false
}, 'player'), false);

const guestPrivacyStages = buildRecruitmentOwnerPrivacyStages();
assert.strictEqual(guestPrivacyStages.length, 1);
assert.strictEqual(guestPrivacyStages[0].$match.$expr.$eq[1], 'public');
const authenticatedPrivacyStages = buildRecruitmentOwnerPrivacyStages({
  viewerId: '507f1f77bcf86cd799439011',
  viewerBlockedIds: ['507f1f77bcf86cd799439012']
});
assert(authenticatedPrivacyStages.some((stage) => stage.$lookup?.from === 'follows'));
assert(authenticatedPrivacyStages.some((stage) => stage.$match?.$expr));
assert.strictEqual(isValidRecruitmentOwner({
  _id: 'player-1', username: 'wrong_role', userType: 'team', isActive: true
}, 'player'), false);
assert.strictEqual(isValidRecruitmentOwner({
  _id: 'player-1', username: '   ', userType: 'player', isActive: true
}, 'player'), false);

assert.strictEqual(isTeamRecruitmentStructurallyValid({
  recruitmentType: 'roster', game: 'BGMI', role: 'IGL'
}), true);
assert.strictEqual(isTeamRecruitmentStructurallyValid({
  recruitmentType: 'roster', game: 'BGMI', role: '   '
}), false);
assert.strictEqual(isPlayerProfileStructurallyValid({
  profileType: 'staff-position', staffRole: 'Coach'
}), true);

const teamIntegrityQuery = addTeamRecruitmentIntegrityFilters({ status: 'active' });
assert.strictEqual(teamIntegrityQuery.status, 'active');
assert.strictEqual(teamIntegrityQuery.$and[0].$or[0].recruitmentType, 'roster');
assert.strictEqual(teamIntegrityQuery.$and[0].$or[1].recruitmentType, 'staff');
const profileIntegrityQuery = addPlayerProfileIntegrityFilters({ status: 'active' });
assert.strictEqual(profileIntegrityQuery.$and[0].$or[0].profileType, 'looking-for-team');
assert.strictEqual(profileIntegrityQuery.$and[0].$or[1].profileType, 'staff-position');

assert.strictEqual(sameId({ _id: 'abc' }, 'abc'), true);
assert.strictEqual(sameId('abc', 'def'), false);
assert.deepStrictEqual(parsePagination('-5', '10000'), { page: 1, limit: 100 });
assert.deepStrictEqual(parsePagination('3', '20'), { page: 3, limit: 20 });
assert.deepStrictEqual(
  parsePagination(undefined, undefined, { defaultLimit: 100, maxLimit: 100 }),
  { page: 1, limit: 100 }
);

assert.deepStrictEqual(
  mergeAllowedObject(
    { allowed: 'old', retained: 'yes', _id: 'nested-id' },
    { allowed: 'new', protected: 'blocked' },
    ['allowed', 'retained']
  ),
  { allowed: 'new', retained: 'yes' }
);

const legacyRoot = path.resolve(__dirname, '..');
const controllerSource = fs.readFileSync(path.join(legacyRoot, 'controllers/recruitmentController.js'), 'utf8');
const authControllerSource = fs.readFileSync(path.join(legacyRoot, 'controllers/authController.js'), 'utf8');
const adminControllerSource = fs.readFileSync(path.join(legacyRoot, 'controllers/adminController.js'), 'utf8');
const modularUserRoutesSource = fs.readFileSync(path.resolve(legacyRoot, '../modules/users/users.routes.ts'), 'utf8');
const legacyUserRoutesSource = fs.readFileSync(path.join(legacyRoot, 'routes/users.js'), 'utf8');
const modularRecruitmentRoutesSource = fs.readFileSync(
  path.resolve(legacyRoot, '../modules/recruitment/recruitment.routes.ts'),
  'utf8'
);
const legacyRecruitmentRoutesSource = fs.readFileSync(path.join(legacyRoot, 'routes/recruitment.js'), 'utf8');

assert(controllerSource.includes("requireUserType(req, res, 'player', 'Only individual users can apply"));
assert(controllerSource.includes("message: 'This recruitment is no longer accepting applications'"));
assert(controllerSource.includes('serializeTeamRecruitment(recruitment)'));
assert(controllerSource.includes('serializePlayerProfile(profile)'));
assert(controllerSource.includes('closeTeamRecruitment'));
assert(controllerSource.includes('reopenTeamRecruitment'));
assert(controllerSource.includes('status: previousStatus'));
assert(controllerSource.includes('syncEmbeddedApplicantStatus'));
assert(controllerSource.includes('queueRecruitmentNotification'));
assert(controllerSource.includes('includeInterestedTeams: isOwner'));
assert(controllerSource.includes('listCanonicalRecruitmentRecords({'));
assert(controllerSource.includes('listCanonicalRecruitmentApplications({'));
assert(controllerSource.includes('RecruitmentApplication.deleteMany({ recruitment: recruitment._id })'));
assert(controllerSource.includes("match: getValidRecruitmentOwnerMatch('team')"));
assert(controllerSource.includes("match: getValidRecruitmentOwnerMatch('player')"));
assert(authControllerSource.includes("{ $set: { status: 'closed', isActive: false } }"));
assert(authControllerSource.includes("{ $set: { status: 'inactive', isActive: false } }"));
assert(adminControllerSource.includes('TeamRecruitment.deleteMany({ team: userId })'));
assert(adminControllerSource.includes('PlayerProfile.deleteMany({ player: userId })'));
assert(adminControllerSource.includes('RecruitmentApplication.deleteMany({'));
assert(!modularUserRoutesSource.includes('/:playerId/add-team/:teamId'));
assert(!legacyUserRoutesSource.includes('/:playerId/add-team/:teamId'));
assert(modularRecruitmentRoutesSource.includes('publicOptionalAuth, recruitmentController.getTeamRecruitment'));
assert(modularRecruitmentRoutesSource.includes('publicOptionalAuth, recruitmentController.getPlayerProfile'));
assert(legacyRecruitmentRoutesSource.includes('publicOptionalAuth, getTeamRecruitment'));
assert(legacyRecruitmentRoutesSource.includes('publicOptionalAuth, getPlayerProfile'));

const staffWithoutGame = new TeamRecruitment({
  team: '507f1f77bcf86cd799439011',
  recruitmentType: 'staff',
  staffRole: 'Coach'
});
assert.strictEqual(staffWithoutGame.validateSync()?.errors?.game, undefined);

const rosterWithoutGame = new TeamRecruitment({
  team: '507f1f77bcf86cd799439011',
  recruitmentType: 'roster',
  role: 'Entry Fragger'
});
assert(rosterWithoutGame.validateSync()?.errors?.game, 'roster recruitment must require a game');

const runValidation = async (middlewares, body) => {
  const req = { body };
  let statusCode = 200;
  let response = null;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      response = { statusCode, payload };
      return this;
    }
  };

  for (const middleware of middlewares) {
    let nextCalled = false;
    await middleware(req, res, () => {
      nextCalled = true;
    });
    if (response) break;
    assert(nextCalled, 'validation middleware must either call next or send a response');
  }
  return response;
};

(async () => {
  let capturedPipeline = null;
  const fakeModel = {
    aggregate(pipeline) {
      capturedPipeline = pipeline;
      return { allowDiskUse: async () => [{ records: [{ _id: 'valid-1' }], metadata: [{ total: 1 }] }] };
    }
  };
  const canonical = await listCanonicalRecruitmentRecords({
    model: fakeModel,
    userModel: { collection: { name: 'users' } },
    query: { status: 'active' },
    ownerField: 'player',
    expectedUserType: 'player',
    countField: 'interestedTeamsCount',
    sortBy: 'createdAt',
    sortDirection: -1,
    page: 1,
    limit: 10
  });
  assert.deepStrictEqual(canonical, { records: [{ _id: 'valid-1' }], total: 1 });
  const lookup = capturedPipeline.find(stage => stage.$lookup)?.$lookup;
  assert.strictEqual(lookup.from, 'users');
  assert.strictEqual(lookup.let.ownerId, '$player');
  assert.deepStrictEqual(lookup.pipeline[1].$match, getValidRecruitmentOwnerMatch('player'));
  assert(capturedPipeline.some(stage => stage.$unwind === '$__validOwner'));
  assert(capturedPipeline.some(stage => stage.$facet), 'canonical validity must run before pagination and count');

  let capturedApplicationPipeline = null;
  const canonicalApplications = await listCanonicalRecruitmentApplications({
    applicationModel: {
      aggregate(pipeline) {
        capturedApplicationPipeline = pipeline;
        return { allowDiskUse: async () => [{ records: [{ _id: 'application-1' }], metadata: [{ total: 1 }] }] };
      }
    },
    recruitmentModel: { collection: { name: 'teamrecruitments' } },
    userModel: { collection: { name: 'users' } },
    query: { isActive: true },
    page: 1,
    limit: 10
  });
  assert.deepStrictEqual(canonicalApplications, {
    records: [{ _id: 'application-1' }],
    total: 1
  });
  const applicationLookups = capturedApplicationPipeline.filter(stage => stage.$lookup);
  assert.strictEqual(applicationLookups[0].$lookup.from, 'teamrecruitments');
  assert.strictEqual(applicationLookups[1].$lookup.from, 'users');
  assert(capturedApplicationPipeline.filter(stage => stage.$unwind).length >= 2);
  assert(capturedApplicationPipeline.some(stage => stage.$facet), 'application validity must precede pagination');

  const validStaffResponse = await runValidation(validateRecruitment, {
    recruitmentType: 'staff',
    game: '',
    staffRole: 'Coach',
    requirements: { availability: 'Evenings' },
    benefits: { contactInformation: 'team@example.com' }
  });
  assert.strictEqual(validStaffResponse, null, 'staff recruitment must accept an empty game');

  const validStaffUpdateResponse = await runValidation(validateRecruitmentUpdate, {
    recruitmentType: 'staff',
    game: '',
    staffRole: 'Coach',
    requirements: { availability: 'Weekends' }
  });
  assert.strictEqual(validStaffUpdateResponse, null, 'staff edits must accept the Web empty-game payload');

  const invalidStaffGameResponse = await runValidation(validateRecruitment, {
    recruitmentType: 'staff',
    game: 'Unsupported Game',
    staffRole: 'Coach',
    requirements: { availability: 'Evenings' },
    benefits: { contactInformation: 'team@example.com' }
  });
  assert.strictEqual(invalidStaffGameResponse?.statusCode, 400);

  const missingRosterGameResponse = await runValidation(validateRecruitment, {
    recruitmentType: 'roster',
    game: '',
    role: 'Entry Fragger',
    requirements: { experienceLevel: 'Competitive' },
    benefits: { contactInformation: 'team@example.com' }
  });
  assert.strictEqual(missingRosterGameResponse?.statusCode, 400);

  let anonymousNextCalled = false;
  await publicOptionalAuth({ headers: {} }, {}, () => {
    anonymousNextCalled = true;
  });
  assert.strictEqual(anonymousNextCalled, true, 'public recruitment reads must allow anonymous requests');

  console.log('Recruitment policy and route contracts passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
