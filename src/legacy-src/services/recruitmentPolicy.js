const TEAM_RECRUITMENT_STATUSES = Object.freeze(['active', 'paused', 'closed', 'filled']);
const PLAYER_PROFILE_STATUSES = Object.freeze(['active', 'paused', 'inactive']);
const TEAM_APPLICATION_STATUSES = Object.freeze(['reviewed', 'shortlisted', 'rejected', 'accepted']);

const toPlainObject = (value) => {
  if (!value) return {};
  if (typeof value.toObject === 'function') {
    return value.toObject({ virtuals: true });
  }
  return { ...value };
};

const serializeTeamRecruitment = (value) => {
  const recruitment = toPlainObject(value);
  const applicants = Array.isArray(recruitment.applicants) ? recruitment.applicants : [];
  const explicitCount = Number(recruitment.applicantCount);
  recruitment.applicantCount = Number.isFinite(explicitCount) ? explicitCount : applicants.length;
  delete recruitment.applicants;
  return recruitment;
};

const serializePlayerProfile = (value, { includeInterestedTeams = false } = {}) => {
  const profile = toPlainObject(value);
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
  serializeTeamRecruitment,
  serializePlayerProfile,
  isRecruitmentLive,
  isPlayerProfileLive,
  isUnexpired,
  sameId,
  parsePagination,
  escapeRegex,
  mergeAllowedObject
};
