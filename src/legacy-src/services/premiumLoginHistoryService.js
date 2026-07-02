const mongoose = require('mongoose');
const PremiumMembership = require('../models/PremiumMembership');
const UserLoginEvent = require('../models/UserLoginEvent');

const notFound = () => {
  const error = new Error('Membership not found');
  error.statusCode = 404;
  error.code = 'MEMBERSHIP_NOT_FOUND';
  return error;
};

const listPremiumMemberLogins = async (membershipId, query = {}) => {
  if (!mongoose.Types.ObjectId.isValid(String(membershipId))) throw notFound();
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const limit = Math.max(1, Math.min(100, Number.parseInt(query.limit, 10) || 25));
  const membership = await PremiumMembership.findOne({ _id: membershipId, isCurrent: true })
    .select('user')
    .lean();
  if (!membership) throw notFound();

  const filter = { user: membership.user };
  const [events, total] = await Promise.all([
    UserLoginEvent.find(filter)
      .select('authMethod timestamp ip userAgent platform device')
      .sort({ timestamp: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    UserLoginEvent.countDocuments(filter),
  ]);

  return {
    logins: events.map((event) => ({
      id: String(event._id),
      _id: event._id,
      authMethod: event.authMethod,
      timestamp: event.timestamp,
      ip: event.ip || '',
      userAgent: event.userAgent || '',
      platform: event.platform || 'unknown',
      device: event.device || '',
    })),
    retentionDays: Math.floor(UserLoginEvent.RETENTION_SECONDS / (24 * 60 * 60)),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  };
};

module.exports = { listPremiumMemberLogins };
