const Follow = require('../models/Follow');
const User = require('../models/User');

const PROFILE_VISIBILITY = Object.freeze(['public', 'followers', 'private']);
const MESSAGE_AUDIENCE = Object.freeze(['everyone', 'followers', 'none']);

const PRIVACY_DEFAULTS = Object.freeze({
  profileVisibility: 'public',
  allowMessageFrom: 'everyone',
  showOnlineStatus: true,
  allowFollowRequests: true,
  showPostsToFollowers: true
});

const idString = (value) => {
  if (value === undefined || value === null) return '';
  if (value && typeof value === 'object' && value._id) return idString(value._id);
  return String(value);
};

const normalizeProfileVisibility = (...values) => {
  const provided = values.filter((value) => value !== undefined);
  for (const value of provided) {
    const normalized = String(value).trim().toLowerCase();
    if (PROFILE_VISIBILITY.includes(normalized)) return normalized;
  }
  // Missing settings retain the product default; malformed persisted settings
  // fail closed instead of silently widening an account to public.
  return provided.length > 0 ? 'private' : PRIVACY_DEFAULTS.profileVisibility;
};

const normalizeMessageAudience = (...values) => {
  const provided = values.filter((value) => value !== undefined);
  for (const value of provided) {
    const normalized = String(value).trim().toLowerCase();
    if (['everyone', 'anyone'].includes(normalized)) return 'everyone';
    if (['followers', 'following', 'people_you_follow'].includes(normalized)) return 'followers';
    if (['none', 'nobody'].includes(normalized)) return 'none';
  }
  return provided.length > 0 ? 'none' : PRIVACY_DEFAULTS.allowMessageFrom;
};

const normalizeBooleanSetting = (...values) => {
  const provided = values.filter((value) => value !== undefined);
  for (const value of provided) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string' && value.trim().toLowerCase() === 'true') return true;
    if (typeof value === 'string' && value.trim().toLowerCase() === 'false') return false;
  }
  return provided.length > 0 ? false : true;
};

/**
 * Canonical privacy contract. Legacy keys remain readable during the rollout,
 * but all policy decisions and API responses use these five fields.
 */
const normalizePrivacySettings = (input = {}) => {
  const source = input?.toObject ? input.toObject() : (input || {});
  const hasCanonical = (key) => Object.prototype.hasOwnProperty.call(source, key)
    && source[key] !== undefined;
  return {
    profileVisibility: hasCanonical('profileVisibility')
      ? normalizeProfileVisibility(source.profileVisibility)
      : normalizeProfileVisibility(source.accountType),
    allowMessageFrom: hasCanonical('allowMessageFrom')
      ? normalizeMessageAudience(source.allowMessageFrom)
      : normalizeMessageAudience(source.whoCanMessage),
    showOnlineStatus: hasCanonical('showOnlineStatus')
      ? normalizeBooleanSetting(source.showOnlineStatus)
      : normalizeBooleanSetting(source.showActivityStatus),
    allowFollowRequests: normalizeBooleanSetting(source.allowFollowRequests),
    showPostsToFollowers: normalizeBooleanSetting(source.showPostsToFollowers)
  };
};

const canonicalToLegacyAliases = (settingsInput) => {
  const settings = normalizePrivacySettings(settingsInput);
  return {
    accountType: settings.profileVisibility === 'followers' ? 'private' : settings.profileVisibility,
    whoCanMessage: settings.allowMessageFrom === 'everyone'
      ? 'anyone'
      : settings.allowMessageFrom === 'followers' ? 'people_you_follow' : 'nobody',
    showActivityStatus: settings.showOnlineStatus
  };
};

const buildPrivacyAccess = ({
  settings: input,
  isSelf = false,
  isFollower = false,
  existingConversation = false,
  blocked = false
} = {}) => {
  const settings = normalizePrivacySettings(input);
  const relationshipAllowsProfile = isSelf
    || settings.profileVisibility === 'public'
    || isFollower;
  const canViewProfile = !blocked && relationshipAllowsProfile;
  const canViewPosts = !blocked && (isSelf || (settings.showPostsToFollowers && canViewProfile));
  const canMessage = !blocked && !isSelf && (
    existingConversation
    || settings.allowMessageFrom === 'everyone'
    || (settings.allowMessageFrom === 'followers' && isFollower)
  );
  const canFollow = !blocked && !isSelf && settings.allowFollowRequests;

  let reason = 'allowed';
  if (blocked) reason = 'blocked';
  else if (!canViewProfile) {
    reason = settings.profileVisibility === 'private' ? 'private_account' : 'followers_only';
  } else if (!canViewPosts) reason = 'posts_hidden';

  return {
    canViewProfile,
    canViewPosts,
    canViewClips: canViewPosts,
    canViewStories: canViewProfile,
    canViewFollowers: canViewProfile,
    canMessage,
    canFollow,
    canSeeOnlineStatus: !blocked && !isSelf && canViewProfile && settings.showOnlineStatus,
    restricted: blocked || !canViewProfile,
    reason
  };
};

const hasId = (items, expectedId) => {
  const expected = idString(expectedId);
  return Array.isArray(items) && items.some((item) => idString(item) === expected);
};

