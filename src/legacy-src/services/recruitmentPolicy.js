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

const addTeamRecruitmentIntegrityFilters = (query = {}) => addAndCondition(query, {
  $or: [
    {
      recruitmentType: 'roster',
      game: { $in: RECRUITMENT_GAMES },
      role: { $type: 'string' },
      $expr: hasNonBlankStringExpression('role')
    },
    {
      recruitmentType: 'staff',
      staffRole: { $type: 'string' },
      $expr: hasNonBlankStringExpression('staffRole')
    }
  ]
});

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

const effectiveProfileVisibilityExpression = {
  $switch: {
    branches: [
      {
        case: { $in: ['$privacySettings.profileVisibility', ['public', 'followers', 'private']] },
        then: '$privacySettings.profileVisibility'
      },
      {
        case: {
          $and: [
            { $eq: [{ $type: '$privacySettings.profileVisibility' }, 'missing'] },
            {
              $or: [
                { $eq: ['$privacySettings.accountType', 'public'] },
                { $eq: [{ $type: '$privacySettings.accountType' }, 'missing'] }
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

const buildRecruitmentOwnerPrivacyStages = ({ viewerId, viewerBlockedIds = [], followCollectionName = 'follows' } = {}) => {
  const hasViewer = viewerId && mongoose.Types.ObjectId.isValid(String(viewerId));
  if (!hasViewer) {
    return [{ $match: { $expr: { $eq: [effectiveProfileVisibilityExpression, 'public'] } } }];
  }
  const viewerObjectId = new mongoose.Types.ObjectId(String(viewerId));
  const blockedObjectIds = (viewerBlockedIds || [])
    .filter((id) => mongoose.Types.ObjectId.isValid(String(id)))
    .map((id) => new mongoose.Types.ObjectId(String(id)));
  return [
    {
      $lookup: {
        from: followCollectionName,
        let: { ownerId: '$_id' },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ['$follower', viewerObjectId] },
                  { $eq: ['$following', '$$ownerId'] }
                ]
              }
            }
          },
          { $limit: 1 }
        ],
        as: '__viewerFollow'
      }
    },
    {
      $match: {
        $expr: {
          $and: [
            { $not: [{ $in: ['$_id', blockedObjectIds] }] },
            { $not: [{ $in: [viewerObjectId, { $ifNull: ['$blockedUsers', []] }] }] },
            {
              $or: [
                { $eq: ['$_id', viewerObjectId] },
                { $eq: [effectiveProfileVisibilityExpression, 'public'] },
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
  const [result = {}] = await model.aggregate([
    { $match: query },
    {
      $lookup: {
        from: userModel.collection.name,
        let: { ownerId: `$${ownerField}` },
        pipeline: [
          { $match: { $expr: { $eq: ['$_id', '$$ownerId'] } } },
          { $match: getValidRecruitmentOwnerMatch(expectedUserType) },
          ...buildRecruitmentOwnerPrivacyStages({ viewerId, viewerBlockedIds, followCollectionName }),
          { $project: ownerProjection }
        ],
        as: '__validOwner'
      }
    },
    { $unwind: '$__validOwner' },
    { $set: { [ownerField]: '$__validOwner' } },
    { $project: { __validOwner: 0 } },
    { $addFields: { [countField]: { $size: { $ifNull: [`$${countSource}`, []] } } } },
    {
      $facet: {
        records: [
          { $sort: sort },
          { $skip: (page - 1) * limit },
          { $limit: limit }
        ],
        metadata: [{ $count: 'total' }]
      }
    }
  ]).allowDiskUse(true);

  return {
    records: Array.isArray(result.records) ? result.records : [],
    total: Number(result.metadata?.[0]?.total || 0)
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
  const recruitmentIntegrityQuery = addTeamRecruitmentIntegrityFilters({});
  const [result = {}] = await applicationModel.aggregate([
    { $match: query },
    {
      $lookup: {
        from: recruitmentModel.collection.name,
        let: { recruitmentId: '$recruitment' },
        pipeline: [
          { $match: { $expr: { $eq: ['$_id', '$$recruitmentId'] } } },
          { $match: { isActive: true } },
          { $match: recruitmentIntegrityQuery },
          {
            $lookup: {
              from: userModel.collection.name,
              let: { teamId: '$team' },
              pipeline: [
                { $match: { $expr: { $eq: ['$_id', '$$teamId'] } } },
                { $match: getValidRecruitmentOwnerMatch('team') },
                {
                  $project: {
                    _id: 1,
                    username: 1,
                    'profile.displayName': 1,
                    'profile.avatar': 1
                  }
                }
              ],
              as: '__validTeam'
            }
          },
          { $unwind: '$__validTeam' },
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
              team: '$__validTeam'
            }
          }
        ],
        as: '__validRecruitment'
      }
    },
    { $unwind: '$__validRecruitment' },
    {
      $lookup: {
        from: userModel.collection.name,
        let: { applicantId: '$applicant' },
        pipeline: [
          { $match: { $expr: { $eq: ['$_id', '$$applicantId'] } } },
          { $match: getValidRecruitmentOwnerMatch('player') },
          {
            $project: {
              _id: 1,
              username: 1,
              'profile.displayName': 1,
              'profile.avatar': 1
            }
          }
        ],
        as: '__validApplicant'
      }
    },
    { $unwind: '$__validApplicant' },
    {
      $set: {
        recruitment: '$__validRecruitment',
        applicant: '$__validApplicant',
        appliedAt: '$createdAt'
      }
    },
    { $project: { __validRecruitment: 0, __validApplicant: 0 } },
    {
      $facet: {
        records: [
          { $sort: { createdAt: -1, _id: 1 } },
          { $skip: (page - 1) * limit },
          { $limit: limit }
        ],
        metadata: [{ $count: 'total' }]
      }
    }
  ]).allowDiskUse(true);

  return {
    records: Array.isArray(result.records) ? result.records : [],
    total: Number(result.metadata?.[0]?.total || 0)
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
