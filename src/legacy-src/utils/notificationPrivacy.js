const Post = require('../models/Post');
const User = require('../models/User');
const { filterPostsForViewer } = require('./privacyPolicy');

const idString = (value) => String(value?._id || value || '');

const genericUnavailableMessage = 'This notification refers to content that is no longer available.';

const SOCIAL_SENDER_TYPES = new Set([
  'like', 'comment', 'follow', 'message', 'story', 'clip', 'call', 'mention', 'achievement', 'recruitment'
]);
const SENSITIVE_LINK_KEYS = Object.freeze([
  'postId', 'clipId', 'storyId', 'sharedPostId', 'messageId', 'conversationId', 'chatId',
  'profileId', 'userId', 'teamId', 'recruitmentId', 'applicationId', 'tournamentId',
  'scrimId', 'url', 'deepLink'
]);

const redactRestrictedNotification = (notification, title = 'Activity unavailable') => {
  const safe = notification?.toObject
    ? notification.toObject({ virtuals: true })
    : JSON.parse(JSON.stringify(notification || {}));
  safe.sender = null;
  safe.title = title;
  safe.message = genericUnavailableMessage;
  safe.data = { ...(safe.data || {}) };
  for (const key of SENSITIVE_LINK_KEYS) delete safe.data[key];
  const customData = safe.data.customData && typeof safe.data.customData === 'object'
    ? { ...safe.data.customData }
    : {};
  for (const key of SENSITIVE_LINK_KEYS) delete customData[key];
  safe.data.customData = { ...customData, contentUnavailable: true };
  return safe;
};

const redactRestrictedPostNotification = (notification) => {
  return redactRestrictedNotification(notification, 'Content unavailable');
};

/**
 * Notification rows are durable, while access to their linked posts is not.
 * Re-evaluate authorization on every inbox read so a privacy change, block,
 * deletion, or moderation action cannot be bypassed by an old notification.
 */
const sanitizeNotificationsForViewer = async (notifications, viewer) => {
  const rows = notifications || [];
  const viewerId = idString(viewer);
  const senderIds = [...new Set(rows.map((notification) => idString(notification?.sender)).filter(Boolean))];
  const [senders, viewerRecord] = await Promise.all([
    senderIds.length
      ? User.find({ _id: { $in: senderIds } }).select('_id isActive blockedUsers').lean()
      : [],
    viewerId && viewer?.blockedUsers === undefined
      ? User.findById(viewerId).select('blockedUsers').lean()
      : viewer
  ]);
  const viewerBlockedIds = new Set((viewerRecord?.blockedUsers || []).map(idString));
  const senderById = new Map(senders.map((sender) => [idString(sender._id), sender]));
  const senderIsRestricted = (notification) => {
    const senderId = idString(notification?.sender);
    if (!senderId) return SOCIAL_SENDER_TYPES.has(String(notification?.type || ''));
    const sender = senderById.get(senderId);
    return !sender
      || sender.isActive === false
      || viewerBlockedIds.has(senderId)
      || (sender.blockedUsers || []).some((blockedId) => idString(blockedId) === viewerId);
  };
  const senderSafeRows = rows.map((notification) => (
    senderIsRestricted(notification) ? redactRestrictedNotification(notification) : notification
  ));
  const postIds = [...new Set(rows
    .map((notification) => idString(notification?.data?.postId))
    .filter(Boolean))];
  if (!postIds.length) {
    return senderSafeRows.map((notification) => (
      notification?.toObject ? notification.toObject({ virtuals: true }) : notification
    ));
  }

  const posts = await Post.find({ _id: { $in: postIds } })
    .select('author content.text visibility isActive hiddenByAdmin')
    .populate('author', 'username userType profile.displayName profile.avatar privacySettings blockedUsers isActive')
    .lean();
  const visiblePosts = await filterPostsForViewer(posts, viewer);
  const visibleById = new Map(visiblePosts.map((post) => [idString(post._id), post]));

  return senderSafeRows.map((notification) => {
    if (notification?.data?.customData?.contentUnavailable === true) return notification;
    const postId = idString(notification?.data?.postId);
    if (!postId) {
      return notification?.toObject ? notification.toObject({ virtuals: true }) : notification;
    }
    const visiblePost = visibleById.get(postId);
    if (!visiblePost) return redactRestrictedPostNotification(notification);

    const safe = notification?.toObject
      ? notification.toObject({ virtuals: true })
      : JSON.parse(JSON.stringify(notification));
    safe.data = {
      ...(safe.data || {}),
      postId: {
        _id: visiblePost._id,
        content: { text: visiblePost.content?.text || '' }
      }
    };
    return safe;
  });
};

module.exports = {
  genericUnavailableMessage,
  redactRestrictedNotification,
  redactRestrictedPostNotification,
  sanitizeNotificationsForViewer
};
