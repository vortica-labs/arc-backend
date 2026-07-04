const mongoose = require('mongoose');

const TEAM_RECRUITMENT_STATUSES = Object.freeze(['active', 'paused', 'closed', 'filled']);
const PLAYER_PROFILE_STATUSES = Object.freeze(['active', 'paused', 'inactive']);
const TEAM_APPLICATION_STATUSES = Object.freeze(['reviewed', 'shortlisted', 'rejected', 'accepted']);
const RECRUITMENT_GAMES = Object.freeze([
  'BGMI', 'Valorant', 'Free Fire', 'Call of Duty Mobile', 'CS:GO', 'Fortnite',
  'Apex Legends', 'League of Legends', 'Dota 2'
]);

const toPlainObject = (value) => {
  if (!value) return {};
  if (typeof value.toObject === 'function') {
    return value.toObject({ virtuals: true });
  }
  return { ...value };
};

const serializeTeamRecruitment = (value) => {
  const recruitment = toPlainObject(value);
  if (recruitment.team && typeof recruitment.team === 'object') {
    delete recruitment.team.privacySettings;
    delete recruitment.team.blockedUsers;
    delete recruitment.team.lastSeen;
  }
  const applicants = Array.isArray(recruitment.applicants) ? recruitment.applicants : [];
  const explicitCount = Number(recruitment.applicantCount);
  recruitment.applicantCount = Number.isFinite(explicitCount) ? explicitCount : applicants.length;
  delete recruitment.applicants;
  return recruitment;
};

const serializePlayerProfile = (value, { includeInterestedTeams = false } = {}) => {
  const profile = toPlainObject(value);
  if (profile.player && typeof profile.player === 'object') {
    delete profile.player.privacySettings;
    delete profile.player.blockedUsers;
    delete profile.player.lastSeen;
  }
  const interestedTeams = Array.isArray(profile.interestedTeams) ? profile.interestedTeams : [];
  const explicitCount = Number(profile.interestedTeamsCount);
  profile.interestedTeamsCount = Number.isFinite(explicitCount) ? explicitCount : interestedTeams.length;
  if (!includeInterestedTeams) delete profile.interestedTeams;
  return profile;
};

const isUnexpired = (expiresAt, now = new Date()) => {
  if (!expiresAt) return true;
  const expiresAtMs = new Date(expiresAt).getTime();
  return Number.isFinite(expiresAtMs) && expiresAtMs > now.getTime();
};

const isRecruitmentLive = (recruitment, now = new Date()) => Boolean(
  recruitment
  && recruitment.status === 'active'
  && recruitment.isActive !== false
  && isUnexpired(recruitment.expiresAt, now)
);

const isPlayerProfileLive = (profile, now = new Date()) => Boolean(
  profile
  && profile.status === 'active'
  && profile.isActive !== false
  && isUnexpired(profile.expiresAt, now)
);

const addAndCondition = (query, condition) => {
  query.$and = Array.isArray(query.$and) ? query.$and : [];
  query.$and.push(condition);
  return query;
};

const hasNonBlankStringExpression = (field) => ({
  $gt: [
    {
      $strLenCP: {
        $trim: {
          input: { $convert: { input: `$${field}`, to: 'string', onError: '', onNull: '' } }
        }
      }
    },
    0
  ]
});

// Structural-integrity $or for team recruitments, parameterized by an optional
// field prefix so it can also run against an unwound owner path (e.g.
// `__validRecruitment`) at the TOP level of an aggregation. Keeping this out of
// a $lookup sub-pipeline matters: Amazon DocumentDB rejects a pipeline $lookup
// that carries more than one $expr ("$lookup on multiple join conditions").
const teamRecruitmentIntegrityOr = (prefix = '') => {
  const p = prefix ? `${prefix}.` : '';
  return {
    $or: [
      {
        [`${p}recruitmentType`]: 'roster',
        [`${p}game`]: { $in: RECRUITMENT_GAMES },
        [`${p}role`]: { $type: 'string' },
        $expr: hasNonBlankStringExpression(`${p}role`)
      },
      {
        [`${p}recruitmentType`]: 'staff',
        [`${p}staffRole`]: { $type: 'string' },
        $expr: hasNonBlankStringExpression(`${p}staffRole`)
      }
    ]
  };
};

