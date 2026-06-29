const User = require('../models/User');
const Post = require('../models/Post');
const Report = require('../models/Report');
const { Message } = require('../models/Message');
const Tournament = require('../models/Tournament');
const Notification = require('../models/Notification');
const Story = require('../models/Story');
const TeamRecruitment = require('../models/TeamRecruitment');
const RandomConnection = require('../models/RandomConnection');
const Feedback = require('../models/Feedback');
const BoostCampaign = require('../models/BoostCampaign');
const PaymentTransaction = require('../models/PaymentTransaction');
const AdminAuditLog = require('../models/AdminAuditLog');
const MonetizationApplication = require('../models/MonetizationApplication');
const CreatorBankDetails = require('../models/CreatorBankDetails');
const CreatorPayout = require('../models/CreatorPayout');
const EarningsSnapshot = require('../models/EarningsSnapshot');
const WithdrawalRequest = require('../models/WithdrawalRequest');
const HostVerificationApplication = require('../models/HostVerificationApplication');
const mongoose = require('mongoose');
const { createSystemNotification } = require('../utils/notificationService');
const { PLATFORM_DEFAULT_CPM } = require('../services/CreatorEarningsCalculationService');
const {
  applyManualDeliveryProgress,
  processDueManualBoostDeliveries,
  processSingleManualBoostCampaign
} = require('../services/boostService');
const log = require('../utils/logger');

const dayMs = 24 * 60 * 60 * 1000;

const countSafe = (model, query = {}) => model.countDocuments(query).catch(() => 0);
const sumSafe = async (model, match, field) => {
  const result = await model.aggregate([
    { $match: match },
    { $group: { _id: null, total: { $sum: field } } }
  ]).catch(() => []);
  return result[0]?.total || 0;
};

const growthSeries = async (model, match = {}, days = 14) => {
  const startDate = new Date(Date.now() - ((days - 1) * dayMs));
  return model.aggregate([
    { $match: { ...match, createdAt: { $gte: startDate } } },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
        count: { $sum: 1 }
      }
    },
    { $sort: { _id: 1 } }
  ]).catch(() => []);
};

const normalizeLimit = (value, fallback = 20, max = 100) => Math.min(max, Math.max(1, parseInt(value, 10) || fallback));

const getAdminActor = (req) => ({
  username: req.user?.username || 'admin',
  role: req.user?.adminRole || 'admin'
});

const parsePositiveInt = (value, fallback = 0) => {
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const normalizeDurationMinutes = ({ durationMinutes, durationHours, fallback = 360 } = {}) => {
  const fromMinutes = parsePositiveInt(durationMinutes, 0);
  const fromHours = Number(durationHours);
  const minutes = fromMinutes || (Number.isFinite(fromHours) && fromHours > 0 ? Math.round(fromHours * 60) : fallback);
  return Math.min(43200, Math.max(30, minutes));
};

const buildDeliveryTimelineEntry = (type, {
  views = 0,
  campaign,
  reason = '',
  message = '',
  previousValue = null,
  newValue = null,
  actor
} = {}) => ({
  type,
  views,
  deliveredViews: Number(campaign?.manualDelivery?.deliveredViews || 0),
  remainingViews: Number(campaign?.manualDelivery?.remainingViews ?? campaign?.remainingReach ?? 0),
  progress: Number(campaign?.manualDelivery?.deliveryPercent || 0),
  reason: String(reason || '').slice(0, 500),
  message,
  previousValue,
  newValue,
  actor: actor || { username: 'system', role: 'system' },
  createdAt: new Date()
});

// Get dashboard stats
const getDashboardStats = async (req, res) => {
  try {
    const now = Date.now();
    const since24h = new Date(now - dayMs);
    const since30d = new Date(now - (30 * dayMs));

    await processDueManualBoostDeliveries({ limit: 50 });

    const [
      totalUsers,
      dailyActiveUsers,
      monthlyActiveUsers,
      premiumUsers,
      teams,
      creators,
      verifiedHosts,
      pendingHostRequests,
      liveTournaments,
      totalRecruitments,
      totalTournaments,
      totalPosts,
      clips,
      stories,
      totalMessages,
      calls,
      randomConnectSessions,
      totalNotifications,
      reports,
      openTickets,
      boostCampaigns,
      runningBoostCampaigns,
      creatorApplications,
      pendingCreatorApplications,
      newUsersToday,
      newPostsToday,
      newTournamentsToday,
      revenue,
      boostRevenue,
      creatorPayouts,
      pendingCreatorPayouts
    ] = await Promise.all([
      countSafe(User, { isActive: true }),
      countSafe(User, { isActive: true, lastSeen: { $gte: since24h } }),
      countSafe(User, { isActive: true, lastSeen: { $gte: since30d } }),
      countSafe(User, { isActive: true, $or: [{ isPremium: true }, { 'membership.tier': { $ne: 'free' } }] }),
      countSafe(User, { isActive: true, userType: 'team' }),
      countSafe(User, { isActive: true, isCreator: true }),
      countSafe(User, { isActive: true, isVerifiedHost: true }),
      countSafe(HostVerificationApplication, { status: 'pending' }),
      countSafe(Tournament, { status: { $in: ['Ongoing', 'ongoing', 'active', 'live'] } }),
      countSafe(TeamRecruitment, { isActive: true }),
      countSafe(Tournament),
      countSafe(Post, { isActive: { $ne: false } }),
      countSafe(Post, { isActive: { $ne: false }, 'content.media.type': 'video' }),
      countSafe(Story),
      countSafe(Message, { isDeleted: { $ne: true } }),
      countSafe(RandomConnection),
      countSafe(RandomConnection, { status: { $in: ['active', 'waiting'] } }),
      countSafe(Notification),
      countSafe(Report),
      countSafe(Feedback, { status: { $in: ['pending', 'reviewed'] } }),
      countSafe(BoostCampaign),
      countSafe(BoostCampaign, { status: 'running' }),
      countSafe(MonetizationApplication),
      countSafe(MonetizationApplication, { status: 'pending' }),
      countSafe(User, { isActive: true, createdAt: { $gte: since24h } }),
      countSafe(Post, { createdAt: { $gte: since24h } }),
      countSafe(Tournament, { createdAt: { $gte: since24h } }),
      sumSafe(PaymentTransaction, { status: 'completed' }, '$amount'),
      sumSafe(PaymentTransaction, { status: 'completed', type: 'boost' }, '$amount'),
      sumSafe(CreatorPayout, { status: { $in: ['paid', 'pending', 'held'] } }, '$amount'),
      sumSafe(CreatorPayout, { status: { $in: ['pending', 'held'] } }, '$amount')
    ]);

    const userTypeStats = await User.aggregate([
      { $match: { isActive: true } },
      { $group: { _id: '$userType', count: { $sum: 1 } } }
    ]).catch(() => []);

    const postTypeStats = await Post.aggregate([
      { $group: { _id: '$postType', count: { $sum: 1 } } }
    ]).catch(() => []);

    const tournamentStats = await Tournament.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]).catch(() => []);

    const revenueByDay = await PaymentTransaction.aggregate([
      { $match: { status: 'completed', createdAt: { $gte: new Date(now - (13 * dayMs)) } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          revenue: { $sum: '$amount' },
          transactions: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]).catch(() => []);

    const recentActivity = await Promise.all([
      User.find({ username: { $not: /^duo_/ } }).sort({ createdAt: -1 }).limit(5).select('username profile.displayName createdAt userType isActive').lean(),
      Post.find().sort({ createdAt: -1 }).limit(5).populate('author', 'username profile.displayName').select('content postType createdAt author').lean(),
      AdminAuditLog.find().sort({ createdAt: -1 }).limit(8).select('actor action resourceType resourceId statusCode createdAt').lean()
    ]);

    res.json({
      success: true,
      data: {
        overview: {
          totalUsers,
          dailyActiveUsers,
          monthlyActiveUsers,
          premiumUsers,
          teams,
          users: totalUsers,
          creators,
          verifiedHosts,
          pendingHostRequests,
          liveTournaments,
          recruitments: totalRecruitments,
          totalPosts,
          clips,
          stories,
          totalMessages,
          calls,
          randomConnectSessions,
          totalTournaments,
          totalNotifications,
          activeUsers: dailyActiveUsers,
          reports,
          openTickets,
          boostCampaigns,
          runningBoostCampaigns,
          creatorApplications,
          pendingCreatorApplications,
          revenue,
          boostRevenue,
          creatorPayouts,
          pendingCreatorPayouts,
          newUsersToday,
          newPostsToday,
          newTournamentsToday
        },
        metrics: [
          { key: 'totalUsers', label: 'Total Users', value: totalUsers, trend: newUsersToday },
          { key: 'dailyActiveUsers', label: 'Daily Active Users', value: dailyActiveUsers },
          { key: 'monthlyActiveUsers', label: 'Monthly Active Users', value: monthlyActiveUsers },
          { key: 'premiumUsers', label: 'Premium Users', value: premiumUsers },
          { key: 'teams', label: 'Teams', value: teams },
          { key: 'creators', label: 'Creators', value: creators },
          { key: 'verifiedHosts', label: 'Verified Hosts', value: verifiedHosts },
          { key: 'pendingHostRequests', label: 'Pending Host Requests', value: pendingHostRequests },
          { key: 'liveTournaments', label: 'Live Tournaments', value: liveTournaments },
          { key: 'recruitments', label: 'Recruitments', value: totalRecruitments },
          { key: 'posts', label: 'Posts', value: totalPosts, trend: newPostsToday },
          { key: 'clips', label: 'Clips', value: clips },
          { key: 'stories', label: 'Stories', value: stories },
          { key: 'messages', label: 'Messages', value: totalMessages },
          { key: 'calls', label: 'Calls', value: calls },
          { key: 'randomConnectSessions', label: 'Random Connect Sessions', value: randomConnectSessions },
          { key: 'revenue', label: 'Revenue', value: revenue, currency: 'INR' },
          { key: 'boostRevenue', label: 'Boost Revenue', value: boostRevenue, currency: 'INR' },
          { key: 'creatorPayouts', label: 'Creator Payouts', value: creatorPayouts, currency: 'INR' },
          { key: 'reports', label: 'Reports', value: reports },
          { key: 'openTickets', label: 'Open Tickets', value: openTickets }
        ],
        breakdowns: {
          userTypes: userTypeStats,
          postTypes: postTypeStats,
          tournamentStatuses: tournamentStats
        },
        growth: {
          users: await growthSeries(User, { isActive: true }),
          posts: await growthSeries(Post, {}),
          revenue: revenueByDay
        },
        recentActivity: {
          users: recentActivity[0],
          posts: recentActivity[1],
          auditLogs: recentActivity[2]
        },
        server: {
          status: 'healthy',
          uptime: process.uptime(),
          memoryUsage: process.memoryUsage(),
          database: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
          api: 'running',
          storageUsage: null,
          databaseUsage: null,
          timestamp: new Date()
        }
      }
    });
  } catch (error) {
    log.error('Admin dashboard stats error:', { error: String(error) });
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch dashboard stats',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined 
    });
  }
};