const resolvePrivacyAccess = async ({ viewer, targetUser, existingConversation = false }) => {
  if (!targetUser) throw new Error('targetUser is required');
  const viewerId = idString(viewer);
  const targetId = idString(targetUser);
  const isGuest = !viewerId || viewer?.userType === 'guest';
  const isSelf = !isGuest && viewerId === targetId;

  let isFollower = false;
  let blocked = false;
  if (!isGuest && !isSelf) {
    const [followRelationship, viewerRecord] = await Promise.all([
      Follow.isFollowing(viewerId, targetId),
      viewer?.blockedUsers !== undefined
        ? Promise.resolve(viewer)
        : User.findById(viewerId).select('blockedUsers').lean()
    ]);
    isFollower = followRelationship;
    blocked = hasId(targetUser.blockedUsers, viewerId)
      || hasId(viewerRecord?.blockedUsers, targetId);
  }

  return {
    settings: normalizePrivacySettings(targetUser.privacySettings),
    isSelf,
    isFollower,
    blocked,
    access: buildPrivacyAccess({
      settings: targetUser.privacySettings,
      isSelf,
      isFollower,
      existingConversation,
      blocked
    })
  };
};

const getAuthorDocument = async (post) => {
  if (post?.author && typeof post.author === 'object' && post.author.privacySettings) {
    return post.author;
  }
  const authorId = idString(post?.author);
  if (!authorId) return null;
  return User.findById(authorId)
    .select('username userType profile privacySettings blockedUsers isActive')
    .lean();
};

const resolvePostAccess = async ({ post, viewer }) => {
  const author = await getAuthorDocument(post);
  if (!post || post.isActive === false || post.hiddenByAdmin === true || !author || author.isActive === false) {
    return { allowed: false, reason: 'not_found', author, privacyAccess: null };
  }
  const relationship = await resolvePrivacyAccess({ viewer, targetUser: author });
  if (relationship.blocked) {
    return { allowed: false, reason: 'blocked', author, privacyAccess: relationship.access };
  }
  if (!relationship.access.canViewPosts) {
    return { allowed: false, reason: relationship.access.reason, author, privacyAccess: relationship.access };
  }

  // Historical records with no visibility retain the original public default.
  // A present but malformed value is treated as private so corrupted data can
  // never widen direct-ID access.
  const visibility = post.visibility === undefined || post.visibility === null
    ? 'public'
    : PROFILE_VISIBILITY.includes(post.visibility) ? post.visibility : 'private';
  const allowed = relationship.isSelf
    || visibility === 'public'
    || (visibility === 'followers' && relationship.isFollower);
  return {
    allowed,
    reason: allowed ? 'allowed' : 'post_visibility',
    author,
    privacyAccess: relationship.access,
    isFollower: relationship.isFollower,
    isSelf: relationship.isSelf
  };
};

const filterPostsForViewer = async (posts, viewer) => {
  const candidates = posts || [];
  if (candidates.length === 0) return [];
  const authorIds = [...new Set(candidates.map((post) => idString(post?.author)).filter(Boolean))];
  const populatedAuthors = new Map(candidates
    .map((post) => post?.author)
    .filter((author) => author && typeof author === 'object' && author.privacySettings)
    .map((author) => [idString(author), author]));
  const missingAuthorIds = authorIds.filter((authorId) => !populatedAuthors.has(authorId));
  if (missingAuthorIds.length > 0) {
    const authors = await User.find({ _id: { $in: missingAuthorIds } })
      .select('username userType profile privacySettings blockedUsers isActive')
      .lean();
    authors.forEach((author) => populatedAuthors.set(idString(author), author));
  }

  const viewerId = idString(viewer);
  const isGuest = !viewerId || viewer?.userType === 'guest';
  const [followingIds, viewerRecord] = !isGuest
    ? await Promise.all([
        Follow.find({ follower: viewerId, following: { $in: authorIds } }).distinct('following'),
        viewer?.blockedUsers !== undefined
          ? Promise.resolve(viewer)
          : User.findById(viewerId).select('blockedUsers').lean()
      ])
    : [[], null];
  const followed = new Set(followingIds.map(idString));

  return candidates.filter((post) => {
    const authorId = idString(post?.author);
    const author = populatedAuthors.get(authorId);
    if (!author || author.isActive === false || post.isActive === false || post.hiddenByAdmin === true) return false;
    const isSelf = !isGuest && viewerId === authorId;
    const isFollower = followed.has(authorId);
    const blocked = !isGuest && !isSelf && (
      hasId(author.blockedUsers, viewerId) || hasId(viewerRecord?.blockedUsers, authorId)
    );
    const access = buildPrivacyAccess({ settings: author.privacySettings, isSelf, isFollower, blocked });
    if (!access.canViewPosts) return false;
    const visibility = post.visibility === undefined || post.visibility === null
      ? 'public'
      : PROFILE_VISIBILITY.includes(post.visibility) ? post.visibility : 'private';
    return isSelf || visibility === 'public' || (visibility === 'followers' && isFollower);
  });
};

const minimalProfile = (user) => {
  const source = user?.toObject ? user.toObject() : (user || {});
  const avatar = source.profile?.avatar || source.profilePicture || source.avatar || '';
  return {
    _id: source._id,
    username: source.username,
    userType: source.userType,
    profile: {
      displayName: source.profile?.displayName || source.username || '',
      avatar
    },
    profilePicture: avatar,
    avatar
  };
};

const privacySettingsResponse = (settingsInput, extras = {}) => {
  const canonical = normalizePrivacySettings(settingsInput);
  return {
    success: true,
    data: canonical,
    privacySettings: {
      ...canonical,
      ...canonicalToLegacyAliases(canonical),
      ...(extras.whoCanAddToGroup !== undefined
        ? { whoCanAddToGroup: extras.whoCanAddToGroup }
        : {})
    }
  };
};

module.exports = {
  PROFILE_VISIBILITY,
  MESSAGE_AUDIENCE,
  PRIVACY_DEFAULTS,
  idString,
  normalizeProfileVisibility,
  normalizeMessageAudience,
  normalizePrivacySettings,
  canonicalToLegacyAliases,
  buildPrivacyAccess,
  resolvePrivacyAccess,
  resolvePostAccess,
  filterPostsForViewer,
  minimalProfile,
  privacySettingsResponse
};