const addTeamRecruitmentIntegrityFilters = (query = {}) => addAndCondition(query, teamRecruitmentIntegrityOr());

const addPlayerProfileIntegrityFilters = (query = {}) => addAndCondition(query, {
  $or: [
    {
      profileType: 'looking-for-team',
      game: { $in: RECRUITMENT_GAMES },
      role: { $type: 'string' },
      $expr: hasNonBlankStringExpression('role')
    },
    {
      profileType: 'staff-position',
      staffRole: { $type: 'string' },
      $expr: hasNonBlankStringExpression('staffRole')
    }
  ]
});

const getValidRecruitmentOwnerMatch = (expectedUserType) => ({
  userType: expectedUserType,
  isActive: true,
  needsProfileCompletion: { $ne: true },
  username: { $type: 'string' },
  $expr: hasNonBlankStringExpression('username')
});

// Top-level owner-validity $match for an unwound owner path. Used AFTER a
// $unwind rather than inside the $lookup sub-pipeline so the join stays a single
// DocumentDB-compatible condition (see teamRecruitmentIntegrityOr). The validity
// fields it inspects must be projected out of the owner $lookup.
const buildValidOwnerMatchStage = (ownerPath, expectedUserType) => {
  const p = ownerPath ? `${ownerPath}.` : '';
  return {
    $match: {
      [`${p}userType`]: expectedUserType,
      [`${p}isActive`]: true,
      [`${p}needsProfileCompletion`]: { $ne: true },
      [`${p}username`]: { $type: 'string' },
      $expr: hasNonBlankStringExpression(`${p}username`)
    }
  };
};

const isTeamRecruitmentStructurallyValid = (recruitment) => {
  if (!recruitment) return false;
  if (recruitment.recruitmentType === 'roster') {
    return RECRUITMENT_GAMES.includes(recruitment.game)
      && typeof recruitment.role === 'string'
      && Boolean(recruitment.role.trim());
  }
  return recruitment.recruitmentType === 'staff'
    && typeof recruitment.staffRole === 'string'
    && Boolean(recruitment.staffRole.trim());
};

const isPlayerProfileStructurallyValid = (profile) => {
  if (!profile) return false;
  if (profile.profileType === 'looking-for-team') {
    return RECRUITMENT_GAMES.includes(profile.game)
      && typeof profile.role === 'string'
      && Boolean(profile.role.trim());
  }
  return profile.profileType === 'staff-position'
    && typeof profile.staffRole === 'string'
    && Boolean(profile.staffRole.trim());
};

const isValidRecruitmentOwner = (owner, expectedUserType) => Boolean(
  owner
  && owner._id
  && owner.userType === expectedUserType
  && owner.isActive === true
  && owner.needsProfileCompletion !== true
  && typeof owner.username === 'string'
  && owner.username.trim()
);

// Builds the effective-visibility expression against an optional owner base path.
// When the owner document has been unwound into a nested field (e.g. `__validOwner`)
// the privacy check runs at the top level of the pipeline, so it must reference
// `$__validOwner.privacySettings.*` instead of `$privacySettings.*`.
const buildEffectiveVisibilityExpression = (base = '') => {
  const prefix = base ? `${base}.` : '';
  const field = (name) => `$${prefix}${name}`;
  return {
    $switch: {
      branches: [
        {
          case: { $in: [field('privacySettings.profileVisibility'), ['public', 'followers', 'private']] },
          then: field('privacySettings.profileVisibility')
        },
        {
          case: {
            $and: [
              { $eq: [{ $type: field('privacySettings.profileVisibility') }, 'missing'] },
              {
                $or: [
                  { $eq: [field('privacySettings.accountType'), 'public'] },
                  { $eq: [{ $type: field('privacySettings.accountType') }, 'missing'] }
                ]
              }
            ]
          },
          then: 'public'
        }
      ],
      default: 'private'
    }
  };
};

const effectiveProfileVisibilityExpression = buildEffectiveVisibilityExpression();