// Get user analytics
const getUserAnalytics = async (req, res) => {
  try {
    const { period = '7d' } = req.query;
    const days = period === '7d' ? 7 : period === '30d' ? 30 : 1;
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const userStats = await User.aggregate([
      {
        $match: { createdAt: { $gte: startDate } }
      },
      {
        $group: {
          _id: {
            $dateToString: { format: '%Y-%m-%d', date: '$createdAt' }
          },
          count: { $sum: 1 },
          players: {
            $sum: { $cond: [{ $eq: ['$userType', 'player'] }, 1, 0] }
          },
          teams: {
            $sum: { $cond: [{ $eq: ['$userType', 'team'] }, 1, 0] }
          }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    res.json({ success: true, data: userStats });
  } catch (error) {
    log.error('User analytics error:', { error: String(error) });
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch user analytics',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined 
    });
  }
};

// Get system health
const getSystemHealth = async (req, res) => {
  try {
    // Test database connection
    const dbStatus = await mongoose.connection.readyState === 1 ? 'connected' : 'disconnected';
    
    const health = {
      status: 'healthy',
      timestamp: new Date(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      cpu: process.cpuUsage(),
      database: dbStatus,
      services: {
        api: 'running',
        socket: 'running',
        database: dbStatus
      },
      environment: process.env.NODE_ENV || 'development'
    };

    res.json({ success: true, data: health });
  } catch (error) {
    log.error('System health error:', { error: String(error) });
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch system health',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined 
    });
  }
};

// Get recent activities
const getRecentActivities = async (req, res) => {
  try {
    const activities = await Promise.all([
      User.find()
        .sort({ createdAt: -1 })
        .limit(10)
        .select('username profile.displayName createdAt userType isActive'),
      Post.find()
        .sort({ createdAt: -1 })
        .limit(10)
        .populate('author', 'username profile.displayName')
        .select('content type createdAt author'),
      Tournament.find()
        .sort({ createdAt: -1 })
        .limit(10)
        .populate('host', 'username profile.displayName')
        .select('name game status createdAt host')
    ]);

    res.json({
      success: true,
      data: {
        recentUsers: activities[0],
        recentPosts: activities[1],
        recentTournaments: activities[2]
      }
    });
  } catch (error) {
    log.error('Recent activities error:', { error: String(error) });
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch recent activities',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined 
    });
  }
};

// Get all users with pagination
const getUsers = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search || '';
    const userType = req.query.userType || '';
    const isActive = req.query.isActive;

    const query = {
      // Exclude duo teams (temporary teams created for tournaments)
      username: { $not: /^duo_/ }
    };
    
    if (search) {
      query.$or = [
        { username: { $regex: search, $options: 'i' } },
        { 'profile.displayName': { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } }
      ];
    }
    
    if (userType) {
      query.userType = userType;
    }
    
    if (isActive !== undefined) {
      query.isActive = isActive === 'true';
    }

    const users = await User.find(query)
      .select('-password')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await User.countDocuments(query);

    res.json({
      success: true,
      data: {
        users,
        pagination: {
          current: page,
          pages: Math.ceil(total / limit),
          total
        }
      }
    });
  } catch (error) {
    log.error('Get users error:', { error: String(error) });
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch users',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined 
    });
  }
};

// Update user status
const updateUserStatus = async (req, res) => {
  try {
    const { userId } = req.params;
    const { isActive } = req.body;

    const user = await User.findByIdAndUpdate(
      userId,
      { isActive },
      { new: true }
    ).select('-password');

    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    res.json({
      success: true,
      message: `User ${isActive ? 'activated' : 'deactivated'} successfully`,
      data: user
    });
  } catch (error) {
    log.error('Update user status error:', { error: String(error) });
    res.status(500).json({ 
      success: false, 
      message: 'Failed to update user status',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined 
    });
  }
};

// Delete user
const deleteUser = async (req, res) => {
  try {
    const { userId } = req.params;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Delete user and related data
    await Promise.all([
      User.findByIdAndDelete(userId),
      Post.deleteMany({ author: userId }),
      Message.deleteMany({ $or: [{ sender: userId }, { receiver: userId }] }),
      Notification.deleteMany({ user: userId })
    ]);

    res.json({
      success: true,
      message: 'User deleted successfully'
    });
  } catch (error) {
    log.error('Delete user error:', { error: String(error) });
    res.status(500).json({ 
      success: false, 
      message: 'Failed to delete user',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined 
    });
  }
};

// Get posts with pagination
const getPosts = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search || '';
    const author = req.query.author || '';
    const isActive = req.query.isActive;

    const query = {};
    
    if (search) {
      query.$or = [
        { content: { $regex: search, $options: 'i' } },
        { 'author.username': { $regex: search, $options: 'i' } },
        { 'author.profile.displayName': { $regex: search, $options: 'i' } }
      ];
    }
    
    if (author) {
      query['author.userType'] = author;
    }
    
    if (isActive !== undefined) {
      query.isActive = isActive === 'true';
    }

    const posts = await Post.find(query)
      .populate('author', 'username email profile.displayName profile.avatar userType')
      .select('content images likes comments createdAt updatedAt isActive author')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await Post.countDocuments(query);

    res.json({
      success: true,
      data: {
        posts,
        pagination: {
          current: page,
          pages: Math.ceil(total / limit),
          total
        }
      }
    });
  } catch (error) {
    log.error('Get posts error:', { error: String(error) });
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch posts',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined 
    });
  }
};

// Delete post
const deletePost = async (req, res) => {
  try {
    const { postId } = req.params;

    const post = await Post.findByIdAndDelete(postId);
    if (!post) {
      return res.status(404).json({
        success: false,
        message: 'Post not found'
      });
    }

    res.json({
      success: true,
      message: 'Post deleted successfully'
    });
  } catch (error) {
    log.error('Delete post error:', { error: String(error) });
    res.status(500).json({ 
      success: false, 
      message: 'Failed to delete post',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined 
    });
  }
};

