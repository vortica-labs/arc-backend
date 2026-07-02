const idString = (value) => String(value?._id || value || '');

const validDate = (value) => {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};

const isCurrentGroupMember = (chatRoom, userId) => Boolean(
  chatRoom?.members?.some((member) => idString(member?.user) === idString(userId))
);

/**
 * Resolve only the latest membership epoch. Messages sent before a rejoin or
 * during a leave/rejoin gap are not authorized by the current membership.
 */
const getGroupMembershipWindow = (chatRoom, userId) => {
  const normalizedUserId = idString(userId);
  const current = (chatRoom?.members || []).find(
    (member) => idString(member?.user) === normalizedUserId
  );
  if (current) {
    // joinedAt is schema-backed. Legacy/corrupt rows fall back to the room's
    // creation time; if neither exists, use now rather than exposing history.
    const from = validDate(current.joinedAt)
      || validDate(chatRoom?.createdAt)
      || new Date();
    return { current: true, from, to: null };
  }

  const removals = (chatRoom?.removedMembers || [])
    .filter((entry) => idString(entry?.user) === normalizedUserId)
    .map((entry) => ({
      joinedAt: validDate(entry.joinedAt),
      removedAt: validDate(entry.removedAt)
    }))
    .filter((entry) => entry.removedAt)
    .sort((left, right) => right.removedAt.getTime() - left.removedAt.getTime());
  const latest = removals[0];
  if (!latest) return null;

  // Old rows did not store joinedAt. Using removedAt as both boundaries is
  // deliberately fail-closed and cannot reveal content from a membership gap.
  const from = latest.joinedAt && latest.joinedAt <= latest.removedAt
    ? latest.joinedAt
    : latest.removedAt;
  return { current: false, from, to: latest.removedAt };
};

const groupHistoryBoundary = (window) => {
  if (!window) {
    return { createdAt: { $gt: new Date(8640000000000000) } };
  }
  return window.to
    ? { createdAt: { $gte: window.from, $lte: window.to } }
    : { createdAt: { $gte: window.from } };
};

const canReadGroupMessageAt = (window, createdAt) => {
  const timestamp = validDate(createdAt);
  if (!window || !timestamp || timestamp < window.from) return false;
  return !window.to || timestamp <= window.to;
};

module.exports = {
  isCurrentGroupMember,
  getGroupMembershipWindow,
  groupHistoryBoundary,
  canReadGroupMessageAt
};