const DEFAULT_RECRUITMENT_OWNER_PROJECTION = Object.freeze({
  _id: 1,
  username: 1,
  userType: 1,
  isActive: 1,
  'profile.displayName': 1,
  'profile.avatar': 1,
  privacySettings: 1,
  blockedUsers: 1
});

// Emits the owner privacy/blocklist stages. These run at the TOP level of the
// aggregation (after the owner has been unwound into `ownerPath`) rather than
// inside the owner $lookup sub-pipeline. Amazon DocumentDB rejects a correlated
// $lookup nested inside another correlated $lookup ("$lookup on multiple join
// conditions"), so the follows join must not be embedded in the owner lookup.
const buildRecruitmentOwnerPrivacyStages = ({
  viewerId,
  viewerBlockedIds = [],
  followCollectionName = 'follows',
  ownerPath = ''
} = {}) => {
  const prefix = ownerPath ? `${ownerPath}.` : '';
  const ownerField = (name) => `$${prefix}${name}`;
  const visibilityExpr = buildEffectiveVisibilityExpression(ownerPath);
  const hasViewer = viewerId && mongoose.Types.ObjectId.isValid(String(viewerId));
  if (!hasViewer) {
    return [{ $match: { $expr: { $eq: [visibilityExpr, 'public'] } } }];
  }
  const viewerObjectId = new mongoose.Types.ObjectId(String(viewerId));
  const blockedObjectIds = (viewerBlockedIds || [])
    .filter((id) => mongoose.Types.ObjectId.isValid(String(id)))
    .map((id) => new mongoose.Types.ObjectId(String(id)));
  return [
    {
      $lookup: {
        from: followCollectionName,
        let: { ownerId: ownerField('_id') },
        pipeline: [
          // Amazon DocumentDB rejects a correlated $lookup with more than one
          // join condition. `follower` is a constant (the viewer), so it stays a
          // plain match, leaving a single correlated join on `following`.
          { $match: { follower: viewerObjectId } },
          { $match: { $expr: { $eq: ['$following', '$$ownerId'] } } },
          { $limit: 1 }
        ],
        as: '__viewerFollow'
      }
    },
    {
      $match: {
        $expr: {
          $and: [
            { $not: [{ $in: [ownerField('_id'), blockedObjectIds] }] },
            { $not: [{ $in: [viewerObjectId, { $ifNull: [ownerField('blockedUsers'), []] }] }] },
            {
              $or: [
                { $eq: [ownerField('_id'), viewerObjectId] },
                { $eq: [visibilityExpr, 'public'] },
                { $gt: [{ $size: '$__viewerFollow' }, 0] }
              ]
            }
          ]
        }
      }
    },
    { $project: { __viewerFollow: 0 } }
  ];
};

/**
 * Canonical list query for TeamRecruitment and PlayerProfile. Owner validity
 * is applied before sorting, pagination, and counting so a failed population
 * can never become an orphan card or an incorrect pagination total.
 */
