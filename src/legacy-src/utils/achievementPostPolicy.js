const ACHIEVEMENT_TYPES = Object.freeze([
  'tournament_win',
  'rank_achievement',
  'milestone',
  'personal_best',
  'team_achievement',
  'other'
]);

const ACHIEVEMENT_FIELDS = Object.freeze([
  'gameTitle',
  'achievementType',
  'description',
  'date'
]);

const hasOwn = (value, key) => Boolean(
  value
  && typeof value === 'object'
  && Object.prototype.hasOwnProperty.call(value, key)
);

const parseNestedAchievementInfo = (rawValue) => {
  if (!rawValue) return {};
  if (typeof rawValue === 'object' && !Array.isArray(rawValue)) return rawValue;
  if (typeof rawValue !== 'string') return {};

  try {
    const parsed = JSON.parse(rawValue);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_error) {
    return {};
  }
};

const getAchievementField = (body, nested, field) => {
  if (hasOwn(nested, field)) return { provided: true, value: nested[field] };

  const bracketKey = `achievementInfo[${field}]`;
  if (hasOwn(body, bracketKey)) return { provided: true, value: body[bracketKey] };

  const dottedKey = `achievementInfo.${field}`;
  if (hasOwn(body, dottedKey)) return { provided: true, value: body[dottedKey] };

  return { provided: false, value: undefined };
};

const normalizeAchievementInfoInput = (body = {}) => {
  const nested = parseNestedAchievementInfo(body.achievementInfo);
  const value = {};
  const providedFields = [];

  for (const field of ACHIEVEMENT_FIELDS) {
    const input = getAchievementField(body, nested, field);
    if (!input.provided) continue;

    providedFields.push(field);
    if (field === 'date') {
      value.date = input.value;
    } else {
      value[field] = typeof input.value === 'string'
        ? input.value.trim()
        : input.value;
    }
  }

  return { value, providedFields };
};

const validateAchievementPostBody = (body = {}) => {
  const postType = typeof body.postType === 'string' ? body.postType.trim().toLowerCase() : '';
  const normalized = normalizeAchievementInfoInput(body);
  const isAchievementCreate = postType === 'achievement';

  if (!isAchievementCreate) return null;

  if (typeof body.text !== 'string' || body.text.trim().length === 0) {
    return 'Please add some content about your achievement';
  }
  if (!normalized.value.gameTitle) return 'Please enter the game title';
  if (!normalized.value.achievementType) return 'Please select an achievement type';

  if (normalized.providedFields.includes('gameTitle') && !normalized.value.gameTitle) {
    return 'Please enter the game title';
  }

  if (normalized.providedFields.includes('achievementType')) {
    if (!normalized.value.achievementType) return 'Please select an achievement type';
    if (!ACHIEVEMENT_TYPES.includes(normalized.value.achievementType)) {
      return 'Invalid achievement type';
    }
  }

  if (normalized.providedFields.includes('date')) {
    const rawDate = normalized.value.date;
    const parsedDate = new Date(rawDate);
    if (rawDate === null || rawDate === '' || Number.isNaN(parsedDate.getTime())) {
      return 'Invalid achievement date';
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(String(rawDate))
      && parsedDate.toISOString().slice(0, 10) !== rawDate) {
      return 'Invalid achievement date';
    }
  }

  return null;
};

const toAchievementInfoForPersistence = (normalized, { defaultDate = false } = {}) => {
  const source = normalized?.value || {};
  const result = {};

  if (normalized?.providedFields?.includes('gameTitle')) result.gameTitle = source.gameTitle;
  if (normalized?.providedFields?.includes('achievementType')) result.achievementType = source.achievementType;
  if (normalized?.providedFields?.includes('description')) result.description = source.description;
  if (normalized?.providedFields?.includes('date')) result.date = new Date(source.date);
  else if (defaultDate) result.date = new Date();

  return result;
};

module.exports = {
  ACHIEVEMENT_TYPES,
  normalizeAchievementInfoInput,
  validateAchievementPostBody,
  toAchievementInfoForPersistence
};