// Tournament Management
const getTournaments = async (req, res) => {
  try {
    const { page = 1, limit = 10, search, status } = req.query;
    
    let query = {};
    
    // Search filter
    if (search) {
      query.$or = [
        { name: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
        { game: { $regex: search, $options: 'i' } }
      ];
    }
    
    // Status filter
    if (status && status !== 'all') {
      query.status = status;
    }
    
    const tournaments = await Tournament.find(query)
      .select('name description game startDate endDate totalSlots participants prizePool status isActive createdAt updatedAt host')
      .populate('host', 'username profile.displayName')
      .sort({ createdAt: -1 })
      .limit(limit * 1)
      .skip((page - 1) * limit);

    const total = await Tournament.countDocuments(query);

    res.json({
      success: true,
      tournaments,
      pagination: {
        total,
        pages: Math.ceil(total / limit),
        currentPage: parseInt(page),
        limit: parseInt(limit)
      }
    });
  } catch (error) {
    log.error('Get tournaments error:', { error: String(error) });
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

const deleteTournament = async (req, res) => {
  try {
    const { tournamentId } = req.params;
    
    const tournament = await Tournament.findByIdAndDelete(tournamentId);
    if (!tournament) {
      return res.status(404).json({ success: false, message: 'Tournament not found' });
    }

    res.json({ success: true, message: 'Tournament deleted successfully' });
  } catch (error) {
    log.error('Delete tournament error:', { error: String(error) });
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Reports: list all reports
const getReports = async (req, res) => {
  try {
    const { page = 1, limit = 20, status, targetType } = req.query;
    const query = {};
    if (status && status !== 'all') query.status = status;
    if (targetType && targetType !== 'all') query.targetType = targetType;

    const reports = await Report.find(query)
      .populate('reporter', 'username profile.displayName profile.avatar email')
      .populate('reviewedBy', 'username profile.displayName')
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit))
      .lean();

    const total = await Report.countDocuments(query);

    res.json({
      success: true,
      data: { reports, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) }
    });
  } catch (error) {
    log.error('Get reports error:', { error: String(error) });
    res.status(500).json({ success: false, message: 'Failed to fetch reports' });
  }
};

// Reports: update status / take action
const updateReport = async (req, res) => {
  try {
    const { reportId } = req.params;
    const { status, adminAction } = req.body;
    const adminId = req.user._id;

    const report = await Report.findById(reportId);
    if (!report) {
      return res.status(404).json({ success: false, message: 'Report not found' });
    }

    if (status) report.status = status;
    if (adminAction) report.adminAction = adminAction;
    report.reviewedBy = adminId;
    report.reviewedAt = new Date();
    if (adminAction === 'dismiss' || !adminAction) report.status = 'dismissed';
    else report.status = 'action_taken';
    await report.save();

    if (adminAction === 'hide_content' && report.targetType === 'post') {
      await Post.findByIdAndUpdate(report.targetId, { hiddenByAdmin: true, isActive: false });
    } else if (adminAction === 'delete_content' && report.targetType === 'post') {
      await Post.findByIdAndDelete(report.targetId);
    } else if (adminAction === 'warn_user') {
      const post = await Post.findById(report.targetId).select('author');
      if (post?.author) {
        await createSystemNotification(
          post.author,
          'Content Report Warning',
          'Your content was reported and reviewed. Please ensure it follows community guidelines.'
        );
      }
    } else if (adminAction === 'ban_user') {
      const post = await Post.findById(report.targetId).select('author');
      if (post?.author) {
        await User.findByIdAndUpdate(post.author, { isActive: false });
      }
    }

    const updated = await Report.findById(reportId)
      .populate('reporter', 'username profile.displayName')
      .populate('reviewedBy', 'username profile.displayName');
    res.json({ success: true, message: 'Report updated', data: { report: updated } });
  } catch (error) {
    log.error('Update report error:', { error: String(error) });
    res.status(500).json({ success: false, message: 'Failed to update report' });
  }
};

// Reset user password
const resetUserPassword = async (req, res) => {
  try {
    const { userId } = req.params;
    const { newPassword } = req.body;

    // Validate password
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 6 characters long'
      });
    }

    // Find user
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Update password (the pre-save hook will hash it)
    user.password = newPassword;
    await user.save();

    res.json({
      success: true,
      message: 'Password reset successfully'
    });
  } catch (error) {
    log.error('Reset user password error:', { error: String(error) });
    res.status(500).json({ 
      success: false, 
      message: 'Failed to reset password',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined 
    });
  }
};

// --- Monetization (creator applications) ---

const getMonetizationApplications = async (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const query = {};
    if (status && status !== 'all') query.status = status;

    const applications = await MonetizationApplication.find(query)
      .populate('user', 'username profile.displayName profile.avatar profile.bio email createdAt')
      .sort({ appliedAt: -1 })
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit))
      .lean();

    const total = await MonetizationApplication.countDocuments(query);

    // Enrich with follower count and content sample (post count, recent posts)
    const enriched = await Promise.all(applications.map(async (app) => {
      const u = await User.findById(app.user._id).select('followers').lean();
      const followersCount = (u?.followers && u.followers.length) || 0;
      const recentPosts = await Post.find({ author: app.user._id })
        .select('content postType createdAt')
        .sort({ createdAt: -1 })
        .limit(5)
        .lean();
      const postCount = await Post.countDocuments({ author: app.user._id });
      const contentSamples = recentPosts.map(p => ({
        _id: p._id,
        text: p.content?.text?.slice(0, 100),
        postType: p.postType,
        createdAt: p.createdAt
      }));
      const userPostIds = await Post.find({ author: app.user._id }).select('_id').lean().then(p => p.map(x => x._id));
      const reportsAgainstUser = await Report.countDocuments({
        $or: [
          { targetType: 'user', targetId: app.user._id },
          { targetType: 'post', targetId: { $in: userPostIds } }
        ],
        status: { $in: ['pending', 'action_taken'] }
      });
      const suspiciousViewSpike = Boolean(app?.eligibilitySnapshot?.metrics?.suspiciousViewSpike);
      return {
        ...app,
        applicantStats: { followersCount, postCount, reportsAgainstUser },
        contentSamples,
        fraudRiskIndicators: {
          highReportCount: reportsAgainstUser > 2,
          lowContent: postCount < 3,
          suspiciousViewSpike
        }
      };
    }));

    res.json({
      success: true,
      data: {
        applications: enriched,
        total,
        page: parseInt(page),
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    log.error('Get monetization applications error:', { error: String(error) });
    res.status(500).json({ success: false, message: 'Failed to fetch applications', error: process.env.NODE_ENV === 'development' ? error.message : undefined });
  }
};

const approveMonetizationApplication = async (req, res) => {
  try {
    const { applicationId } = req.params;
    const adminId = req.user._id;

    const application = await MonetizationApplication.findById(applicationId);
    if (!application) {
      return res.status(404).json({ success: false, message: 'Application not found' });
    }
    if (application.status !== 'pending') {
      return res.status(400).json({ success: false, message: 'Application is not pending' });
    }

    application.status = 'approved';
    application.reviewedAt = new Date();
    application.reviewedBy = adminId;
    await application.save();

    await User.findByIdAndUpdate(application.user, { isCreator: true });

    await createSystemNotification(
      application.user,
      'Monetization Approved',
      'Your creator monetization application has been approved. You can now add bank details and start earning.',
      { type: 'monetization_approved', applicationId: application._id }
    );

    res.json({
      success: true,
      message: 'Application approved. Creator has been enabled for the user.',
      data: { application: { _id: application._id, status: application.status } }
    });
  } catch (error) {
    log.error('Approve monetization error:', { error: String(error) });
    res.status(500).json({ success: false, message: 'Failed to approve', error: process.env.NODE_ENV === 'development' ? error.message : undefined });
  }
};

const rejectMonetizationApplication = async (req, res) => {
  try {
    const { applicationId } = req.params;
    const { rejectionReason, cooldownDays = 30 } = req.body || {};
    const adminId = req.user._id;

    const application = await MonetizationApplication.findById(applicationId);
    if (!application) {
      return res.status(404).json({ success: false, message: 'Application not found' });
    }
    if (application.status !== 'pending') {
      return res.status(400).json({ success: false, message: 'Application is not pending' });
    }

    const reapplyAfter = new Date();
    reapplyAfter.setDate(reapplyAfter.getDate() + (parseInt(cooldownDays) || 30));

    application.status = 'rejected';
    application.rejectionReason = rejectionReason || 'Your application did not meet our criteria.';
    application.adminRemark = (req.body.adminRemark || '').slice(0, 1000);
    application.reviewedAt = new Date();
    application.reviewedBy = adminId;
    application.reapplyAfter = reapplyAfter;
    await application.save();

    await createSystemNotification(
      application.user,
      'Monetization Application Rejected',
      application.rejectionReason + (reapplyAfter ? ` You can re-apply after ${reapplyAfter.toLocaleDateString()}.` : ''),
      { type: 'monetization_rejected', applicationId: application._id, reapplyAfter }
    );

    res.json({
      success: true,
      message: 'Application rejected.',
      data: { application: { _id: application._id, status: application.status, reapplyAfter } }
    });
  } catch (error) {
    log.error('Reject monetization error:', { error: String(error) });
    res.status(500).json({ success: false, message: 'Failed to reject', error: process.env.NODE_ENV === 'development' ? error.message : undefined });
  }
};

const holdCreatorPayout = async (req, res) => {
  try {
    const { userId } = req.params;
    const { reason } = req.body || {};

    const snapshot = await EarningsSnapshot.findOneAndUpdate(
      { user: userId, held: false },
      { held: true, holdReason: reason || 'Under review' },
      { new: true }
    );
    if (snapshot) {
      await CreatorPayout.updateMany(
        { user: userId, status: 'pending' },
        { status: 'held', heldReason: reason || 'Under review' }
      );
    }

    await createSystemNotification(
      userId,
      'Payout On Hold',
      reason || 'Your payout is under review. Our team will contact you if needed.',
      { type: 'payout_held' }
    );

    res.json({
      success: true,
      message: 'Payout held for creator.',
      data: { userId }
    });
  } catch (error) {
    log.error('Hold payout error:', { error: String(error) });
    res.status(500).json({ success: false, message: 'Failed to hold payout', error: process.env.NODE_ENV === 'development' ? error.message : undefined });
  }
};

// Task 5.1: List all approved creators
const getApprovedCreators = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;

    const creators = await User.find({ isCreator: true, isActive: true })
      .select('username profile.displayName profile.avatar creatorCpm')
      .sort({ createdAt: -1 })
      .limit(limit)
      .skip((page - 1) * limit)
      .lean();

    const total = await User.countDocuments({ isCreator: true, isActive: true });

    res.json({
      success: true,
      data: {
        creators,
        pagination: { page, pages: Math.ceil(total / limit), total }
      }
    });
  } catch (error) {
    log.error('Get approved creators error:', { error: String(error) });
    res.status(500).json({ success: false, message: 'Failed to fetch creators' });
  }
};