const listCanonicalRecruitmentRecords = async ({
  model,
  userModel,
  query,
  ownerField,
  expectedUserType,
  countField,
  sortBy,
  sortDirection,
  page,
  limit,
  viewerId,
  viewerBlockedIds,
  followCollectionName,
  ownerProjection = DEFAULT_RECRUITMENT_OWNER_PROJECTION
}) => {
  const countSource = countField === 'applicantCount' ? 'applicants' : 'interestedTeams';
  const sort = sortBy === 'createdAt'
    ? { createdAt: sortDirection, _id: 1 }
    : { [sortBy]: sortDirection, createdAt: -1, _id: 1 };

  // Owner validity and privacy/blocklist filtering both run at the TOP level of
  // the pipeline (after $unwind), not inside the owner $lookup. Amazon DocumentDB
  // rejects a pipeline $lookup that carries more than one $expr condition
  // ("$lookup on multiple join conditions"), so the sub-pipeline keeps only the
  // single correlated join and the validity/privacy checks (which add their own
  // $expr predicates) are applied afterwards. That in turn means the owner
  // $lookup must project the fields those top-level checks inspect
  // (userType/isActive/needsProfileCompletion/username/privacySettings/
  // blockedUsers) even when the caller asked for a narrower set (e.g. the AI
  // candidate reader). They are stripped again unless the caller requested them.
  const ownerKeeps = (field) => Object.prototype.hasOwnProperty.call(ownerProjection, field);
  const ownerLookupProjection = {
    ...ownerProjection,
    userType: 1,
    isActive: 1,
    needsProfileCompletion: 1,
    username: 1,
    privacySettings: 1,
    blockedUsers: 1
  };
  const fieldsToStrip = {};
  for (const field of ['userType', 'isActive', 'needsProfileCompletion', 'username', 'privacySettings', 'blockedUsers']) {
    if (!ownerKeeps(field)) fieldsToStrip[`__validOwner.${field}`] = 0;
  }

  const basePipeline = [
    { $match: query },
    {
      $lookup: {
        from: userModel.collection.name,
        let: { ownerId: `$${ownerField}` },
        pipeline: [
          { $match: { $expr: { $eq: ['$_id', '$$ownerId'] } } },
          { $project: ownerLookupProjection }
        ],
        as: '__validOwner'
      }
    },
    { $unwind: '$__validOwner' },
    // Owner validity runs at the top level (not inside the $lookup above) so the
    // sub-pipeline keeps a single DocumentDB-compatible join condition.
    buildValidOwnerMatchStage('__validOwner', expectedUserType),
    // Privacy/blocklist filtering also runs at the top level because Amazon
    // DocumentDB rejects a correlated $lookup nested within another correlated
    // $lookup.
    ...buildRecruitmentOwnerPrivacyStages({
      viewerId,
      viewerBlockedIds,
      followCollectionName,
      ownerPath: '__validOwner'
    }),
    // Drop the fields that were only needed for the validity/privacy checks above
    // so a narrower caller projection (e.g. AI candidate reads) never leaks them.
    ...(Object.keys(fieldsToStrip).length ? [{ $project: fieldsToStrip }] : []),
    { $set: { [ownerField]: '$__validOwner' } },
    { $project: { __validOwner: 0 } },
    { $addFields: { [countField]: { $size: { $ifNull: [`$${countSource}`, []] } } } }
  ];

  // Amazon DocumentDB does not support $facet, so the page and the total count
  // are fetched with two aggregations that share the base pipeline above.
  const [records, countRows] = await Promise.all([
    model.aggregate([
      ...basePipeline,
      { $sort: sort },
      { $skip: (page - 1) * limit },
      { $limit: limit }
    ]).allowDiskUse(true),
    model.aggregate([...basePipeline, { $count: 'total' }]).allowDiskUse(true)
  ]);

  return {
    records: Array.isArray(records) ? records : [],
    total: Number(countRows?.[0]?.total || 0)
  };
};

/**
 * Canonical application query shared by player and team application screens.
 * Referenced recruitment, team, and applicant records are validated before
 * pagination/counting so an orphan cannot become a card or inflate totals.
 */
const listCanonicalRecruitmentApplications = async ({
  applicationModel,
  recruitmentModel,
  userModel,
  query,
  page,
  limit
}) => {
  // Every $lookup sub-pipeline below carries only a single correlated join
  // ($expr $eq). The recruitment structural-integrity check and the team/
  // applicant owner-validity checks add their own $expr predicates, so they run
  // at the TOP level after each $unwind. Amazon DocumentDB rejects a pipeline
  // $lookup that carries more than one $expr ("$lookup on multiple join
  // conditions"), which is why none of that validation lives inside the lookups.
  const basePipeline = [
    { $match: query },
    // Resolve the referenced recruitment. Structural integrity is enforced at the
    // top level (below) rather than inside this $lookup.
    {
      $lookup: {
        from: recruitmentModel.collection.name,
        let: { recruitmentId: '$recruitment' },
        pipeline: [
          { $match: { $expr: { $eq: ['$_id', '$$recruitmentId'] } } },
          { $match: { isActive: true } },
          {
            $project: {
              _id: 1,
              game: 1,
              role: 1,
              staffRole: 1,
              recruitmentType: 1,
              status: 1,
              isActive: 1,
              expiresAt: 1,
              recruitmentCode: 1,
              team: 1
            }
          }
        ],
        as: '__validRecruitment'
      }
    },
    { $unwind: '$__validRecruitment' },
    { $match: teamRecruitmentIntegrityOr('__validRecruitment') },
    {
      $lookup: {
        from: userModel.collection.name,
        let: { teamId: '$__validRecruitment.team' },
        pipeline: [
          { $match: { $expr: { $eq: ['$_id', '$$teamId'] } } },
          {
            $project: {
              _id: 1,
              username: 1,
              userType: 1,
              isActive: 1,
              needsProfileCompletion: 1,
              'profile.displayName': 1,
              'profile.avatar': 1
            }
          }
        ],
        as: '__validTeam'
      }
    },
    { $unwind: '$__validTeam' },
    buildValidOwnerMatchStage('__validTeam', 'team'),
    // Merge only the presentable team fields so the validity-only fields
    // (userType/isActive/needsProfileCompletion) never leak into the response.
    {
      $set: {
        __validRecruitment: {
          $mergeObjects: ['$__validRecruitment', {
            team: {
              _id: '$__validTeam._id',
              username: '$__validTeam.username',
              profile: '$__validTeam.profile'
            }
          }]
        }
      }
    },
    {
      $lookup: {
        from: userModel.collection.name,
        let: { applicantId: '$applicant' },
        pipeline: [
          { $match: { $expr: { $eq: ['$_id', '$$applicantId'] } } },
          {
            $project: {
              _id: 1,
              username: 1,
              userType: 1,
              isActive: 1,
              needsProfileCompletion: 1,
              'profile.displayName': 1,
              'profile.avatar': 1
            }
          }
        ],
        as: '__validApplicant'
      }
    },
    { $unwind: '$__validApplicant' },
    buildValidOwnerMatchStage('__validApplicant', 'player'),
    {
      $set: {
        recruitment: '$__validRecruitment',
        applicant: {
          _id: '$__validApplicant._id',
          username: '$__validApplicant.username',
          profile: '$__validApplicant.profile'
        },
        appliedAt: '$createdAt'
      }
    },
    { $project: { __validRecruitment: 0, __validApplicant: 0, __validTeam: 0 } }
  ];

  // Amazon DocumentDB does not support $facet, so the page and the total count
  // are fetched with two aggregations that share the base pipeline above.
  const [records, countRows] = await Promise.all([
    applicationModel.aggregate([
      ...basePipeline,
      { $sort: { createdAt: -1, _id: 1 } },
      { $skip: (page - 1) * limit },
      { $limit: limit }
    ]).allowDiskUse(true),
    applicationModel.aggregate([...basePipeline, { $count: 'total' }]).allowDiskUse(true)
  ]);

  return {
    records: Array.isArray(records) ? records : [],
    total: Number(countRows?.[0]?.total || 0)
  };
};

const sameId = (left, right) => {
  if (left === undefined || left === null || right === undefined || right === null) return false;
  const leftValue = left && left._id ? left._id : left;
  const rightValue = right && right._id ? right._id : right;
  return String(leftValue) === String(rightValue);
};

const parsePositiveInteger = (value, fallback, maximum) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return maximum ? Math.min(parsed, maximum) : parsed;
};

const parsePagination = (page, limit, { defaultLimit = 10, maxLimit = 100 } = {}) => ({
  page: parsePositiveInteger(page, 1),
  limit: parsePositiveInteger(limit, defaultLimit, maxLimit)
});

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const mergeAllowedObject = (currentValue, incomingValue, allowedKeys) => {
  const current = toPlainObject(currentValue);
  if (!incomingValue || typeof incomingValue !== 'object' || Array.isArray(incomingValue)) {
    return current;
  }

  const merged = { ...current };
  allowedKeys.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(incomingValue, key)) {
      merged[key] = incomingValue[key];
    }
  });
  delete merged._id;
  return merged;
};

module.exports = {
  TEAM_RECRUITMENT_STATUSES,
  PLAYER_PROFILE_STATUSES,
  TEAM_APPLICATION_STATUSES,
  RECRUITMENT_GAMES,
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
  isUnexpired,
  sameId,
  parsePagination,
  escapeRegex,
  mergeAllowedObject
};