// Task 5.2: Revoke creator monetization
const revokeMonetization = async (req, res) => {
  try {
    const { userId } = req.params;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    if (!user.isCreator) return res.status(400).json({ success: false, message: 'User is not an approved creator' });

    user.isCreator = false;
    await user.save();

    await createSystemNotification(
      userId,
      'Creator Monetization Revoked',
      'Your creator monetization access has been revoked by the platform. Please contact support if you have questions.',
      { type: 'monetization_revoked' }
    );

    res.json({ success: true, message: 'Monetization revoked successfully' });
  } catch (error) {
    log.error('Revoke monetization error:', { error: String(error) });
    res.status(500).json({ success: false, message: 'Failed to revoke monetization' });
  }
};

// Task 5.3: Grant creator monetization
const grantMonetization = async (req, res) => {
  try {
    const { userId } = req.params;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    user.isCreator = true;
    await user.save();

    await createSystemNotification(
      userId,
      'Creator Monetization Granted',
      'Congratulations! Creator monetization has been enabled for your account. You can now add bank details and start earning.',
      { type: 'monetization_granted' }
    );

    res.json({ success: true, message: 'Monetization granted successfully' });
  } catch (error) {
    log.error('Grant monetization error:', { error: String(error) });
    res.status(500).json({ success: false, message: 'Failed to grant monetization' });
  }
};

// Task 5.4: Set and get per-creator CPM
const setCreatorCpm = async (req, res) => {
  try {
    const { userId } = req.params;
    const { cpm } = req.body;

    if (!cpm || typeof cpm !== 'number' || cpm <= 0) {
      return res.status(400).json({ success: false, message: 'CPM must be a positive number' });
    }

    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    user.creatorCpm = cpm;
    await user.save();

    res.json({ success: true, message: 'CPM updated successfully', data: { userId, cpm } });
  } catch (error) {
    log.error('Set creator CPM error:', { error: String(error) });
    res.status(500).json({ success: false, message: 'Failed to set CPM' });
  }
};

const getCreatorCpm = async (req, res) => {
  try {
    const { userId } = req.params;
    const user = await User.findById(userId).select('creatorCpm').lean();
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const isDefault = user.creatorCpm == null || user.creatorCpm <= 0;
    res.json({
      success: true,
      data: {
        cpm: isDefault ? PLATFORM_DEFAULT_CPM : user.creatorCpm,
        isDefault,
        platformDefault: PLATFORM_DEFAULT_CPM
      }
    });
  } catch (error) {
    log.error('Get creator CPM error:', { error: String(error) });
    res.status(500).json({ success: false, message: 'Failed to get CPM' });
  }
};

// Task 5.5: List withdrawal requests (admin)
const listWithdrawalRequests = async (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const query = {};
    if (status && status !== 'all') query.status = status;

    const requests = await WithdrawalRequest.find(query)
      .populate('user', 'username profile.displayName profile.avatar')
      .populate('payoutCycle', 'cycleLabel periodType endDate')
      .sort({ requestedAt: -1 })
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit))
      .lean();

    // Enrich with bank details
    const enriched = await Promise.all(requests.map(async (r) => {
      const bank = await CreatorBankDetails.findOne({ user: r.user._id })
        .select('accountHolderName bankName lastFourDigits ifsc verificationStatus')
        .lean();
      return { ...r, bankDetails: bank || null };
    }));

    const total = await WithdrawalRequest.countDocuments(query);

    res.json({
      success: true,
      data: {
        requests: enriched,
        total,
        page: parseInt(page),
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    log.error('List withdrawal requests error:', { error: String(error) });
    res.status(500).json({ success: false, message: 'Failed to fetch withdrawal requests' });
  }
};

// Task 5.6: Approve and reject withdrawal requests
const approveWithdrawalRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const { bankReference } = req.body || {};
    const adminId = req.user._id;

    const request = await WithdrawalRequest.findById(id);
    if (!request) return res.status(404).json({ success: false, message: 'Withdrawal request not found' });
    if (request.status !== 'pending') return res.status(400).json({ success: false, message: 'Request is not pending' });

    request.status = 'approved';
    request.bankReference = bankReference || '';
    request.paidAt = new Date();
    request.reviewedBy = adminId;
    await request.save();

    await createSystemNotification(
      request.user,
      'Withdrawal Request Approved',
      `Your withdrawal request has been approved${bankReference ? ` (Reference: ${bankReference})` : ''}. The amount will be credited to your bank account.`,
      { type: 'withdrawal_approved', requestId: request._id }
    );

    res.json({ success: true, message: 'Withdrawal request approved', data: { _id: request._id, status: request.status } });
  } catch (error) {
    log.error('Approve withdrawal error:', { error: String(error) });
    res.status(500).json({ success: false, message: 'Failed to approve withdrawal request' });
  }
};

const rejectWithdrawalRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const { rejectionReason } = req.body || {};
    const adminId = req.user._id;

    if (!rejectionReason) return res.status(400).json({ success: false, message: 'rejectionReason is required' });

    const request = await WithdrawalRequest.findById(id);
    if (!request) return res.status(404).json({ success: false, message: 'Withdrawal request not found' });
    if (request.status !== 'pending') return res.status(400).json({ success: false, message: 'Request is not pending' });

    request.status = 'rejected';
    request.rejectionReason = rejectionReason;
    request.reviewedBy = adminId;
    await request.save();

    await createSystemNotification(
      request.user,
      'Withdrawal Request Rejected',
      `Your withdrawal request has been rejected. Reason: ${rejectionReason}`,
      { type: 'withdrawal_rejected', requestId: request._id }
    );

    res.json({ success: true, message: 'Withdrawal request rejected', data: { _id: request._id, status: request.status } });
  } catch (error) {
    log.error('Reject withdrawal error:', { error: String(error) });
    res.status(500).json({ success: false, message: 'Failed to reject withdrawal request' });
  }
};

// Task 5.1: Get host verification applications
const getHostVerificationApplications = async (req, res) => {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const query = {};
    
    // Status filter
    if (status && status !== 'all') {
      query.status = status;
    }

    const applications = await HostVerificationApplication.find(query)
      .populate('user', 'username profile.displayName profile.avatar email')
      .populate('reviewedBy', 'username')
      .sort({ appliedAt: -1 })
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit))
      .lean();

    const total = await HostVerificationApplication.countDocuments(query);

    res.json({
      success: true,
      data: {
        applications,
        pagination: {
          total,
          pages: Math.ceil(total / parseInt(limit)),
          current: parseInt(page),
          limit: parseInt(limit)
        }
      }
    });
  } catch (error) {
    log.error('Get host verification applications error:', { error: String(error) });
    res.status(500).json({ 
      success: false, 
      message: 'Failed to fetch host verification applications',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined 
    });
  }
};

// Task 5.2: Approve host verification application
const approveHostVerificationApplication = async (req, res) => {
  try {
    const { id } = req.params;
    const adminId = req.user._id;

    // Find application by ID
    const application = await HostVerificationApplication.findById(id);
    if (!application) {
      return res.status(404).json({
        success: false,
        message: 'Application not found'
      });
    }

    // Check if application is pending
    if (application.status !== 'pending') {
      return res.status(400).json({
        success: false,
        message: 'Application is not pending'
      });
    }

    // Update application status
    application.status = 'approved';
    application.reviewedAt = new Date();
    application.reviewedBy = adminId;
    await application.save();

    // Set user.isVerifiedHost = true
    await User.findByIdAndUpdate(application.user, { isVerifiedHost: true });

    // Send system notification with approval message from Requirement 6.6
    await createSystemNotification(
      application.user,
      'Verified Host Application Approved',
      'Congratulations! Your Verified Host application has been approved. You can now host prize pool tournaments and scrims.'
    );

    res.json({
      success: true,
      message: 'Application approved successfully',
      data: {
        application: {
          _id: application._id,
          status: application.status,
          reviewedAt: application.reviewedAt,
          reviewedBy: application.reviewedBy
        }
      }
    });
  } catch (error) {
    log.error('Approve host verification application error:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to approve application',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Task 5.3: Reject host verification application
const rejectHostVerificationApplication = async (req, res) => {
  try {
    const { id } = req.params;
    const { rejectionReason } = req.body || {};
    const adminId = req.user._id;

    // Find application by ID
    const application = await HostVerificationApplication.findById(id);
    if (!application) {
      return res.status(404).json({
        success: false,
        message: 'Application not found'
      });
    }

    // Check if application is pending
    if (application.status !== 'pending') {
      return res.status(400).json({
        success: false,
        message: 'Application is not pending'
      });
    }

    // Update application status
    application.status = 'rejected';
    application.reviewedAt = new Date();
    application.reviewedBy = adminId;
    application.rejectionReason = rejectionReason || '';
    await application.save();

    // Do NOT change user.isVerifiedHost (as specified in task details)

    // Send system notification with rejection message from Requirement 6.7
    const notificationMessage = 'Your Verified Host application has been reviewed. Unfortunately, it was not approved at this time.' + 
      (rejectionReason ? ` ${rejectionReason}` : '');
    
    await createSystemNotification(
      application.user,
      'Verified Host Application Rejected',
      notificationMessage
    );

    res.json({
      success: true,
      message: 'Application rejected successfully',
      data: {
        application: {
          _id: application._id,
          status: application.status,
          reviewedAt: application.reviewedAt,
          reviewedBy: application.reviewedBy,
          rejectionReason: application.rejectionReason
        }
      }
    });
  } catch (error) {
    log.error('Reject host verification application error:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to reject application',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get all verified hosts
const getVerifiedHosts = async (req, res) => {
  try {
    const { page = 1, limit = 20, search } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);

    const query = { isVerifiedHost: true };
    if (search) {
      query.$or = [
        { username: { $regex: search, $options: 'i' } },
        { 'profile.displayName': { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } }
      ];
    }

    const users = await User.find(query)
      .select('username email profile.displayName profile.avatar isVerifiedHost createdAt')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    const total = await User.countDocuments(query);

    res.json({
      success: true,
      data: {
        hosts: users,
        pagination: {
          total,
          page: parseInt(page),
          pages: Math.ceil(total / parseInt(limit))
        }
      }
    });
  } catch (err) {
    log.error('getVerifiedHosts error:', { error: String(err) });
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

// Revoke host verification for a user
const revokeHostVerification = async (req, res) => {
  try {
    const { userId } = req.params;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    if (!user.isVerifiedHost) {
      return res.status(400).json({ success: false, message: 'User is not a verified host' });
    }

    // Revoke verification
    await User.findByIdAndUpdate(userId, { isVerifiedHost: false });

    // Also update their approved application status back to pending (optional — mark as revoked)
    await HostVerificationApplication.findOneAndUpdate(
      { user: userId, status: 'approved' },
      { status: 'rejected', rejectionReason: 'Verification revoked by admin', reviewedAt: new Date(), reviewedBy: req.user._id }
    );

    res.json({
      success: true,
      message: `Host verification revoked for @${user.username}`
    });
  } catch (err) {
    log.error('revokeHostVerification error:', { error: String(err) });
    res.status(500).json({ success: false, message: 'Server error' });
  }
};

const getAuditLogs = async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = normalizeLimit(req.query.limit, 25, 100);
    const { action, actor, resourceType, statusCode } = req.query;
    const query = {};

    if (action) query.action = { $regex: String(action), $options: 'i' };
    if (actor) query['actor.username'] = { $regex: String(actor), $options: 'i' };
    if (resourceType && resourceType !== 'all') query.resourceType = resourceType;
    if (statusCode) query.statusCode = parseInt(statusCode, 10);

    const [logs, total] = await Promise.all([
      AdminAuditLog.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      AdminAuditLog.countDocuments(query)
    ]);

    res.json({
      success: true,
      data: {
        logs,
        pagination: {
          current: page,
          pages: Math.ceil(total / limit),
          total
        }
      }
    });
  } catch (error) {
    log.error('Get audit logs error:', { error: String(error) });
    res.status(500).json({ success: false, message: 'Failed to fetch audit logs' });
  }
};

const globalSearch = async (req, res) => {
  try {
    const query = String(req.query.q || '').trim();
    const limit = normalizeLimit(req.query.limit, 8, 20);

    if (query.length < 2) {
      return res.json({ success: true, data: { query, results: {} } });
    }

    const text = { $regex: query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
    const objectId = mongoose.Types.ObjectId.isValid(query) ? new mongoose.Types.ObjectId(query) : null;

    const [
      users,
      teams,
      posts,
      clips,
      stories,
      reports,
      boosts,
      payments,
      hosts,
      recruitments,
      tournaments
    ] = await Promise.all([
      User.find({ $or: [{ username: text }, { email: text }, { 'profile.displayName': text }, ...(objectId ? [{ _id: objectId }] : [])] })
        .select('username email profile.displayName profile.avatar userType isActive isPremium isCreator isVerifiedHost createdAt')
        .limit(limit)
        .lean(),
      User.find({ userType: 'team', $or: [{ username: text }, { email: text }, { 'profile.displayName': text }, ...(objectId ? [{ _id: objectId }] : [])] })
        .select('username email profile.displayName profile.avatar isActive isVerifiedHost createdAt')
        .limit(limit)
        .lean(),
      Post.find({ $or: [{ 'content.text': text }, { tags: text }, ...(objectId ? [{ _id: objectId }] : [])] })
        .select('content.text postType author createdAt isActive hiddenByAdmin metrics views')
        .populate('author', 'username profile.displayName')
        .limit(limit)
        .lean(),
      Post.find({ 'content.media.type': 'video', $or: [{ 'content.text': text }, { tags: text }, ...(objectId ? [{ _id: objectId }] : [])] })
        .select('content.text author createdAt metrics views')
        .populate('author', 'username profile.displayName')
        .limit(limit)
        .lean(),
      objectId
        ? Story.find({ $or: [{ _id: objectId }, { author: objectId }] })
          .select('author media.type createdAt')
          .populate('author', 'username profile.displayName')
          .limit(limit)
          .lean()
        : Promise.resolve([]),
      Report.find({ $or: [{ reason: text }, { details: text }, { targetType: text }, ...(objectId ? [{ _id: objectId }, { targetId: query }] : [])] })
        .select('targetType targetId reason status createdAt reporter')
        .populate('reporter', 'username profile.displayName')
        .limit(limit)
        .lean(),
      BoostCampaign.find({ $or: [{ status: text }, ...(objectId ? [{ _id: objectId }, { user: objectId }, { post: objectId }] : [])] })
        .populate('user', 'username profile.displayName')
        .populate('post', 'content.text')
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean(),
      PaymentTransaction.find({ $or: [{ type: text }, { status: text }, { paymentId: text }, { orderId: text }, ...(objectId ? [{ _id: objectId }, { user: objectId }] : [])] })
        .populate('user', 'username profile.displayName')
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean(),
      HostVerificationApplication.find({ $or: [{ fullName: text }, { contactNumber: text }, { status: text }, ...(objectId ? [{ _id: objectId }, { user: objectId }] : [])] })
        .populate('user', 'username profile.displayName email')
        .sort({ appliedAt: -1 })
        .limit(limit)
        .lean(),
      TeamRecruitment.find({ $or: [{ recruitmentCode: text }, { game: text }, { role: text }, { staffRole: text }, ...(objectId ? [{ _id: objectId }, { team: objectId }] : [])] })
        .populate('team', 'username profile.displayName')
        .limit(limit)
        .lean(),
      Tournament.find({ $or: [{ name: text }, { game: text }, { status: text }, ...(objectId ? [{ _id: objectId }, { host: objectId }] : [])] })
        .select('name game status host startDate endDate createdAt')
        .populate('host', 'username profile.displayName')
        .limit(limit)
        .lean()
    ]);

    res.json({
      success: true,
      data: {
        query,
        results: { users, teams, posts, clips, stories, reports, boosts, payments, hosts, recruitments, tournaments }
      }
    });
  } catch (error) {
    log.error('Admin global search error:', { error: String(error) });
    res.status(500).json({ success: false, message: 'Search failed' });
  }
};

const getUserInspection = async (req, res) => {
  try {
    const { userId } = req.params;
    const user = await User.findById(userId).select('-password').lean();
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    const [
      posts,
      clips,
      stories,
      recruitments,
      tournaments,
      payments,
      boosts,
      reports,
      warnings,
      monetizationApplication
    ] = await Promise.all([
      Post.countDocuments({ author: userId }),
      Post.countDocuments({ author: userId, 'content.media.type': 'video' }),
      Story.countDocuments({ author: userId }),
      TeamRecruitment.countDocuments({ team: userId }),
      Tournament.countDocuments({ host: userId }),
      PaymentTransaction.find({ user: userId }).sort({ createdAt: -1 }).limit(20).lean(),
      BoostCampaign.find({ user: userId }).sort({ createdAt: -1 }).limit(20).lean(),
      Report.find({ $or: [{ targetType: 'user', targetId: userId }] }).sort({ createdAt: -1 }).limit(20).lean(),
      Promise.resolve(user.adminWarnings || []),
      MonetizationApplication.findOne({ user: userId }).sort({ appliedAt: -1 }).lean()
    ]);

    res.json({
      success: true,
      data: {
        user,
        stats: {
          followers: Array.isArray(user.followers) ? user.followers.length : 0,
          following: Array.isArray(user.following) ? user.following.length : 0,
          posts,
          clips,
          stories,
          recruitments,
          tournaments
        },
        payments,
        boosts,
        reports,
        warnings,
        monetizationApplication
      }
    });
  } catch (error) {
    log.error('Get user inspection error:', { error: String(error) });
    res.status(500).json({ success: false, message: 'Failed to inspect user' });
  }
};

const updateUserControls = async (req, res) => {
  try {
    const { userId } = req.params;
    const allowedControls = [
      'loginDisabled',
      'postingDisabled',
      'messagingDisabled',
      'callsDisabled',
      'storiesDisabled',
      'clipsDisabled',
      'commentsDisabled',
      'liveFeaturesDisabled'
    ];
    const updates = {};
    allowedControls.forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(req.body || {}, key)) {
        updates[`adminControls.${key}`] = Boolean(req.body[key]);
      }
    });
    if (req.body?.reason != null) updates['adminControls.reason'] = String(req.body.reason).slice(0, 500);
    updates['adminControls.updatedAt'] = new Date();
    updates['adminControls.updatedBy'] = req.user?._id || null;

    const user = await User.findByIdAndUpdate(userId, { $set: updates }, { new: true }).select('-password');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    res.locals.auditAfter = { userId, adminControls: user.adminControls };
    res.json({ success: true, message: 'User controls updated', data: user });
  } catch (error) {
    log.error('Update user controls error:', { error: String(error) });
    res.status(500).json({ success: false, message: 'Failed to update user controls' });
  }
};

const grantPremium = async (req, res) => {
  try {
    const { userId } = req.params;
    const { tier = 'player_pro', days = 30 } = req.body || {};
    const validDays = Math.min(3650, Math.max(1, parseInt(days, 10) || 30));
    const validUntil = new Date(Date.now() + (validDays * dayMs));
    const user = await User.findByIdAndUpdate(
      userId,
      {
        $set: {
          isPremium: true,
          'membership.tier': tier,
          'membership.validUntil': validUntil
        }
      },
      { new: true }
    ).select('-password');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    await createSystemNotification(userId, 'Premium Granted', `Premium access has been enabled until ${validUntil.toDateString()}.`, { type: 'premium_granted' });
    res.json({ success: true, message: 'Premium granted', data: user });
  } catch (error) {
    log.error('Grant premium error:', { error: String(error) });
    res.status(500).json({ success: false, message: 'Failed to grant premium' });
  }
};

const removePremium = async (req, res) => {
  try {
    const { userId } = req.params;
    const user = await User.findByIdAndUpdate(
      userId,
      {
        $set: {
          isPremium: false,
          'membership.tier': 'free',
          'membership.validUntil': null
        }
      },
      { new: true }
    ).select('-password');
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    await createSystemNotification(userId, 'Premium Removed', 'Premium access has been removed by the platform.', { type: 'premium_removed' });
    res.json({ success: true, message: 'Premium removed', data: user });
  } catch (error) {
    log.error('Remove premium error:', { error: String(error) });
    res.status(500).json({ success: false, message: 'Failed to remove premium' });
  }
};

const getBoostCampaigns = async (req, res) => {
  try {
    const page = parseInt(req.query.page, 10) || 1;
    const limit = normalizeLimit(req.query.limit, 20, 100);
    const { status, userId, postId } = req.query;
    const query = {};
    if (status && status !== 'all') query.status = status;
    if (userId && mongoose.Types.ObjectId.isValid(userId)) query.user = userId;
    if (postId && mongoose.Types.ObjectId.isValid(postId)) query.post = postId;

    await processDueManualBoostDeliveries({ limit: 100 });

    const [campaigns, total] = await Promise.all([
      BoostCampaign.find(query)
        .populate('user', 'username profile.displayName profile.avatar email')
        .populate('post', 'content.text content.media metrics views postType boostMeta')
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      BoostCampaign.countDocuments(query)
    ]);

    res.json({
      success: true,
      data: {
        campaigns,
        pagination: {
          current: page,
          pages: Math.ceil(total / limit),
          total
        }
      }
    });
  } catch (error) {
    log.error('Get boost campaigns error:', { error: String(error) });
    res.status(500).json({ success: false, message: 'Failed to fetch boost campaigns' });
  }
};

const configureBoostDelivery = async (req, res) => {
  try {
    const { campaignId } = req.params;
    const {
      durationHours,
      durationMinutes,
      targetViews,
      totalReach,
      startImmediately = true,
      scheduledStartAt,
      reason = ''
    } = req.body || {};
    const duration = normalizeDurationMinutes({ durationMinutes, durationHours, fallback: 360 });
    const campaign = await BoostCampaign.findById(campaignId);
    if (!campaign) return res.status(404).json({ success: false, message: 'Boost campaign not found' });
    if (campaign.status === 'cancelled' || campaign.status === 'rejected') {
      return res.status(400).json({ success: false, message: `Cannot deliver a ${campaign.status} campaign` });
    }

    const before = campaign.toObject();
    const purchased = Number(campaign.purchasedReach) || Number(campaign.estimatedReach) || Number(targetViews) || Number(totalReach) || 0;
    const requestedTarget = Number(totalReach || targetViews) || purchased;
    const deliveredViews = Math.max(0, Number(campaign.manualDelivery?.deliveredViews || 0));
    const target = Math.max(deliveredViews, Math.min(Math.max(1, requestedTarget), Math.max(purchased, requestedTarget)));
    const now = new Date();
    const scheduled = startImmediately
      ? now
      : (scheduledStartAt ? new Date(scheduledStartAt) : now);
    if (!startImmediately && (!Number.isFinite(scheduled.getTime()) || scheduled.getTime() < now.getTime() - 60000)) {
      return res.status(400).json({ success: false, message: 'Scheduled start time must be in the future' });
    }
    const endsAt = new Date(scheduled.getTime() + (duration * 60 * 1000));
    const nextStatus = scheduled.getTime() > now.getTime() ? 'scheduled' : 'running';
    const remainingViews = Math.max(0, target - deliveredViews);
    const deliveryPercent = target > 0 ? Math.min(100, Math.round((deliveredViews / target) * 10000) / 100) : 0;
    const actor = getAdminActor(req);

    campaign.deliveryMode = 'manual';
    campaign.status = nextStatus === 'scheduled' ? 'running' : 'running';
    campaign.startTime = nextStatus === 'running' ? (campaign.startTime || now) : campaign.startTime;
    campaign.endTime = endsAt;
    campaign.remainingReach = remainingViews;
    campaign.manualDelivery = {
      ...(campaign.manualDelivery?.toObject ? campaign.manualDelivery.toObject() : campaign.manualDelivery || {}),
      enabled: true,
      status: nextStatus,
      durationHours: Math.round((duration / 60) * 100) / 100,
      durationMinutes: duration,
      scheduledStartAt: scheduled,
      startedAt: nextStatus === 'running' ? (campaign.manualDelivery?.startedAt || now) : null,
      endsAt,
      actualCompletedAt: null,
      pausedAt: null,
      lastAppliedAt: now,
      lastDeliveryBucket: undefined,
      deliveredViews,
      targetViews: target,
      remainingViews,
      deliveryPercent,
      deliverySpeedPerHour: 0,
      estimatedCompletionAt: endsAt,
      timeline: [
        ...(campaign.manualDelivery?.timeline || []),
        buildDeliveryTimelineEntry(nextStatus === 'scheduled' ? 'scheduled' : 'configured', {
          campaign,
          reason,
          message: nextStatus === 'scheduled' ? 'Manual delivery scheduled.' : 'Manual delivery configured.',
          previousValue: {
            targetViews: before.manualDelivery?.targetViews,
            durationMinutes: before.manualDelivery?.durationMinutes,
            scheduledStartAt: before.manualDelivery?.scheduledStartAt,
            status: before.manualDelivery?.status
          },
          newValue: { targetViews: target, durationMinutes: duration, scheduledStartAt: scheduled, status: nextStatus },
          actor
        })
      ].slice(-200)
    };
    await campaign.save();

    await Post.findByIdAndUpdate(campaign.post, {
      boostedAt: nextStatus === 'running' ? now : campaign.boostedAt,
      boostExpiresAt: endsAt,
      boostMeta: {
        activeCampaign: campaign._id,
        status: nextStatus,
        budget: campaign.budget,
        estimatedReach: campaign.estimatedReach,
        purchasedReach: campaign.purchasedReach,
        remainingReach: remainingViews,
        dailySpend: campaign.dailySpend,
        totalSpend: campaign.totalSpend,
        startTime: nextStatus === 'running' ? (campaign.startTime || now) : scheduled,
        endTime: endsAt,
        targetAudience: campaign.targetAudience
      }
    });

    res.locals.auditBefore = before;
    res.locals.auditAfter = campaign.toObject();

    res.json({
      success: true,
      message: 'Manual boost delivery configured',
      data: { campaign }
    });
  } catch (error) {
    log.error('Configure boost delivery error:', { error: String(error) });
    res.status(500).json({ success: false, message: 'Failed to configure boost delivery' });
  }
};

const updateBoostCampaignStatus = async (req, res) => {
  try {
    const { campaignId } = req.params;
    const { status } = req.body || {};
    if (!['running', 'paused', 'completed', 'cancelled', 'rejected'].includes(status)) {
      return res.status(400).json({ success: false, message: 'Invalid campaign status' });
    }

    const campaign = await BoostCampaign.findById(campaignId);
    if (!campaign) return res.status(404).json({ success: false, message: 'Boost campaign not found' });

    await applyManualDeliveryProgress(campaign);
    const updated = await BoostCampaign.findByIdAndUpdate(
      campaignId,
      {
        $set: {
          status,
          'manualDelivery.lastAppliedAt': new Date()
        }
      },
      { new: true }
    );

    await Post.updateOne(
      { _id: campaign.post, 'boostMeta.activeCampaign': campaign._id },
      {
        $set: {
          'boostMeta.status': status,
          'boostMeta.remainingReach': status === 'completed' || status === 'cancelled' || status === 'rejected' ? 0 : updated.remainingReach
        }
      }
    );

    res.json({ success: true, message: 'Boost campaign updated', data: { campaign: updated } });
  } catch (error) {
    log.error('Update boost campaign status error:', { error: String(error) });
    res.status(500).json({ success: false, message: 'Failed to update boost campaign' });
  }
};

const controlBoostDelivery = async (req, res) => {
  try {
    const { campaignId } = req.params;
    const { action, reason = '', durationMinutes, durationHours } = req.body || {};
    const allowed = ['pause', 'resume', 'stop', 'restart', 'cancel', 'complete'];
    if (!allowed.includes(action)) {
      return res.status(400).json({ success: false, message: 'Invalid delivery action' });
    }

    let campaign = await BoostCampaign.findById(campaignId);
    if (!campaign) return res.status(404).json({ success: false, message: 'Boost campaign not found' });
    campaign = await processSingleManualBoostCampaign(campaign, { actor: getAdminActor(req) });
    campaign = await BoostCampaign.findById(campaignId);
    if (!campaign) return res.status(404).json({ success: false, message: 'Boost campaign not found' });

    const before = campaign.toObject();
    const now = new Date();
    const actor = getAdminActor(req);
    const update = { $set: {}, $push: { 'manualDelivery.timeline': { $each: [], $slice: -200 } } };
    const remainingViews = Math.max(0, Number(campaign.manualDelivery?.remainingViews ?? campaign.remainingReach ?? 0));
    const deliveredViews = Math.max(0, Number(campaign.manualDelivery?.deliveredViews || 0));
    const targetViews = Math.max(deliveredViews, Number(campaign.manualDelivery?.targetViews || campaign.purchasedReach || deliveredViews));

    if (action === 'pause') {
      if (!['running', 'scheduled'].includes(campaign.manualDelivery?.status)) {
        return res.status(400).json({ success: false, message: 'Only running or scheduled delivery can be paused' });
      }
      update.$set.status = 'paused';
      update.$set['manualDelivery.status'] = 'paused';
      update.$set['manualDelivery.pausedAt'] = now;
      update.$set['manualDelivery.lastAppliedAt'] = now;
      update.$push['manualDelivery.timeline'].$each.push(buildDeliveryTimelineEntry('paused', { campaign, reason, message: 'Delivery paused.', actor }));
    } else if (action === 'resume') {
      if (campaign.manualDelivery?.status !== 'paused') {
        return res.status(400).json({ success: false, message: 'Only paused delivery can be resumed' });
      }
      const pausedAt = campaign.manualDelivery?.pausedAt ? new Date(campaign.manualDelivery.pausedAt).getTime() : now.getTime();
      const pausedMs = Math.max(0, now.getTime() - pausedAt);
      const previousEnd = campaign.manualDelivery?.endsAt ? new Date(campaign.manualDelivery.endsAt) : now;
      const nextEnd = new Date(previousEnd.getTime() + pausedMs);
      update.$set.status = 'running';
      update.$set['manualDelivery.status'] = 'running';
      update.$set['manualDelivery.pausedAt'] = null;
      update.$set['manualDelivery.pausedAccumulatedMs'] = Number(campaign.manualDelivery?.pausedAccumulatedMs || 0) + pausedMs;
      update.$set['manualDelivery.endsAt'] = nextEnd;
      update.$set['manualDelivery.estimatedCompletionAt'] = nextEnd;
      update.$set.endTime = nextEnd;
      update.$push['manualDelivery.timeline'].$each.push(buildDeliveryTimelineEntry('resumed', { campaign, reason, message: 'Delivery resumed.', previousValue: { endsAt: previousEnd }, newValue: { endsAt: nextEnd }, actor }));
    } else if (action === 'stop') {
      update.$set.status = 'paused';
      update.$set['manualDelivery.status'] = 'stopped';
      update.$set['manualDelivery.lastAppliedAt'] = now;
      update.$push['manualDelivery.timeline'].$each.push(buildDeliveryTimelineEntry('stopped', { campaign, reason, message: 'Delivery stopped by admin.', actor }));
    } else if (action === 'cancel') {
      update.$set.status = 'cancelled';
      update.$set.remainingReach = 0;
      update.$set['manualDelivery.status'] = 'cancelled';
      update.$set['manualDelivery.remainingViews'] = 0;
      update.$set['manualDelivery.actualCompletedAt'] = now;
      update.$push['manualDelivery.timeline'].$each.push(buildDeliveryTimelineEntry('cancelled', { campaign, reason, message: 'Delivery cancelled by admin.', actor }));
    } else if (action === 'complete') {
      const delta = remainingViews;
      update.$set.status = 'completed';
      update.$set.remainingReach = 0;
      update.$set['manualDelivery.status'] = 'completed';
      update.$set['manualDelivery.deliveredViews'] = targetViews;
      update.$set['manualDelivery.remainingViews'] = 0;
      update.$set['manualDelivery.deliveryPercent'] = 100;
      update.$set['manualDelivery.actualCompletedAt'] = now;
      update.$set['analytics.boostViews'] = targetViews;
      update.$set['analytics.boostReach'] = Math.max(Number(campaign.analytics?.boostReach || 0), targetViews);
      update.$push['manualDelivery.timeline'].$each.push(buildDeliveryTimelineEntry('completed', { campaign, reason, views: delta, message: 'Delivery completed early by admin.', newValue: { deliveredViews: targetViews }, actor }));
      if (delta > 0) {
        await Post.updateOne(
          { _id: campaign.post },
          {
            $inc: { views: delta, 'metrics.boostViews': delta, 'metrics.boostReach': delta },
            $set: { 'boostMeta.remainingReach': 0, 'boostMeta.status': 'completed' }
          }
        );
      }
    } else if (action === 'restart') {
      const duration = normalizeDurationMinutes({ durationMinutes, durationHours, fallback: campaign.manualDelivery?.durationMinutes || 360 });
      const endsAt = new Date(now.getTime() + (duration * 60000));
      update.$set.status = 'running';
      update.$set.remainingReach = remainingViews;
      update.$set.startTime = now;
      update.$set.endTime = endsAt;
      update.$set['manualDelivery.status'] = 'running';
      update.$set['manualDelivery.scheduledStartAt'] = now;
      update.$set['manualDelivery.startedAt'] = now;
      update.$set['manualDelivery.endsAt'] = endsAt;
      update.$set['manualDelivery.durationMinutes'] = duration;
      update.$set['manualDelivery.durationHours'] = Math.round((duration / 60) * 100) / 100;
      update.$set['manualDelivery.lastDeliveryBucket'] = null;
      update.$set['manualDelivery.actualCompletedAt'] = null;
      update.$set['manualDelivery.estimatedCompletionAt'] = endsAt;
      update.$push['manualDelivery.timeline'].$each.push(buildDeliveryTimelineEntry('restarted', { campaign, reason, message: 'Delivery restarted by admin.', newValue: { durationMinutes: duration, endsAt }, actor }));
    }

    const updated = await BoostCampaign.findByIdAndUpdate(campaignId, update, { new: true });
    await Post.updateOne(
      { _id: campaign.post, 'boostMeta.activeCampaign': campaign._id },
      {
        $set: {
          'boostMeta.status': updated.manualDelivery?.status || updated.status,
          'boostMeta.remainingReach': updated.remainingReach,
          'boostMeta.endTime': updated.endTime,
          boostExpiresAt: updated.endTime
        }
      }
    );

    res.locals.auditBefore = before;
    res.locals.auditAfter = updated.toObject();
    res.json({ success: true, message: 'Boost delivery updated', data: { campaign: updated } });
  } catch (error) {
    log.error('Control boost delivery error:', { error: String(error) });
    res.status(500).json({ success: false, message: 'Failed to update boost delivery' });
  }
};

const adjustBoostDelivery = async (req, res) => {
  try {
    const { campaignId } = req.params;
    const { remainingDelta = 0, targetReach, durationDeltaMinutes = 0, reason = '' } = req.body || {};
    let campaign = await BoostCampaign.findById(campaignId);
    if (!campaign) return res.status(404).json({ success: false, message: 'Boost campaign not found' });
    campaign = await processSingleManualBoostCampaign(campaign, { actor: getAdminActor(req) });
    campaign = await BoostCampaign.findById(campaignId);
    if (!campaign) return res.status(404).json({ success: false, message: 'Boost campaign not found' });

    const before = campaign.toObject();
    const deliveredViews = Math.max(0, Number(campaign.manualDelivery?.deliveredViews || 0));
    const currentTarget = Math.max(deliveredViews, Number(campaign.manualDelivery?.targetViews || campaign.purchasedReach || deliveredViews));
    const explicitTarget = Number(targetReach);
    const nextTarget = Number.isFinite(explicitTarget) && explicitTarget > 0
      ? Math.max(deliveredViews, Math.floor(explicitTarget))
      : Math.max(deliveredViews, currentTarget + Math.floor(Number(remainingDelta) || 0));
    const nextRemaining = Math.max(0, nextTarget - deliveredViews);
    const progress = nextTarget > 0 ? Math.min(100, Math.round((deliveredViews / nextTarget) * 10000) / 100) : 0;
    const durationDelta = Math.floor(Number(durationDeltaMinutes) || 0);
    const currentEndsAt = campaign.manualDelivery?.endsAt ? new Date(campaign.manualDelivery.endsAt) : (campaign.endTime || new Date());
    const nextEndsAt = durationDelta ? new Date(currentEndsAt.getTime() + (durationDelta * 60000)) : currentEndsAt;

    const update = {
      $set: {
        remainingReach: nextRemaining,
        endTime: nextEndsAt,
        'manualDelivery.targetViews': nextTarget,
        'manualDelivery.remainingViews': nextRemaining,
        'manualDelivery.deliveryPercent': progress,
        'manualDelivery.endsAt': nextEndsAt,
        'manualDelivery.estimatedCompletionAt': nextEndsAt,
        'manualDelivery.lastDeliveryBucket': null
      },
      $push: {
        'manualDelivery.timeline': {
          $each: [
            buildDeliveryTimelineEntry('adjusted', {
              campaign,
              reason,
              message: 'Delivery configuration adjusted by admin.',
              previousValue: { targetViews: currentTarget, remainingViews: currentTarget - deliveredViews, endsAt: currentEndsAt },
              newValue: { targetViews: nextTarget, remainingViews: nextRemaining, endsAt: nextEndsAt },
              actor: getAdminActor(req)
            })
          ],
          $slice: -200
        }
      }
    };

    const updated = await BoostCampaign.findByIdAndUpdate(campaignId, update, { new: true });
    await Post.updateOne(
      { _id: campaign.post, 'boostMeta.activeCampaign': campaign._id },
      {
        $set: {
          'boostMeta.remainingReach': nextRemaining,
          'boostMeta.endTime': nextEndsAt,
          boostExpiresAt: nextEndsAt
        }
      }
    );

    res.locals.auditBefore = before;
    res.locals.auditAfter = updated.toObject();
    res.json({ success: true, message: 'Boost delivery adjusted', data: { campaign: updated } });
  } catch (error) {
    log.error('Adjust boost delivery error:', { error: String(error) });
    res.status(500).json({ success: false, message: 'Failed to adjust boost delivery' });
  }
};

module.exports = {
  getDashboardStats,
  getUserAnalytics,
  getSystemHealth,
  getRecentActivities,
  getUsers,
  updateUserStatus,
  deleteUser,
  getPosts,
  deletePost,
  getTournaments,
  deleteTournament,
  resetUserPassword,
  getReports,
  updateReport,
  getMonetizationApplications,
  approveMonetizationApplication,
  rejectMonetizationApplication,
  holdCreatorPayout,
  getApprovedCreators,
  revokeMonetization,
  grantMonetization,
  setCreatorCpm,
  getCreatorCpm,
  listWithdrawalRequests,
  approveWithdrawalRequest,
  rejectWithdrawalRequest,
  getHostVerificationApplications,
  approveHostVerificationApplication,
  rejectHostVerificationApplication,
  getVerifiedHosts,
  revokeHostVerification,
  getAuditLogs,
  globalSearch,
  getUserInspection,
  updateUserControls,
  grantPremium,
  removePremium,
  getBoostCampaigns,
  configureBoostDelivery,
  controlBoostDelivery,
  adjustBoostDelivery,
  updateBoostCampaignStatus
};
