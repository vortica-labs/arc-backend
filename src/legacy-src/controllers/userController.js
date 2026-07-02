const User = require('../models/User');
const Post = require('../models/Post');
const Tournament = require('../models/Tournament');
const Follow = require('../models/Follow');
const FollowRequest = require('../models/FollowRequest');
const { createFollowNotification, createMessageNotification } = require('../utils/notificationService');
const RosterInvite = require('../models/RosterInvite');
const StaffInvite = require('../models/StaffInvite');
const LeaveRequest = require('../models/LeaveRequest');
const { createAndEmitNotification } = require('../utils/notificationEmitter');
const { formatUserDTO, formatPostDTO } = require('../utils/dto');
const { getJson, setJson } = require('../utils/redisCache');
const { profileCacheKey, invalidateProfileCache } = require('../utils/profileCache');
const { publishPrivacySettingsUpdate, evictPresenceAudience, removePresenceSubscription } = require('../utils/presencePrivacy');
const { invalidateUserCache } = require('../middleware/auth');
const log = require('../utils/logger');
const { normalizeQuerySearch, buildPrefixRegex } = require('../utils/searchQuery');
const {
  PROFILE_VISIBILITY,
  MESSAGE_AUDIENCE,
  normalizePrivacySettings,
  canonicalToLegacyAliases,
  buildPrivacyAccess,
  resolvePrivacyAccess,
  minimalProfile,
  privacySettingsResponse
} = require('../utils/privacyPolicy');

// ── Redis Profile Cache helpers ──
const PROFILE_CACHE_TTL = 300; // 5 minutes
const TEAM_CACHE_TTL = 300; // 5 minutes
const teamCacheKey = (id) => `team:membership:${id}`;

// Get all users (with search and filters)
const getUsers = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const { userType, skillLevel, lookingForTeam, recruiting, followers } = req.query;
    const search = normalizeQuerySearch(
      req.query.search !== undefined ? req.query.search : req.query.q
    );
    const viewerId = req.user?._id;
    const isGuest = req.user && req.user.userType === 'guest';
    const excludeFollowing = req.query.excludeFollowing === 'true' || req.query.suggestions === 'true';

    // Build filter object
    const filter = {
      isActive: true,
      isSuperUser: { $ne: true },
    };
    const andConditions = [
      // Exclude duo teams (temporary teams created for tournaments)
      { username: { $not: /^duo_/ } },
    ];

    if (userType) filter.userType = userType;
    if (skillLevel) filter['playerInfo.skillLevel'] = skillLevel;
    if (lookingForTeam === 'true') filter['playerInfo.lookingForTeam'] = true;
    if (recruiting === 'true') filter['teamInfo.recruitingFor.0'] = { $exists: true };

    if (viewerId && !isGuest) {
      const [followedIds, currentUser, usersBlockingViewer] = await Promise.all([
        excludeFollowing ? Follow.find({ follower: viewerId }).distinct('following') : Promise.resolve([]),
        User.findById(viewerId).select('blockedUsers').lean(),
        User.find({ blockedUsers: viewerId }).select('_id').lean(),
      ]);
      const excludedIds = [
        ...(excludeFollowing ? [viewerId, ...followedIds] : []),
        ...(currentUser?.blockedUsers || []),
        ...usersBlockingViewer.map(user => user._id),
      ];
      if (excludedIds.length > 0) andConditions.push({ _id: { $nin: excludedIds } });
    }

    // If searching for followers, filter to only show users that the current user follows
    if (followers === 'true' && req.user) {
      const followedIds = await Follow.find({ follower: req.user._id }).distinct('following');
      if (followedIds.length > 0) {
        filter._id = { $in: followedIds };
      } else {
        // If user has no followers, return empty array
        return res.status(200).json({
          success: true,
          data: {
            users: [],
            pagination: {
              current: page,
              total: 0,
              count: 0,
              totalUsers: 0
            }
          }
        });
      }
    }

    if (search) {
      const pattern = buildPrefixRegex(search);
      andConditions.push({
        $or: [
          { username: { $regex: pattern, $options: 'i' } },
          { 'profile.displayName': { $regex: pattern, $options: 'i' } },
        ],
      });
    }

    filter.$and = andConditions;

    const users = await User.find(filter)
      .select('-password -email')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await User.countDocuments(filter);

    const userIds = users.map(u => u._id);
    const [viewerFollows, pendingFollowRequests, followerCounts, followingCounts] = await Promise.all([
      viewerId && !isGuest
        ? Follow.find({ follower: viewerId, following: { $in: userIds } }).select('following').lean()
        : Promise.resolve([]),
      viewerId && !isGuest
        ? FollowRequest.find({ requester: viewerId, target: { $in: userIds }, status: 'pending' }).select('target').lean()
        : Promise.resolve([]),
      Promise.all(users.map(u =>
        Follow.getFollowerCount(u._id).catch(() => Array.isArray(u.followers) ? u.followers.length : 0)
      )),
      Promise.all(users.map(u =>
        Follow.getFollowingCount(u._id).catch(() => Array.isArray(u.following) ? u.following.length : 0)
      )),
    ]);
    const viewerFollowingIds = new Set(viewerFollows.map(f => f.following.toString()));
    const pendingTargetIds = new Set(pendingFollowRequests.map(request => request.target.toString()));

    res.status(200).json({
      success: true,
      data: {
        users: users.map((u, index) => {
          const id = u._id.toString();
          const isSelf = Boolean(viewerId && id === viewerId.toString());
          const isFollowing = Boolean(viewerId && !isSelf
            ? viewerFollowingIds.has(id)
            : false);
          const privacyAccess = buildPrivacyAccess({
            settings: u.privacySettings,
            isSelf,
            isFollower: isFollowing
          });
          const dto = privacyAccess.restricted
            ? minimalProfile(u)
            : formatUserDTO(u, isGuest, isSelf, privacyAccess.canSeeOnlineStatus);
          if (!isSelf) delete dto.privacySettings;
          const followRequestPending = pendingTargetIds.has(id);
          dto.privacyAccess = {
            ...privacyAccess,
            canFollow: privacyAccess.canFollow && !followRequestPending && !isFollowing,
            followRequestPending
          };
          dto.isFollowing = isFollowing;
          dto.followStatus = isFollowing ? 'accepted' : followRequestPending ? 'pending' : 'none';
          if (!privacyAccess.restricted) {
            dto.followersCount = followerCounts[index];
            dto.followingCount = followingCounts[index];
          }
          return dto;
        }),
        pagination: {
          current: page,
          total: Math.ceil(total / limit),
          count: users.length,
          totalUsers: total
        }
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch users',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get tournament history for a user/team by ID or username (live query from Tournament collection)
const getLiveTournamentHistory = async (req, res) => {
  try {
    const { identifier } = req.params;

    let user;
    if (identifier && identifier.match(/^[0-9a-fA-F]{24}$/)) {
      user = await User.findById(identifier);
    } else {
      user = await User.findOne({ username: identifier });
    }

    if (!user || !user.isActive) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const tournamentPrivacy = await resolvePrivacyAccess({ viewer: req.user, targetUser: user });
    if (!tournamentPrivacy.access.canViewProfile) {
      return privacyDenied(res, user, tournamentPrivacy.access, 'Tournament history is private');
    }

    const userId = user._id;

    const tournamentsRaw = await Tournament.find({
      $or: [
        { host: userId },
        { participants: userId },
        { teams: userId },
        { 'groups.participants': userId },
        { 'groupResults.teams.teamId': userId }
      ]
    })
      .select('name game format mode status startDate endDate prizePool prizePoolType tournamentCode host banner createdAt updatedAt groupResults')
      .populate('host', 'username profile.displayName profile.avatar')
      .sort({ startDate: -1 })
      .lean();

    const userIdStr = String(userId);

    const tournaments = (tournamentsRaw || []).map((t) => {
      let lastRoundReached = null;
      let bestRank = null;

      const groupResults = Array.isArray(t.groupResults) ? t.groupResults : [];
      for (const gr of groupResults) {
        const round = gr?.round || 1;
        const teams = Array.isArray(gr?.teams) ? gr.teams : [];
        for (const tr of teams) {
          const tid = tr?.teamId ? String(tr.teamId) : '';
          if (!tid || tid !== userIdStr) continue;

          if (lastRoundReached === null || round > lastRoundReached) {
            lastRoundReached = round;
          }

          const rank = typeof tr?.rank === 'number' ? tr.rank : null;
          if (rank !== null && (bestRank === null || rank < bestRank)) {
            bestRank = rank;
          }
        }
      }

      return {
        ...t,
        teamProgress: {
          lastRoundReached,
          bestRank
        }
      };
    });

    res.status(200).json({
      success: true,
      data: {
        userId: String(userId),
        tournaments
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch tournament history',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get player tournament history from user.playerInfo.tournamentHistory
const getUserTournamentHistory = async (req, res) => {
  try {
    const { username } = req.params;
    const { game, status, page = 1, limit = 10 } = req.query;

    const user = await User.findOne({ username });
    if (!user || user.userType !== 'player') {
      return res.status(404).json({ success: false, message: 'Player not found' });
    }

    const tournamentPrivacy = await resolvePrivacyAccess({ viewer: req.user, targetUser: user });
    if (!tournamentPrivacy.access.canViewProfile) {
      return privacyDenied(res, user, tournamentPrivacy.access, 'Tournament history is private');
    }

    let history = user.playerInfo?.tournamentHistory || [];

    // Apply filters
    if (game) history = history.filter(e => e.game === game);
    if (status) history = history.filter(e => e.status === status);

    // Sort descending by tournamentStartDate
    history = history.sort((a, b) => new Date(b.tournamentStartDate) - new Date(a.tournamentStartDate));

    const total = history.length;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(50, Math.max(1, parseInt(limit) || 10));
    const totalPages = Math.ceil(total / limitNum);
    const paginated = history.slice((pageNum - 1) * limitNum, pageNum * limitNum);

    return res.status(200).json({
      success: true,
      data: {
        tournamentHistory: paginated,
        pagination: { page: pageNum, limit: limitNum, total, totalPages }
      }
    });
  } catch (error) {
    log.error('getUserTournamentHistory error:', { error: String(error) });
    return res.status(500).json({ success: false, message: 'Failed to fetch tournament history' });
  }
};

// Get user by ID or username
const getUser = async (req, res) => {
  try {
    const { identifier } = req.params;

    // ── Redis profile cache (only anonymous views; logged-in views include viewer-specific relationship data) ──
    const requestingUserId = req.user?._id?.toString?.() || req.user?._id || null;
    const cacheKey = profileCacheKey(identifier);
    if (!requestingUserId) {
      const cached = await getJson(cacheKey);
      if (cached) {
        return res.status(200).json(cached);
      }
    }
    // Try to find by ID first, then by username
    let user;
    if (identifier.match(/^[0-9a-fA-F]{24}$/)) {
      // It's a valid ObjectId
      user = await User.findById(identifier);
    } else {
      // It's a username
      user = await User.findOne({ username: identifier });
    }

    if (!user || !user.isActive) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // If profile owner has blocked the requesting user, don't show profile
    if (req.user && user.blockedUsers?.length) {
      const blockedIds = user.blockedUsers.map(id => id.toString());
      if (blockedIds.includes(req.user._id.toString())) {
        return res.status(404).json({
          success: false,
          message: 'User not found'
        });
      }
    }

    const privacyRelationship = await resolvePrivacyAccess({ viewer: req.user, targetUser: user });
    if (privacyRelationship.blocked) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    const isGuest = !req.user || req.user.userType === 'guest';
    const isSelf = privacyRelationship.isSelf;
    const pendingFollowRequest = !isSelf && req.user?._id
      ? await FollowRequest.exists({ requester: req.user._id, target: user._id, status: 'pending' })
      : null;

    if (privacyRelationship.access.restricted) {
      const restrictedResponse = {
        success: true,
        data: {
          user: minimalProfile(user),
          recentPosts: [],
          relationship: {
            isFollowing: privacyRelationship.isFollower,
            isFollowedBy: false,
            isSelf: false,
            followStatus: pendingFollowRequest ? 'pending' : 'none'
          },
          privacyAccess: {
            ...privacyRelationship.access,
            canFollow: privacyRelationship.access.canFollow && !pendingFollowRequest && !privacyRelationship.isFollower,
            followRequestPending: Boolean(pendingFollowRequest)
          },
          stats: { followersCount: 0, followingCount: 0, postsCount: 0 }
        }
      };
      return res.status(200).json(restrictedResponse);
    }

    // Populate team information if it's a team
    if (user.userType === 'team') {
      if (process.env.NODE_ENV === 'development') { console.log('Populating team info for team:', user.username);}
      await user.populateTeamInfo();
      if (process.env.NODE_ENV === 'development') { console.log('Team rosters count:', user.teamInfo?.rosters?.length || 0);}
      user.teamInfo?.rosters?.forEach(roster => {
        if (process.env.NODE_ENV === 'development') { console.log(`${roster.game} roster - players count:`, roster.players?.length || 0);}
        if (process.env.NODE_ENV === 'development') { console.log(`${roster.game} roster - active players:`, roster.players?.filter(p => p.isActive !== false).length || 0);}
      });
      if (process.env.NODE_ENV === 'development') { console.log('Team staff after population:', user.teamInfo?.staff?.length || 0);}
    }
    
    // Ensure playerInfo.joinedTeams exists for players
    if (user.userType === 'player') {
      if (!user.playerInfo) {
        user.playerInfo = {};
      }
      if (!user.playerInfo.joinedTeams) {
        user.playerInfo.joinedTeams = [];
      }
      
      if (process.env.NODE_ENV === 'development') { console.log('Player found, joinedTeams before population:', user.playerInfo.joinedTeams.length);}
      if (process.env.NODE_ENV === 'development') { console.log('JoinedTeams data:', JSON.stringify(user.playerInfo.joinedTeams, null, 2));
      }
      await user.populate('playerInfo.joinedTeams.team', 'username profile.displayName profile.avatar');
      
      if (process.env.NODE_ENV === 'development') { console.log('JoinedTeams after population:', user.playerInfo.joinedTeams.length);}
      if (process.env.NODE_ENV === 'development') { console.log('JoinedTeams populated data:', JSON.stringify(user.playerInfo.joinedTeams, null, 2));}
    } else {
      if (process.env.NODE_ENV === 'development') { console.log('User type:', user.userType);}
      if (process.env.NODE_ENV === 'development') { console.log('PlayerInfo exists:', !!user.playerInfo);}
      if (process.env.NODE_ENV === 'development') { console.log('JoinedTeams exists:', !!user.playerInfo?.joinedTeams);}
      if (user.playerInfo?.joinedTeams) {
        if (process.env.NODE_ENV === 'development') { console.log('JoinedTeams length:', user.playerInfo.joinedTeams.length);}
      }
    }
    
    // Get user's public profile
    const publicProfile = user.getPublicProfile();
    
    // Ensure joinedTeams data is properly included for players
    if (user.userType === 'player' && user.playerInfo?.joinedTeams) {
      publicProfile.playerInfo = publicProfile.playerInfo || {};
      
      // Verify and sync team membership status with actual team data
      let needsSave = false;
      if (process.env.NODE_ENV === 'development') { console.log(`Verifying ${user.playerInfo.joinedTeams.length} team memberships for user ${user._id}`);}
      const verifiedJoinedTeams = await Promise.all(
        user.playerInfo.joinedTeams.map(async (teamRef, index) => {
          try {
            const team = await User.findById(teamRef.team);
            if (!team || team.userType !== 'team') {
              // Team doesn't exist, mark as inactive
              if (teamRef.isActive) {
                needsSave = true;
                const teamMembership = user.playerInfo.joinedTeams.find(
                  t => t.team.toString() === teamRef.team.toString() && t.game === teamRef.game
                );
                if (teamMembership) {
                  teamMembership.isActive = false;
                  if (!teamMembership.leftAt) {
                    teamMembership.leftAt = new Date();
                  }
                }
              }
              return {
                ...teamRef.toObject(),
                isActive: false,
                removedByTeam: teamRef.removedByTeam || false
              };
            }

            // Check if player is actually in team's roster or staff
            let isActuallyActive = false;
            let actuallyRemovedByTeam = teamRef.removedByTeam || false;

            // Populate team info to get roster/staff data
            await team.populateTeamInfo();

            // Check rosters
            if (team.teamInfo?.rosters) {
              for (const roster of team.teamInfo.rosters) {
                if (roster.game === teamRef.game) {
                  const playerInRoster = roster.players.find(p => {
                    const playerId = p.user ? (p.user._id ? p.user._id.toString() : p.user.toString()) : null;
                    return playerId === user._id.toString();
                  });
                  
                  if (playerInRoster) {
                    isActuallyActive = playerInRoster.isActive !== false;
                    if (!isActuallyActive && !teamRef.removedByTeam) {
                      // Player was removed from team but flag wasn't set
                      actuallyRemovedByTeam = true;
                    }
                    break;
                  }
                }
              }
            }

            // Check staff
            if (!isActuallyActive && team.teamInfo?.staff) {
              // For staff members, check by user ID - staff can have any game value
              const staffMember = team.teamInfo.staff.find(s => {
                const staffId = s.user ? (s.user._id ? s.user._id.toString() : s.user.toString()) : null;
                return staffId === user._id.toString();
              });
              
              if (staffMember) {
                // If it's a staff membership (game is 'Staff' or matches staff member's game)
                // OR if the game values match, consider it the same staff membership
                const staffGame = staffMember.game || 'General';
                const teamRefGame = teamRef.game || 'General';
                const isStaffMembership = teamRefGame === 'Staff' || 
                                         teamRefGame === staffGame || 
                                         staffGame === teamRefGame;
                
                if (isStaffMembership) {
                  isActuallyActive = staffMember.isActive !== false;
                  if (!isActuallyActive && !teamRef.removedByTeam) {
                    actuallyRemovedByTeam = true;
                  }
                }
              }
            }

            // If player's joinedTeams shows isActive=true but we didn't find them in roster/staff,
            // check if they were just added recently (within last 5 minutes) - don't mark as inactive
            // This prevents race conditions where verification runs before roster/staff is updated
            if (!isActuallyActive && teamRef.isActive && teamRef.joinedAt) {
              const joinTime = new Date(teamRef.joinedAt).getTime();
              const now = new Date().getTime();
              const fiveMinutesAgo = now - (5 * 60 * 1000);
              
              if (joinTime > fiveMinutesAgo) {
                // Player just joined recently, might not be in roster/staff yet due to timing
                // Keep them as active for now and don't update database
                if (process.env.NODE_ENV === 'development') { console.log(`Player ${user._id} just joined team ${teamRef.team} recently (${Math.round((now - joinTime) / 1000)}s ago), keeping as active`);}
                isActuallyActive = true;
                // Don't mark as needsSave since we're keeping it active
                return {
                  ...teamRef.toObject(),
                  isActive: true,
                  removedByTeam: false
                };
              }
            }

            // Update the teamRef with verified status if changed
            if (teamRef.isActive !== isActuallyActive || teamRef.removedByTeam !== actuallyRemovedByTeam) {
              if (process.env.NODE_ENV === 'development') { console.log(`Team membership status changed for team ${teamRef.team}: isActive ${teamRef.isActive} -> ${isActuallyActive}, removedByTeam ${teamRef.removedByTeam} -> ${actuallyRemovedByTeam}`);}
              needsSave = true;
              const teamId = teamRef.team._id ? teamRef.team._id.toString() : teamRef.team.toString();
              const teamMembership = user.playerInfo.joinedTeams.find(
                t => {
                  const tId = t.team._id ? t.team._id.toString() : t.team.toString();
                  return tId === teamId && t.game === teamRef.game;
                }
              );
              if (teamMembership) {
                teamMembership.isActive = isActuallyActive;
                teamMembership.removedByTeam = actuallyRemovedByTeam;
                if (!isActuallyActive && !teamMembership.leftAt) {
                  teamMembership.leftAt = new Date();
                }
              } else {
                if (process.env.NODE_ENV === 'development') { console.log(`Warning: Could not find team membership to update for team ${teamId}, game ${teamRef.game}`);}
              }
            }

            return {
              ...teamRef.toObject(),
              isActive: isActuallyActive,
              removedByTeam: actuallyRemovedByTeam
            };
          } catch (error) {
            log.error('Error verifying team membership:', { error: String(error) });
            // Return original data if verification fails
            return teamRef.toObject();
          }
        })
      );

      // Save all updates at once if any changes were made
      if (needsSave) {
        if (process.env.NODE_ENV === 'development') { console.log(`Saving ${user.playerInfo.joinedTeams.length} team memberships after verification`);}
        user.markModified('playerInfo.joinedTeams');
        await user.save();
        if (process.env.NODE_ENV === 'development') { console.log('Team memberships saved successfully');}
        // Re-populate teams after save to get updated data
        await user.populate('playerInfo.joinedTeams.team', 'username profile.displayName profile.avatar');
        
        // Use the updated user data after save
        publicProfile.playerInfo.joinedTeams = user.playerInfo.joinedTeams.map(teamRef => ({
          ...teamRef.toObject(),
          isActive: teamRef.isActive,
          removedByTeam: teamRef.removedByTeam || false
        }));
        if (process.env.NODE_ENV === 'development') { console.log(`Returning ${publicProfile.playerInfo.joinedTeams.length} verified team memberships`);}
      } else {
        // Use verified data if no save was needed
        publicProfile.playerInfo.joinedTeams = verifiedJoinedTeams;
        if (process.env.NODE_ENV === 'development') { console.log(`No changes needed, returning ${verifiedJoinedTeams.length} verified team memberships`);}
      }
    }
    
    // Get user's recent posts
    const allowedPostVisibilities = isSelf
      ? ['public', 'followers', 'private']
      : privacyRelationship.isFollower ? ['public', 'followers'] : ['public'];
    const recentPosts = privacyRelationship.access.canViewPosts
      ? await Post.find({
          author: user._id,
          isActive: true,
          hiddenByAdmin: { $ne: true },
          visibility: { $in: allowedPostVisibilities }
        })
        .populate('author', 'username profile.displayName profile.avatar profilePicture avatar userType')
        .sort({ createdAt: -1 })
        .limit(5)
      : [];

    let isBlockedByMe = false;
    if (req.user) {
      const current = await User.findById(req.user._id).select('blockedUsers').lean();
      if (current?.blockedUsers?.length) {
        isBlockedByMe = current.blockedUsers.some(id => id.toString() === user._id.toString());
      }
    }

    const [
      followersCount,
      followingCount,
      postsCount,
      isFollowing,
      isFollowedBy,
    ] = await Promise.all([
      Follow.getFollowerCount(user._id).catch(() => user.followers ? user.followers.length : 0),
      Follow.getFollowingCount(user._id).catch(() => user.following ? user.following.length : 0),
      privacyRelationship.access.canViewPosts
        ? Post.countDocuments({
            author: user._id,
            isActive: true,
            hiddenByAdmin: { $ne: true },
            visibility: { $in: allowedPostVisibilities }
          }).catch(() => 0)
        : Promise.resolve(0),
      Promise.resolve(privacyRelationship.isFollower),
      requestingUserId && !isGuest && !isSelf
        ? Follow.isFollowing(user._id, requestingUserId).catch(() => false)
        : Promise.resolve(false),
    ]);

    const profileDto = formatUserDTO(user, isGuest, isSelf, privacyRelationship.access.canSeeOnlineStatus);
    if (!isSelf) delete profileDto.privacySettings;
    const responseData = {
      success: true,
      data: {
        user: profileDto,
        isBlockedByMe,
        recentPosts: recentPosts.map(p => formatPostDTO(p, isGuest, isSelf)),
        relationship: {
          isFollowing,
          isFollowedBy,
          isSelf: !!isSelf,
          followStatus: isFollowing ? 'accepted' : pendingFollowRequest ? 'pending' : 'none'
        },
        privacyAccess: {
          ...privacyRelationship.access,
          canFollow: privacyRelationship.access.canFollow && !pendingFollowRequest && !privacyRelationship.isFollower,
          followRequestPending: Boolean(pendingFollowRequest)
        },
        stats: {
          followersCount,
          followingCount,
          postsCount
        }
      }
    };

    // Cache anonymous, non-blocked profile views in Redis for 5 minutes
    if (!requestingUserId && !isBlockedByMe) {
      setJson(cacheKey, responseData, PROFILE_CACHE_TTL).catch(() => {});
    }

    res.status(200).json(responseData);

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch user',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

const invalidateFollowCaches = async (currentUserId, targetUserId) => {
  const [currentUser, targetUser] = await Promise.all([
    User.findById(currentUserId).select('username').lean(),
    User.findById(targetUserId).select('username').lean()
  ]);
  await Promise.all([
    invalidateUserCache(currentUserId),
    invalidateUserCache(targetUserId),
    invalidateProfileCache(
      currentUserId,
      targetUserId,
      currentUser?.username,
      targetUser?.username
    )
  ]);
};

const persistFollow = async (followerId, targetId) => {
  await Promise.all([
    Follow.follow(followerId, targetId),
    User.updateOne({ _id: followerId }, { $addToSet: { following: targetId } }),
    User.updateOne({ _id: targetId }, { $addToSet: { followers: followerId } })
  ]);
};

const persistUnfollow = async (followerId, targetId) => {
  await Promise.all([
    Follow.unfollow(followerId, targetId),
    User.updateOne({ _id: followerId }, { $pull: { following: targetId } }),
    User.updateOne({ _id: targetId }, { $pull: { followers: followerId } })
  ]);
};

// Follow/unfollow with explicit pending requests for non-public profiles.
const toggleFollow = async (req, res) => {
  try {
    const targetUserId = req.params.id;
    const currentUserId = req.user._id.toString ? req.user._id.toString() : req.user._id;

    if (targetUserId === currentUserId) {
      return res.status(400).json({
        success: false,
        message: 'You cannot follow yourself'
      });
    }

    const targetUser = await User.findById(targetUserId)
      .select('isActive username profile privacySettings blockedUsers')
      .lean();
    if (!targetUser || !targetUser.isActive) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const isFollowing = await Follow.isFollowing(currentUserId, targetUserId);
    if (req.method === 'DELETE') {
      await Promise.all([
        isFollowing ? persistUnfollow(currentUserId, targetUserId) : Promise.resolve(),
        FollowRequest.updateMany(
          { requester: currentUserId, target: targetUserId, status: 'pending' },
          { $set: { status: 'cancelled', resolvedAt: new Date() } }
        )
      ]);
      await invalidateFollowCaches(currentUserId, targetUserId);
      const postUnfollowPrivacy = await resolvePrivacyAccess({ viewer: req.user, targetUser });
      if (!postUnfollowPrivacy.access.canSeeOnlineStatus) {
        removePresenceSubscription(req.app?.get?.('io') || global._arcSocketIO, currentUserId, targetUserId);
      }
      return res.status(200).json({
        success: true,
        message: isFollowing ? 'User unfollowed' : 'Follow request cancelled',
        data: {
          isFollowing: false,
          followStatus: 'none',
          followersCount: await Follow.getFollowerCount(targetUserId)
        }
      });
    }

    if (isFollowing) {
      return res.status(200).json({
        success: true,
        message: 'Already following this user',
        data: {
          isFollowing: true,
          followStatus: 'accepted',
          followersCount: await Follow.getFollowerCount(targetUserId)
        }
      });
    }

    const relationship = await resolvePrivacyAccess({ viewer: req.user, targetUser });
    if (relationship.blocked) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    if (!relationship.access.canFollow) {
      return res.status(403).json({
        success: false,
        code: 'FOLLOW_REQUESTS_DISABLED',
        reason: 'follow_requests_disabled',
        message: 'This user is not accepting follow requests'
      });
    }

    if (relationship.settings.profileVisibility !== 'public') {
      let request = await FollowRequest.findOne({ requester: currentUserId, target: targetUserId, status: 'pending' });
      if (!request) {
        try {
          request = await FollowRequest.findOneAndUpdate(
            { requester: currentUserId, target: targetUserId, status: 'pending' },
            { $setOnInsert: { requester: currentUserId, target: targetUserId, status: 'pending' } },
            { upsert: true, new: true, setDefaultsOnInsert: true }
          );
        } catch (error) {
          if (error?.code !== 11000) throw error;
          request = await FollowRequest.findOne({ requester: currentUserId, target: targetUserId, status: 'pending' });
          if (!request) throw error;
        }
        await createAndEmitNotification({
          recipient: targetUserId,
          sender: currentUserId,
          type: 'follow',
          title: 'New follow request',
          message: `${req.user.profile?.displayName || req.user.username || 'Someone'} requested to follow you.`,
          data: {
            deepLink: '/settings/privacy?section=follow-requests',
            customData: {
              eventType: 'follow_request',
              followRequestId: String(request._id),
              notificationDedupeKey: `follow-request:${request._id}`,
              pushRequestId: `follow-request:${request._id}`
            }
          }
        }).catch((notificationError) => {
          log.error('Follow request notification delivery failed', { error: String(notificationError) });
        });
      }
      return res.status(202).json({
        success: true,
        message: 'Follow request sent',
        data: {
          isFollowing: false,
          followStatus: 'pending',
          followRequestId: request._id,
          followersCount: await Follow.getFollowerCount(targetUserId)
        }
      });
    }

    await persistFollow(currentUserId, targetUserId);
    await invalidateFollowCaches(currentUserId, targetUserId);
    await createFollowNotification(targetUserId, currentUserId).catch((notificationError) => {
      log.error('Follow notification delivery failed', { error: String(notificationError) });
    });
    return res.status(200).json({
      success: true,
      message: 'User followed',
      data: {
        isFollowing: true,
        followStatus: 'accepted',
        followersCount: await Follow.getFollowerCount(targetUserId)
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to toggle follow',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

const getTargetPrivacy = async (req, identifier) => {
  const target = identifier && /^[0-9a-fA-F]{24}$/.test(String(identifier))
    ? await User.findById(identifier).select('username userType profile privacySettings blockedUsers isActive')
    : await User.findOne({ username: identifier }).select('username userType profile privacySettings blockedUsers isActive');
  if (!target || !target.isActive) return null;
  const relationship = await resolvePrivacyAccess({ viewer: req.user, targetUser: target });
  return { target, relationship };
};

const getViewerListExclusions = async (viewer) => {
  if (!viewer?._id || viewer.userType === 'guest') return [];
  const [viewerRecord, usersBlockingViewer] = await Promise.all([
    User.findById(viewer._id).select('blockedUsers').lean(),
    User.find({ blockedUsers: viewer._id, isActive: true }).select('_id').lean()
  ]);
  return [
    ...(viewerRecord?.blockedUsers || []),
    ...usersBlockingViewer.map((user) => user._id)
  ];
};

const privacyDenied = (res, target, privacyAccess, message = 'This content is private') => res.status(403).json({
  success: false,
  code: 'PRIVACY_RESTRICTED',
  reason: privacyAccess?.reason || 'privacy_restricted',
  message,
  data: { user: minimalProfile(target), privacyAccess }
});

// Get user's followers — queries Follow collection instead of populating User arrays
const getFollowers = async (req, res) => {
  try {
    const userId = req.params.id;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const search = normalizeQuerySearch(
      req.query.search !== undefined ? req.query.search : req.query.q
    );

    const targetPrivacy = await getTargetPrivacy(req, userId);
    if (!targetPrivacy) return res.status(404).json({ success: false, message: 'User not found' });
    if (!targetPrivacy.relationship.access.canViewFollowers) {
      return privacyDenied(res, targetPrivacy.target, targetPrivacy.relationship.access);
    }

    // Apply block and search constraints before pagination/counting. Filtering
    // afterwards produced short pages and leaked hidden relationship totals.
    const excludeUserIds = await getViewerListExclusions(req.user);
    const result = await Follow.getFollowers(targetPrivacy.target._id, { page, limit, search, excludeUserIds });
    const followers = result.users;

    const isGuest = req.user && req.user.userType === 'guest';
    const viewerId = req.user?._id;
    const [viewerFollows, pendingRequests] = viewerId && !isGuest && followers.length > 0
      ? await Promise.all([
          Follow.find({ follower: viewerId, following: { $in: followers.map(f => f._id) } }).select('following').lean(),
          FollowRequest.find({ requester: viewerId, target: { $in: followers.map(f => f._id) }, status: 'pending' }).select('target').lean()
        ])
      : [[], []];
    const viewerFollowingIds = new Set(viewerFollows.map(f => f.following.toString()));
    const pendingIds = new Set(pendingRequests.map(request => request.target.toString()));

    const followerDtos = await Promise.all(followers.map(async (f) => {
      const relationship = await resolvePrivacyAccess({ viewer: req.user, targetUser: f });
      if (relationship.blocked) return null;
      const dto = relationship.access.restricted ? minimalProfile(f) : formatUserDTO(f, isGuest, false, relationship.access.canSeeOnlineStatus);
      delete dto.privacySettings;
      dto.privacyAccess = relationship.access;
      const id = f._id.toString();
      dto.isFollowing = Boolean(viewerId && id !== viewerId.toString() && viewerFollowingIds.has(id));
      const followRequestPending = pendingIds.has(id);
      dto.followStatus = dto.isFollowing ? 'accepted' : followRequestPending ? 'pending' : 'none';
      dto.privacyAccess = { ...dto.privacyAccess, canFollow: dto.privacyAccess.canFollow && !followRequestPending && !dto.isFollowing, followRequestPending };
      return dto;
    }));
    const visibleFollowerDtos = followerDtos.filter(Boolean);

    res.status(200).json({
      success: true,
      data: {
        followers: visibleFollowerDtos,
        privacyAccess: targetPrivacy.relationship.access,
        pagination: {
          current: page,
          total: result.pages,
          count: visibleFollowerDtos.length,
          totalFollowers: result.total
        }
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch followers',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get user's following — queries Follow collection instead of populating User arrays
const getFollowing = async (req, res) => {
  try {
    const userId = req.params.id;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const search = normalizeQuerySearch(
      req.query.search !== undefined ? req.query.search : req.query.q
    );

    const targetPrivacy = await getTargetPrivacy(req, userId);
    if (!targetPrivacy) return res.status(404).json({ success: false, message: 'User not found' });
    if (!targetPrivacy.relationship.access.canViewFollowers) {
      return privacyDenied(res, targetPrivacy.target, targetPrivacy.relationship.access);
    }

    const excludeUserIds = await getViewerListExclusions(req.user);
    const result = await Follow.getFollowing(targetPrivacy.target._id, { page, limit, search, excludeUserIds });
    const following = result.users;

    const isGuest = req.user && req.user.userType === 'guest';
    const viewerId = req.user?._id;
    const [viewerFollows, pendingRequests] = viewerId && !isGuest && following.length > 0
      ? await Promise.all([
          Follow.find({ follower: viewerId, following: { $in: following.map(f => f._id) } }).select('following').lean(),
          FollowRequest.find({ requester: viewerId, target: { $in: following.map(f => f._id) }, status: 'pending' }).select('target').lean()
        ])
      : [[], []];
    const viewerFollowingIds = new Set(viewerFollows.map(f => f.following.toString()));
    const pendingIds = new Set(pendingRequests.map(request => request.target.toString()));

    const followingDtos = await Promise.all(following.map(async (f) => {
      const relationship = await resolvePrivacyAccess({ viewer: req.user, targetUser: f });
      if (relationship.blocked) return null;
      const dto = relationship.access.restricted ? minimalProfile(f) : formatUserDTO(f, isGuest, false, relationship.access.canSeeOnlineStatus);
      delete dto.privacySettings;
      dto.privacyAccess = relationship.access;
      const id = f._id.toString();
      dto.isFollowing = Boolean(viewerId && id !== viewerId.toString() && viewerFollowingIds.has(id));
      const followRequestPending = pendingIds.has(id);
      dto.followStatus = dto.isFollowing ? 'accepted' : followRequestPending ? 'pending' : 'none';
      dto.privacyAccess = { ...dto.privacyAccess, canFollow: dto.privacyAccess.canFollow && !followRequestPending && !dto.isFollowing, followRequestPending };
      return dto;
    }));
    const visibleFollowingDtos = followingDtos.filter(Boolean);

    res.status(200).json({
      success: true,
      data: {
        following: visibleFollowingDtos,
        privacyAccess: targetPrivacy.relationship.access,
        pagination: {
          current: page,
          total: result.pages,
          count: visibleFollowingDtos.length,
          totalFollowing: result.total
        }
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch following',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get user's posts
const getUserPosts = async (req, res) => {
  try {
    const identifier = req.params.id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;
    if (process.env.NODE_ENV === 'development') { console.log('Getting posts for user:', identifier);}
    if (process.env.NODE_ENV === 'development') { console.log('Current user:', req.user?._id);
}
    // Support both userId and username (frontend often calls /users/:username/posts)
    let user;
    if (identifier && identifier.match(/^[0-9a-fA-F]{24}$/)) {
      user = await User.findById(identifier);
      // If not found by id, fall back to username (rare edge case: username looks like ObjectId)
      if (!user) {
        user = await User.findOne({ username: identifier });
      }
    } else {
      user = await User.findOne({ username: identifier });
    }
    
    if (!user || !user.isActive) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const userId = user._id.toString();
    const relationship = await resolvePrivacyAccess({ viewer: req.user, targetUser: user });
    if (!relationship.access.canViewPosts) {
      return privacyDenied(res, user, relationship.access, 'Posts are not available for this account');
    }
    const visibilityFilter = relationship.isSelf
      ? ['public', 'followers', 'private']
      : relationship.isFollower ? ['public', 'followers'] : ['public'];

    if (process.env.NODE_ENV === 'development') { console.log('Visibility filter:', visibilityFilter);}
    const posts = await Post.find({
      author: user._id,
      isActive: true,
      hiddenByAdmin: { $ne: true },
      visibility: { $in: visibilityFilter }
    })
    .populate('author', 'username profile.displayName profile.avatar profilePicture avatar userType')
    .populate('likes.user', 'username profile.displayName profile.avatar profilePicture avatar')
    .populate('comments.user', 'username profile.displayName profile.avatar profilePicture avatar')
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit);
    if (process.env.NODE_ENV === 'development') { console.log('Found posts:', posts.length);}

    const total = await Post.countDocuments({
      author: user._id,
      isActive: true,
      hiddenByAdmin: { $ne: true },
      visibility: { $in: visibilityFilter }
    });

    const isGuest = req.user && req.user.userType === 'guest';

    res.status(200).json({
      success: true,
      data: {
        posts: posts.map(p => formatPostDTO(p, isGuest, req.user && req.user._id && !isGuest && p.author && p.author._id && p.author._id.toString() === req.user._id.toString())),
        privacyAccess: relationship.access,
        pagination: {
          current: page,
          total: Math.ceil(total / limit),
          count: posts.length,
          totalPosts: total
        }
      }
    });

  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch user posts',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get user's clips (posts with at least one video)
const getUserClips = async (req, res) => {
  try {
    const identifier = req.params.id;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    let user;
    if (identifier && identifier.match(/^[0-9a-fA-F]{24}$/)) {
      user = await User.findById(identifier);
      if (!user) user = await User.findOne({ username: identifier });
    } else {
      user = await User.findOne({ username: identifier });
    }

    if (!user || !user.isActive) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const userId = user._id.toString();
    const relationship = await resolvePrivacyAccess({ viewer: req.user, targetUser: user });
    if (!relationship.access.canViewClips) {
      return privacyDenied(res, user, relationship.access, 'Clips are not available for this account');
    }
    const visibilityFilter = relationship.isSelf
      ? ['public', 'followers', 'private']
      : relationship.isFollower ? ['public', 'followers'] : ['public'];

    const filter = {
      author: user._id,
      isActive: true,
      hiddenByAdmin: { $ne: true },
      visibility: { $in: visibilityFilter },
      'content.media': { $elemMatch: { type: 'video' } }
    };

    const posts = await Post.find(filter)
      .populate('author', 'username profile.displayName profile.avatar profilePicture avatar userType')
      .populate('likes.user', 'username profile.displayName profile.avatar profilePicture avatar')
      .populate('comments.user', 'username profile.displayName profile.avatar profilePicture avatar')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await Post.countDocuments(filter);

    const isGuest = req.user && req.user.userType === 'guest';

    res.status(200).json({
      success: true,
      data: {
        posts: posts.map(p => formatPostDTO(p, isGuest, req.user && req.user._id && !isGuest && p.author && p.author._id && p.author._id.toString() === req.user._id.toString())),
        privacyAccess: relationship.access,
        pagination: {
          current: page,
          total: Math.ceil(total / limit),
          count: posts.length,
          totalClips: total
        }
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: 'Failed to fetch user clips',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Add player to roster (creates invite)
const addPlayerToRoster = async (req, res) => {
  try {
    const { teamId } = req.params;
    const { playerId, game, role, inGameName, message } = req.body;

    // Verify the team exists and current user is the team owner
    const team = await User.findById(teamId);
    if (!team || team.userType !== 'team') {
      return res.status(404).json({
        success: false,
        message: 'Team not found'
      });
    }

    if (team._id.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Only team owners can add players to rosters'
      });
    }

    // Verify the player exists and is a player
    const player = await User.findById(playerId);
    if (!player || player.userType !== 'player') {
      return res.status(404).json({
        success: false,
        message: 'Player not found'
      });
    }

    // Check if player is already in this roster (active only)
    const existingRoster = team.teamInfo.rosters.find(r => r.game === game);
    if (existingRoster) {
      const existingPlayer = existingRoster.players.find(p => p.user.toString() === playerId && p.isActive);
      if (existingPlayer) {
        return res.status(400).json({
          success: false,
          message: 'Player is already in this roster'
        });
      }
    }

    // Check if there's already a pending invite
    const existingInvite = await RosterInvite.findOne({
      team: teamId,
      player: playerId,
      game,
      status: 'pending'
    });

    if (existingInvite) {
      return res.status(400).json({
        success: false,
        message: 'Player already has a pending invite for this roster'
      });
    }

    // Create roster invite
    const invite = new RosterInvite({
      team: teamId,
      player: playerId,
      game,
      role: role || 'Player',
      inGameName,
      message
    });

    await invite.save();

    // Send invite as direct message instead of notification
    if (process.env.NODE_ENV === 'development') { console.log('Sending roster invite message to player:', playerId);}
    if (process.env.NODE_ENV === 'development') { console.log('Team info:', team.profile?.displayName || team.username);
    }
    try {
      await sendInviteMessage(teamId, playerId, 'roster', {
        inviteId: invite._id,
        game,
        role: role || 'Player',
        inGameName,
        message
      });
      if (process.env.NODE_ENV === 'development') { console.log('Roster invite message sent successfully');
      }
    } catch (messageError) {
      log.error('Error sending roster invite message:', { error: String(messageError) });
    }

    res.status(201).json({
      success: true,
      message: 'Roster invite sent successfully',
      data: { invite }
    });

  } catch (error) {
    log.error('Error adding player to roster:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to add player to roster',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Add staff member (invite-based)
const addStaffMember = async (req, res) => {
  try {
    const { teamId } = req.params;
    const { memberId, role, game, message } = req.body;

    // Verify the team exists and current user is the team owner
    const team = await User.findById(teamId);
    if (!team || team.userType !== 'team') {
      return res.status(404).json({
        success: false,
        message: 'Team not found'
      });
    }

    if (team._id.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Only team owners can invite staff members'
      });
    }

    // Verify the member exists
    const member = await User.findById(memberId);
    if (!member) {
      return res.status(404).json({
        success: false,
        message: 'Member not found'
      });
    }

    // Check if there's already a pending invite
    const existingInvite = await StaffInvite.findOne({
      team: teamId,
      player: memberId,
      game: game || 'General',
      status: 'pending'
    });

    if (existingInvite) {
      return res.status(400).json({
        success: false,
        message: 'An invite is already pending for this member for this game'
      });
    }

    // Check if member is already in staff (active only)
    const existingStaff = team.teamInfo.staff.find(s => s.user.toString() === memberId && s.isActive);
    if (existingStaff) {
      return res.status(400).json({
        success: false,
        message: 'Member is already in the staff'
      });
    }

    // Create staff invite
    const staffInvite = new StaffInvite({
      team: teamId,
      player: memberId,
      game: game || 'General',
      role,
      message: message || `You've been invited to join ${team.profile?.displayName || team.username} as ${role} for ${game || 'General'}`
    });

    await staffInvite.save();

    // Send invite as direct message instead of notification
    if (process.env.NODE_ENV === 'development') { console.log('Sending staff invite message to member:', memberId);}
    if (process.env.NODE_ENV === 'development') { console.log('Team info:', team.profile?.displayName || team.username);}
    if (process.env.NODE_ENV === 'development') { console.log('Staff invite ID:', staffInvite._id);}
    if (process.env.NODE_ENV === 'development') { console.log('Team ID:', teamId);}
    if (process.env.NODE_ENV === 'development') { console.log('Role:', role);
    }
    try {
      await sendInviteMessage(teamId, memberId, 'staff', {
        inviteId: staffInvite._id,
        role,
        game: game || 'General',
        message: staffInvite.message
      });
      if (process.env.NODE_ENV === 'development') { console.log('Staff invite message sent successfully');
      }
    } catch (messageError) {
      log.error('Error sending staff invite message:', { error: String(messageError) });
      console.error('Error details:', {
        message: messageError.message,
        stack: messageError.stack
      });
    }

    res.status(200).json({
      success: true,
      message: 'Staff invitation sent successfully'
    });

  } catch (error) {
    log.error('Error sending staff invitation:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to send staff invitation',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Add staff member by username (invite-based)
const addStaffMemberByUsername = async (req, res) => {
  try {
    const { teamId } = req.params;
    const { username, role, game, message } = req.body;

    // Verify the team exists and current user is the team owner
    const team = await User.findById(teamId);
    if (!team || team.userType !== 'team') {
      return res.status(404).json({
        success: false,
        message: 'Team not found'
      });
    }

    if (team._id.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Only team owners can invite staff members'
      });
    }

    // Find member by username
    const member = await User.findOne({ username: username });
    if (!member) {
      return res.status(404).json({
        success: false,
        message: `User with username '${username}' not found`
      });
    }

    const memberId = member._id;

    // Check if there's already a pending invite
    const existingInvite = await StaffInvite.findOne({
      team: teamId,
      player: memberId,
      game: game || 'General',
      status: 'pending'
    });

    if (existingInvite) {
      return res.status(400).json({
        success: false,
        message: 'An invite is already pending for this member for this game'
      });
    }

    // Check if member is already in staff (active only)
    const existingStaff = team.teamInfo.staff.find(s => s.user.toString() === memberId && s.isActive);
    if (existingStaff) {
      return res.status(400).json({
        success: false,
        message: 'Member is already in the staff'
      });
    }

    // Create staff invite
    const staffInvite = new StaffInvite({
      team: teamId,
      player: memberId,
      game: game || 'General',
      role,
      message: message || `You've been invited to join ${team.profile?.displayName || team.username} as ${role} for ${game || 'General'}`
    });

    await staffInvite.save();

    // Send invite as direct message instead of notification
    if (process.env.NODE_ENV === 'development') { console.log('Sending staff invite message to member:', memberId);}
    if (process.env.NODE_ENV === 'development') { console.log('Member username:', member.username);}
    if (process.env.NODE_ENV === 'development') { console.log('Team info:', team.profile?.displayName || team.username);}
    if (process.env.NODE_ENV === 'development') { console.log('Staff invite ID:', staffInvite._id);}
    if (process.env.NODE_ENV === 'development') { console.log('Team ID:', teamId);}
    if (process.env.NODE_ENV === 'development') { console.log('Role:', role);
    }
    try {
      await sendInviteMessage(teamId, memberId, 'staff', {
        inviteId: staffInvite._id,
        role,
        game: game || 'General',
        message: staffInvite.message
      });
      if (process.env.NODE_ENV === 'development') { console.log('Staff invite message sent successfully');
      }
    } catch (messageError) {
      log.error('Error sending staff invite message:', { error: String(messageError) });
      console.error('Error details:', {
        message: messageError.message,
        stack: messageError.stack
      });
    }

    res.status(200).json({
      success: true,
      message: `Staff invitation sent successfully to ${member.username}`,
      data: {
        invitedUser: {
          id: member._id,
          username: member.username,
          displayName: member.profile?.displayName
        },
        role: role,
        inviteId: staffInvite._id
      }
    });

  } catch (error) {
    log.error('Error sending staff invitation:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to send staff invitation',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Remove player from roster
const removePlayerFromRoster = async (req, res) => {
  try {
    const { teamId, game, playerId } = req.params;

    // Verify the team exists and current user is the team owner
    const team = await User.findById(teamId);
    if (!team || team.userType !== 'team') {
      return res.status(404).json({
        success: false,
        message: 'Team not found'
      });
    }

    if (team._id.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Only team owners can remove players from rosters'
      });
    }

    // Find and completely remove player from roster
    const roster = team.teamInfo.rosters.find(r => r.game === game);
    if (!roster) {
      return res.status(404).json({
        success: false,
        message: 'Roster not found'
      });
    }

    const playerIndex = roster.players.findIndex(p => p.user.toString() === playerId && p.isActive);
    if (playerIndex === -1) {
      return res.status(404).json({
        success: false,
        message: 'Player not found in roster'
      });
    }

    // Mark player as inactive
    roster.players[playerIndex].isActive = false;
    roster.players[playerIndex].leftAt = new Date();
    await team.save();

    // Mark as inactive in player's joinedTeams and set removedByTeam flag
    const playerUser = await User.findById(playerId);
    if (playerUser && playerUser.userType === 'player') {
      const teamMembership = playerUser.playerInfo.joinedTeams.find(
        teamRef => teamRef.team.toString() === teamId && teamRef.game === game
      );
      if (teamMembership) {
        teamMembership.isActive = false;
        teamMembership.leftAt = new Date();
        teamMembership.removedByTeam = true;
        await playerUser.save();

        // Emit socket event to notify player about removal
        const io = req.app.get('io');
        if (io) {
          io.to(`user-${playerId}`).emit('profile-updated', {
            type: 'team-membership-updated',
            message: 'You have been removed from the team',
            teamId: teamId
          });
        }
      }
    }

    res.status(200).json({
      success: true,
      message: 'Player removed from roster successfully'
    });

  } catch (error) {
    log.error('Error removing player from roster:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to remove player from roster',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Remove staff member
const removeStaffMember = async (req, res) => {
  try {
    const { teamId, playerId } = req.params;

    // Verify the team exists and current user is the team owner
    const team = await User.findById(teamId);
    if (!team || team.userType !== 'team') {
      return res.status(404).json({
        success: false,
        message: 'Team not found'
      });
    }

    if (team._id.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Only team owners can remove staff members'
      });
    }

    // Find and completely remove staff member from team
    if (process.env.NODE_ENV === 'development') { console.log('Looking for staff member with ID:', playerId);}
    if (process.env.NODE_ENV === 'development') { console.log('Current staff members:', team.teamInfo.staff);
    }
    const staffIndex = team.teamInfo.staff.findIndex(s => {
      const staffUserId = s.user ? (s.user._id ? s.user._id.toString() : s.user.toString()) : null;
      return staffUserId === playerId && s.isActive !== false;
    });
    if (process.env.NODE_ENV === 'development') { console.log('Staff index found:', staffIndex);
    }
    if (staffIndex === -1) {
      return res.status(404).json({
        success: false,
        message: 'Staff member not found or already removed'
      });
    }

    // Mark staff member as inactive
    team.teamInfo.staff[staffIndex].isActive = false;
    team.teamInfo.staff[staffIndex].leftAt = new Date();
    team.markModified('teamInfo.staff');
    await team.save();
    if (process.env.NODE_ENV === 'development') { console.log('Staff member marked as inactive and saved');
}
    // Update player's joinedTeams to mark as inactive and set removedByTeam flag
    const player = await User.findById(playerId);
    if (player && player.userType === 'player') {
      const teamMembership = player.playerInfo.joinedTeams.find(
        teamRef => teamRef.team.toString() === teamId && teamRef.game === 'Staff'
      );
      if (teamMembership) {
        teamMembership.isActive = false;
        teamMembership.leftAt = new Date();
        teamMembership.removedByTeam = true;
        await player.save();

        // Emit socket event to notify player about removal
        const io = req.app.get('io');
        if (io) {
          io.to(`user-${playerId}`).emit('profile-updated', {
            type: 'team-membership-updated',
            message: 'You have been removed from the team',
            teamId: teamId
          });
        }
      }
    }

    res.status(200).json({
      success: true,
      message: 'Staff member removed successfully'
    });

  } catch (error) {
    log.error('Error removing staff member:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to remove staff member',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Temporary function to manually add team to player's joined teams (for testing)
const addTeamToPlayer = async (req, res) => {
  try {
    const { playerId, teamId } = req.params;
    const { role, game } = req.body;

    // Find the player
    const player = await User.findById(playerId);
    if (!player || player.userType !== 'player') {
      return res.status(404).json({
        success: false,
        message: 'Player not found'
      });
    }

    // Find the team
    const team = await User.findById(teamId);
    if (!team || team.userType !== 'team') {
      return res.status(404).json({
        success: false,
        message: 'Team not found'
      });
    }

    // Ensure playerInfo and joinedTeams exist
    if (!player.playerInfo) {
      player.playerInfo = {};
    }
    if (!player.playerInfo.joinedTeams) {
      player.playerInfo.joinedTeams = [];
    }

    // Check if player is already in this team
    const existingMembership = player.playerInfo.joinedTeams.find(
      membership => membership.team.toString() === teamId
    );

    if (!existingMembership) {
      // Add new team membership
      player.playerInfo.joinedTeams.push({
        team: teamId,
        game: game || 'Staff',
        role: role || 'Staff Member',
        inGameName: null,
        joinedAt: new Date(),
        leftAt: null,
        isActive: true
      });

      await player.save();
      if (process.env.NODE_ENV === 'development') { console.log('Team added to player successfully');}
    } else {
      if (process.env.NODE_ENV === 'development') { console.log('Player already has membership in this team');}
    }

    res.status(200).json({
      success: true,
      message: 'Team added to player successfully',
      data: {
        playerId,
        teamId,
        joinedTeams: player.playerInfo.joinedTeams
      }
    });

  } catch (error) {
    log.error('Error adding team to player:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to add team to player',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get pending invites for a team
const getTeamPendingInvites = async (req, res) => {
  try {
    const { teamId } = req.params;
    const currentUserId = req.user._id;

    // Support both ObjectId and username
    const mongoose = require('mongoose');
    let team;
    if (mongoose.Types.ObjectId.isValid(teamId)) {
      team = await User.findById(teamId);
    } else {
      team = await User.findOne({ username: teamId });
    }

    if (!team || team.userType !== 'team') {
      return res.status(404).json({
        success: false,
        message: 'Team not found'
      });
    }

    if (team._id.toString() !== currentUserId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Only team owners can view pending invites'
      });
    }

    // Get pending roster invites
    const pendingRosterInvites = await RosterInvite.find({
      team: teamId,
      status: 'pending'
    }).populate('player', 'username profile.displayName profile.avatar');

    // Get pending staff invites
    const pendingStaffInvites = await StaffInvite.find({
      team: teamId,
      status: 'pending'
    }).populate('player', 'username profile.displayName profile.avatar');

    res.status(200).json({
      success: true,
      data: {
        rosterInvites: pendingRosterInvites,
        staffInvites: pendingStaffInvites
      }
    });

  } catch (error) {
    log.error('Error fetching pending invites:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to fetch pending invites',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get all roster invites for the logged-in player
const getRosterInvites = async (req, res) => {
  try {
    const playerId = req.user._id;

    const invites = await RosterInvite.find({ player: playerId, status: { $in: ['pending', 'accepted', 'declined'] } })
      .populate('team', 'username profile.displayName profile.avatar')
      .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      data: { invites }
    });
  } catch (error) {
    log.error('Error fetching roster invites:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to fetch roster invites',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Accept a roster invite
const acceptRosterInvite = async (req, res) => {
  try {
    const { inviteId } = req.params;
    const playerId = req.user._id;

    const invite = await RosterInvite.findById(inviteId).populate('team', 'username profile teamInfo');
    if (!invite) {
      return res.status(404).json({ success: false, message: 'Invite not found' });
    }

    if (invite.player.toString() !== playerId.toString()) {
      return res.status(403).json({ success: false, message: 'Not authorised to accept this invite' });
    }

    if (invite.status !== 'pending') {
      return res.status(400).json({ success: false, message: `Invite is already ${invite.status}` });
    }

    invite.status = 'accepted';
    await invite.save();

    // Add player to team roster
    const team = await User.findById(invite.team);
    if (team) {
      let roster = team.teamInfo.rosters.find(r => r.game === invite.game);
      if (!roster) {
        team.teamInfo.rosters.push({ game: invite.game, players: [] });
        roster = team.teamInfo.rosters[team.teamInfo.rosters.length - 1];
      }
      // Remove any stale entry for this player first
      roster.players = roster.players.filter(p => p.user.toString() !== playerId.toString());
      roster.players.push({
        user: playerId,
        role: invite.role || 'Player',
        inGameName: invite.inGameName || '',
        joinedAt: new Date(),
        isActive: true
      });
      team.markModified('teamInfo.rosters');
      await team.save();
    }

    // Update player's joinedTeams
    const player = await User.findById(playerId);
    if (player) {
      if (!player.playerInfo) player.playerInfo = {};
      if (!player.playerInfo.joinedTeams) player.playerInfo.joinedTeams = [];
      player.playerInfo.joinedTeams.push({
        team: invite.team,
        game: invite.game,
        role: invite.role || 'Player',
        inGameName: invite.inGameName || '',
        joinedAt: new Date(),
        isActive: true
      });
      await player.save();
    }

    res.status(200).json({ success: true, message: 'Roster invite accepted successfully' });
  } catch (error) {
    log.error('Error accepting roster invite:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to accept roster invite',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Decline a roster invite
const declineRosterInvite = async (req, res) => {
  try {
    const { inviteId } = req.params;
    const playerId = req.user._id;

    const invite = await RosterInvite.findById(inviteId);
    if (!invite) {
      return res.status(404).json({ success: false, message: 'Invite not found' });
    }

    if (invite.player.toString() !== playerId.toString()) {
      return res.status(403).json({ success: false, message: 'Not authorised to decline this invite' });
    }

    if (invite.status !== 'pending') {
      return res.status(400).json({ success: false, message: `Invite is already ${invite.status}` });
    }

    invite.status = 'declined';
    await invite.save();

    res.status(200).json({ success: true, message: 'Roster invite declined successfully' });
  } catch (error) {
    log.error('Error declining roster invite:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to decline roster invite',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Cancel roster invite
const cancelRosterInvite = async (req, res) => {
  try {
    const { inviteId } = req.params;
    const currentUserId = req.user._id;

    if (process.env.NODE_ENV === 'development') { console.log('Cancelling roster invite:', { inviteId, currentUserId });
}
    const invite = await RosterInvite.findById(inviteId);
    if (!invite) {
      if (process.env.NODE_ENV === 'development') { console.log('Roster invite not found:', inviteId);}
      return res.status(404).json({
        success: false,
        message: 'Invite not found'
      });
    }

    log.debug('Found roster invite:', { 
      inviteId: invite._id, 
      team: invite.team, 
      currentUserId,
      status: invite.status 
    });

    // Verify the current user is the team owner
    if (invite.team.toString() !== currentUserId.toString()) {
      if (process.env.NODE_ENV === 'development') { console.log('Permission denied: user is not team owner');}
      return res.status(403).json({
        success: false,
        message: 'Only team owners can cancel invites'
      });
    }

    invite.status = 'cancelled';
    await invite.save();

    if (process.env.NODE_ENV === 'development') { console.log('Roster invite cancelled successfully');
}
    res.status(200).json({
      success: true,
      message: 'Roster invite cancelled successfully'
    });

  } catch (error) {
    log.error('Error cancelling roster invite:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to cancel roster invite',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Cancel staff invite
const cancelStaffInvite = async (req, res) => {
  try {
    const { inviteId } = req.params;
    const currentUserId = req.user._id;

    if (process.env.NODE_ENV === 'development') { console.log('Cancelling staff invite:', { inviteId, currentUserId });
}
    const invite = await StaffInvite.findById(inviteId);
    if (!invite) {
      if (process.env.NODE_ENV === 'development') { console.log('Staff invite not found:', inviteId);}
      return res.status(404).json({
        success: false,
        message: 'Invite not found'
      });
    }

    log.debug('Found staff invite:', { 
      inviteId: invite._id, 
      team: invite.team, 
      currentUserId,
      status: invite.status 
    });

    // Verify the current user is the team owner
    if (invite.team.toString() !== currentUserId.toString()) {
      if (process.env.NODE_ENV === 'development') { console.log('Permission denied: user is not team owner');}
      return res.status(403).json({
        success: false,
        message: 'Only team owners can cancel invites'
      });
    }

    invite.status = 'cancelled';
    await invite.save();

    if (process.env.NODE_ENV === 'development') { console.log('Staff invite cancelled successfully');
}
    res.status(200).json({
      success: true,
      message: 'Staff invite cancelled successfully'
    });

  } catch (error) {
    log.error('Error cancelling staff invite:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to cancel staff invite',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Cancel staff invite by username
const cancelStaffInviteByUsername = async (req, res) => {
  try {
    const { teamId } = req.params;
    const { username } = req.body;
    const currentUserId = req.user._id;

    if (process.env.NODE_ENV === 'development') { console.log('Cancelling staff invite by username:', { teamId, username, currentUserId });
}
    // Verify the team exists and current user is the team owner
    const team = await User.findById(teamId);
    if (!team || team.userType !== 'team') {
      return res.status(404).json({
        success: false,
        message: 'Team not found'
      });
    }

    if (team._id.toString() !== currentUserId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Only team owners can cancel invites'
      });
    }

    // Find the user by username
    const user = await User.findOne({ username: username });
    if (!user) {
      return res.status(404).json({
        success: false,
        message: `User with username '${username}' not found`
      });
    }

    // Find the pending invite for this user
    const invite = await StaffInvite.findOne({
      team: teamId,
      player: user._id,
      status: 'pending'
    });

    if (!invite) {
      return res.status(404).json({
        success: false,
        message: `No pending invite found for user '${username}'`
      });
    }

    log.debug('Found staff invite to cancel:', { 
      inviteId: invite._id, 
      team: invite.team, 
      player: invite.player,
      username: username,
      status: invite.status 
    });

    // Cancel the invite
    invite.status = 'cancelled';
    await invite.save();

    if (process.env.NODE_ENV === 'development') { console.log('Staff invite cancelled successfully for username:', username);
}
    res.status(200).json({
      success: true,
      message: `Staff invite cancelled successfully for ${username}`,
      data: {
        cancelledUser: {
          id: user._id,
          username: user.username,
          displayName: user.profile?.displayName
        },
        inviteId: invite._id
      }
    });

  } catch (error) {
    log.error('Error cancelling staff invite by username:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to cancel staff invite',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Player leaves team
const leaveTeam = async (req, res) => {
  try {
    const { teamId, game } = req.params;
    const playerId = req.user._id;

    if (process.env.NODE_ENV === 'development') { console.log('Player leaving team:', { teamId, game, playerId });
}
    // Verify the player exists
    const player = await User.findById(playerId);
    if (!player || player.userType !== 'player') {
      return res.status(404).json({
        success: false,
        message: 'Player not found'
      });
    }

    // Verify the team exists
    const team = await User.findById(teamId);
    if (!team || team.userType !== 'team') {
      return res.status(404).json({
        success: false,
        message: 'Team not found'
      });
    }

    // Find the team membership in player's joinedTeams
    const teamMembership = player.playerInfo.joinedTeams.find(
      membership => membership.team.toString() === teamId && 
                   (membership.game === game || (game === 'Staff' && membership.game === 'Staff')) && 
                   membership.isActive
    );

    if (!teamMembership) {
      return res.status(404).json({
        success: false,
        message: 'You are not a member of this team'
      });
    }

    // Mark the membership as inactive and set leftAt date
    teamMembership.isActive = false;
    teamMembership.leftAt = new Date();
    
    // Save the player changes
    await player.save();
    if (process.env.NODE_ENV === 'development') { console.log('Player saved successfully, updated membership:', teamMembership);
}
    // For staff members, check if they have a pending leave request
    if (game === 'Staff') {
      const staffMember = team.teamInfo.staff.find(s => s.user.toString() === playerId && s.isActive);
      if (staffMember) {
        // Check if they have a pending leave request
        const LeaveRequest = require('../models/LeaveRequest');
        const pendingRequest = await LeaveRequest.findOne({
          team: teamId,
          staffMember: playerId,
          status: 'pending'
        });

        if (pendingRequest) {
          return res.status(400).json({
            success: false,
            message: 'You have a pending leave request. Please wait for admin approval or cancel the request first.'
          });
        }

        // If no pending request, create one
        const leaveRequest = new LeaveRequest({
          team: teamId,
          staffMember: playerId,
          reason: 'Direct leave request'
        });

        await leaveRequest.save();

        // Update staff member status
        staffMember.leaveRequestStatus = 'pending';
        await team.save();

        return res.status(200).json({
          success: true,
          message: 'Leave request created successfully. Please wait for admin approval.',
          data: {
            leaveRequestId: leaveRequest._id
          }
        });
      } else {
        if (process.env.NODE_ENV === 'development') { console.log('Staff member not found or not active');}
        return res.status(404).json({
          success: false,
          message: 'You are not an active staff member of this team'
        });
      }
    } else {
      // For roster players, check if they have a pending leave request first
      const LeaveRequest = require('../models/LeaveRequest');
      const pendingRequest = await LeaveRequest.findOne({
        team: teamId,
        player: playerId,
        game: game,
        status: 'pending'
      });

      if (pendingRequest) {
        return res.status(400).json({
            success: false,
          message: 'You have a pending leave request for this roster. Please wait for team owner approval or cancel the request first.'
          });
        }

      // If no pending request, players must use leave request system
      // Don't allow direct leave for roster players
      return res.status(400).json({
          success: false,
        message: 'Please submit a leave request first. Direct leave is not allowed for roster players.'
        });
    }

    if (process.env.NODE_ENV === 'development') { console.log('Player successfully left team');
}
    // Send notification to team about player leaving
    try {
      // Notify team owner and active staff members
      const teamOwnerId = team._id;
      const staffIds = team.teamInfo.staff
        .filter(staff => staff.isActive && staff.user.toString() !== playerId.toString())
        .map(staff => staff.user);
      
      const recipients = Array.from(new Set([teamOwnerId, ...staffIds].map(String)));
      await Promise.all(recipients.map((recipient) => createAndEmitNotification({
        recipient,
        sender: player._id,
        type: 'system',
        title: 'Player Left Team',
        message: `${player.profile?.displayName || player.username} has left your team`,
        data: {
          customData: {
            eventType: 'player_left_team',
            playerId: player._id,
            playerName: player.profile?.displayName || player.username,
            game,
            teamId: team._id,
            teamName: team.profile?.displayName || team.username
          }
        }
      })));
      
      if (process.env.NODE_ENV === 'development') { console.log('Notification sent to team members about player leaving');}
    } catch (notificationError) {
      log.error('Error sending notification:', { error: String(notificationError) });
    }

    res.status(200).json({
      success: true,
      message: 'Successfully left the team'
    });

  } catch (error) {
    log.error('Error leaving team:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to leave team',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Send invite message directly to player's DM
const clashOfClansAPI = require('../utils/clashOfClansAPI');
const clashRoyaleAPI = require('../utils/clashRoyaleAPI');

const sendInviteMessage = async (teamId, playerId, inviteType, inviteData) => {
  try {
    const { Message } = require('../models/Message');
    const [team, player] = await Promise.all([
      User.findOne({ _id: teamId, isActive: true })
        .select('username userType profile privacySettings blockedUsers isActive'),
      User.findOne({ _id: playerId, isActive: true })
        .select('username userType profile privacySettings blockedUsers isActive')
    ]);
    
    if (!team || !player) {
      throw new Error('Team or player not found');
    }

    const existingConversation = Boolean(await Message.exists({
      messageType: 'direct',
      isDeleted: false,
      $or: [
        { sender: teamId, recipient: playerId },
        { sender: playerId, recipient: teamId }
      ]
    }));
    const playerAccess = await resolvePrivacyAccess({
      viewer: team,
      targetUser: player,
      existingConversation
    });
    if (!playerAccess.access.canMessage) {
      log.info('Team invite DM suppressed by recipient privacy', {
        teamId: String(teamId),
        playerId: String(playerId),
        inviteType,
        reason: playerAccess.blocked ? 'blocked' : playerAccess.settings.allowMessageFrom
      });
      return null;
    }

    let messageText = '';
    let inviteId = '';

    if (inviteType === 'roster') {
      const { game, role, inGameName, message } = inviteData;
      messageText = `🎮 Team Invitation - ${game} Roster\n\n` +
        `Team: ${team.profile?.displayName || team.username}\n` +
        `Position: ${role || 'Player'}\n` +
        `Game: ${game}\n` +
        (inGameName ? `In-Game Name: ${inGameName}\n` : '') +
        (message ? `Message: ${message}\n\n` : '\n') +
        `You've been invited to join our ${game} roster! Please respond to this message with:\n` +
        `• "Accept" - to join the team\n` +
        `• "Decline" - to decline the invitation\n\n` +
        `This invitation will expire in 7 days.`;
      
      inviteId = inviteData.inviteId;
    } else if (inviteType === 'staff') {
      const { role, message } = inviteData;
      messageText = `👥 Staff Invitation\n\n` +
        `Team: ${team.profile?.displayName || team.username}\n` +
        `Role: ${role}\n` +
        (message ? `Message: ${message}\n\n` : '\n') +
        `You've been invited to join our team as ${role}! Please respond to this message with:\n` +
        `• "Accept" - to join the team\n` +
        `• "Decline" - to decline the invitation\n\n` +
        `This invitation will expire in 7 days.`;
      
      inviteId = inviteData.inviteId;
    }

    // Create the message
    const messageData = {
      sender: teamId,
      recipient: playerId,
      messageType: 'direct',
      content: {
        text: messageText,
        media: []
      },
      inviteData: {
        type: inviteType,
        inviteId: inviteId,
        teamId: teamId,
        ...inviteData
      }
    };

    const message = await Message.create(messageData);
    
    // Populate sender and recipient info
    await message.populate([
      { path: 'sender', select: 'username profile.displayName profile.avatar' },
      { path: 'recipient', select: 'username profile.displayName profile.avatar' }
    ]);

    // Use the same durable, preference-aware path as ordinary direct messages.
    await createMessageNotification(playerId, teamId, message._id, {
      conversationId: `direct_${teamId}`,
      chatId: `direct_${teamId}`,
      muteKey: teamId,
      messageKind: 'invite',
      hasMedia: false,
      deepLink: `/conversation/direct_${teamId}`
    });

    return message;
  } catch (error) {
    log.error('Error sending invite message:', { error: String(error) });
    throw error;
  }
};

// Gaming Stats CRUD operations
const addGamingStat = async (req, res) => {
  try {
    const userId = req.user.id;
    const gamingStat = req.body;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Initialize playerInfo if it doesn't exist
    if (!user.playerInfo) {
      user.playerInfo = {};
    }
    if (!user.playerInfo.gamingStats) {
      user.playerInfo.gamingStats = [];
    }

    // Add the new gaming stat
    user.playerInfo.gamingStats.push(gamingStat);
    await user.save();

    res.status(201).json({
      success: true,
      message: 'Gaming stat added successfully',
      data: {
        gamingStat: user.playerInfo.gamingStats[user.playerInfo.gamingStats.length - 1]
      }
    });
  } catch (error) {
    log.error('Error adding gaming stat:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Error adding gaming stat',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

const updateGamingStat = async (req, res) => {
  try {
    const userId = req.user.id;
    const { statId } = req.params;
    const updateData = req.body;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    if (!user.playerInfo || !user.playerInfo.gamingStats) {
      return res.status(404).json({
        success: false,
        message: 'No gaming stats found'
      });
    }

    const statIndex = user.playerInfo.gamingStats.findIndex(stat => stat._id.toString() === statId);
    if (statIndex === -1) {
      return res.status(404).json({
        success: false,
        message: 'Gaming stat not found'
      });
    }

    // Update the gaming stat
    user.playerInfo.gamingStats[statIndex] = {
      ...user.playerInfo.gamingStats[statIndex].toObject(),
      ...updateData
    };

    await user.save();

    res.status(200).json({
      success: true,
      message: 'Gaming stat updated successfully',
      data: {
        gamingStat: user.playerInfo.gamingStats[statIndex]
      }
    });
  } catch (error) {
    log.error('Error updating gaming stat:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Error updating gaming stat',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

const deleteGamingStat = async (req, res) => {
  try {
    const userId = req.user.id;
    const { statId } = req.params;

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    if (!user.playerInfo || !user.playerInfo.gamingStats) {
      return res.status(404).json({
        success: false,
        message: 'No gaming stats found'
      });
    }

    const statIndex = user.playerInfo.gamingStats.findIndex(stat => stat._id.toString() === statId);
    if (statIndex === -1) {
      return res.status(404).json({
        success: false,
        message: 'Gaming stat not found'
      });
    }

    // Remove the gaming stat
    user.playerInfo.gamingStats.splice(statIndex, 1);
    await user.save();

    res.status(200).json({
      success: true,
      message: 'Gaming stat deleted successfully'
    });
  } catch (error) {
    log.error('Error deleting gaming stat:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Error deleting gaming stat',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

const getGamingStats = async (req, res) => {
  try {
    const userId = req.user.id;

    const user = await User.findById(userId).select('playerInfo.gamingStats');
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    const gamingStats = user.playerInfo?.gamingStats || [];

    res.status(200).json({
      success: true,
      data: {
        gamingStats
      }
    });
  } catch (error) {
    log.error('Error getting gaming stats:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Error getting gaming stats',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Sync Clash of Clans player data
const syncClashOfClansData = async (req, res) => {
  try {
    const userId = req.user.id;
    const { playerTag } = req.body;

    if (!playerTag) {
      return res.status(400).json({
        success: false,
        message: 'Player tag is required'
      });
    }

    // Validate player tag format
    const tagRegex = /^#?[A-Z0-9]{8,9}$/i;
    if (!tagRegex.test(playerTag)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid player tag format. Please use format like #ABC123DEF'
      });
    }

    // Fetch player data from Clash of Clans API
    const apiResponse = await clashOfClansAPI.getPlayer(playerTag);
    
    if (!apiResponse.success) {
      return res.status(400).json({
        success: false,
        message: apiResponse.error,
        code: apiResponse.code
      });
    }

    // Format the data for our system
    const formattedData = await clashOfClansAPI.formatPlayerData(apiResponse.data);

    // Find user and update/create Clash of Clans gaming stat
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Initialize playerInfo if it doesn't exist
    if (!user.playerInfo) {
      user.playerInfo = {};
    }
    if (!user.playerInfo.gamingStats) {
      user.playerInfo.gamingStats = [];
    }

    // Check if user already has a Clash of Clans stat
    const existingCoCStatIndex = user.playerInfo.gamingStats.findIndex(
      stat => stat.game === 'Clash of Clans'
    );

    const cocGamingStat = {
      game: 'Clash of Clans',
      ...formattedData
    };

    res.status(200).json({
      success: true,
      message: 'Clash of Clans data fetched successfully',
      data: {
        gamingStat: cocGamingStat,
        existingStatId: existingCoCStatIndex !== -1 ? user.playerInfo.gamingStats[existingCoCStatIndex]._id : null
      }
    });

  } catch (error) {
    log.error('Error syncing Clash of Clans data:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Error syncing Clash of Clans data',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Sync Clash Royale player data
const syncClashRoyaleData = async (req, res) => {
  try {
    const userId = req.user.id;
    const { playerTag } = req.body;

    if (!playerTag) {
      return res.status(400).json({
        success: false,
        message: 'Player tag is required'
      });
    }

    // Validate player tag format
    const tagRegex = /^#?[A-Z0-9]{8,9}$/i;
    if (!tagRegex.test(playerTag)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid player tag format. Please use format like #ABC123DEF'
      });
    }

    // Fetch player data from Clash Royale API
    const apiResponse = await clashRoyaleAPI.getPlayer(playerTag);
    
    if (!apiResponse.success) {
      return res.status(400).json({
        success: false,
        message: apiResponse.error,
        code: apiResponse.code
      });
    }

    // Format the data for our system
    const formattedData = await clashRoyaleAPI.formatPlayerData(apiResponse.data);

    // Find user and update/create Clash Royale gaming stat
    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({
        success: false,
        message: 'User not found'
      });
    }

    // Initialize playerInfo if it doesn't exist
    if (!user.playerInfo) {
      user.playerInfo = {};
    }
    if (!user.playerInfo.gamingStats) {
      user.playerInfo.gamingStats = [];
    }

    // Check if user already has a Clash Royale stat
    const existingCRStatIndex = user.playerInfo.gamingStats.findIndex(
      stat => stat.game === 'Clash Royale'
    );

    const crGamingStat = {
      game: 'Clash Royale',
      ...formattedData
    };

    res.status(200).json({
      success: true,
      message: 'Clash Royale data fetched successfully',
      data: {
        gamingStat: crGamingStat,
        existingStatId: existingCRStatIndex !== -1 ? user.playerInfo.gamingStats[existingCRStatIndex]._id : null
      }
    });

  } catch (error) {
    log.error('Error syncing Clash Royale data:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Error syncing Clash Royale data',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Create team
const createTeam = async (req, res) => {
  try {
    const { username, teamType, members, game, tournamentId } = req.body;
    const currentUserId = req.user._id;

    if (process.env.NODE_ENV === 'development') { console.log('Creating team with data:', { username, teamType, members, game, tournamentId });
}
    // Validate required fields
    if (!username || !members || !Array.isArray(members) || members.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Username and at least one member are required'
      });
    }

    // Create a unique team username (max 20 chars)
    const timestamp = Date.now().toString().slice(-8); // Last 8 digits
    const random = Math.random().toString(36).substr(2, 4); // 4 chars
    const teamUsername = `duo_${timestamp}_${random}`; // Max 15 chars

    // Check if team username already exists (very unlikely but safe)
    const existingUser = await User.findOne({ username: teamUsername });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        message: 'Team username already exists, please try again'
      });
    }

    // Create team user
    const teamData = {
      username: teamUsername,
      email: `${teamUsername}@team.com`,
      password: 'team123', // Temporary password
      userType: 'team',
      profile: {
        displayName: username, // Use the provided team name as display name
        bio: `Duo team for ${game || 'tournament'}`,
        location: '',
        website: ''
      },
      teamInfo: {
        teamSize: 2, // Duo team always has 2 members
        recruitingFor: [],
        requirements: '',
        teamType: 'casual',
        members: [
          {
            user: currentUserId,
            role: 'Player 1',
            joinedAt: new Date()
          }
        ],
        rosters: [], // Initialize empty rosters array
        staff: [] // Initialize empty staff array
      }
    };

    // Add the duo partner
    if (members && members.length > 0) {
      const memberId = members[0]; // Take first member for duo
      const member = await User.findById(memberId);
      if (member) {
        teamData.teamInfo.members.push({
          user: memberId,
          role: 'Player 2',
          joinedAt: new Date()
        });
      }
    }

    if (process.env.NODE_ENV === 'development') { console.log('Creating team with data:', teamData);}
    const team = await User.create(teamData);
    if (process.env.NODE_ENV === 'development') { console.log('Team created successfully:', team._id);
}
    // Add team to both users' joined teams
    const allMembers = [...new Set([currentUserId, ...(members || [])])]; // Remove duplicates
    
    for (const memberId of allMembers) {
      try {
        const member = await User.findById(memberId);
        if (member && member.playerInfo) {
          if (!member.playerInfo.joinedTeams) {
            member.playerInfo.joinedTeams = [];
          }
          member.playerInfo.joinedTeams.push({
            team: team._id,
            game: game || 'General',
            role: memberId === currentUserId ? 'Player 1' : 'Player 2',
            inGameName: null,
            joinedAt: new Date(),
            leftAt: null,
            isActive: true
          });
          await member.save();
          if (process.env.NODE_ENV === 'development') { console.log(`Added team to user ${memberId}`);}
        }
      } catch (memberError) {
        console.error(`Error updating member ${memberId}:`, memberError);
        // Continue with other members even if one fails
      }
    }

    // If tournamentId is provided, add team to tournament
    if (tournamentId) {
      try {
        const Tournament = require('../models/Tournament');
        const tournament = await Tournament.findById(tournamentId);
        
        if (tournament) {
          // Add team to tournament's teams array
          tournament.teams.push(team._id);
          
          // For duo tournaments, we don't add individual users to participants
          // because the team itself is the participant. Individual users get
          // participant view through team membership check in frontend.
          if (process.env.NODE_ENV === 'development') { console.log('Team added to tournament. Individual users not added to participants for duo format.');
          }
          await tournament.save();
          if (process.env.NODE_ENV === 'development') { console.log(`Added team and members to tournament ${tournamentId}. Participants:`, tournament.participants);}
        } else {
          console.error(`Tournament ${tournamentId} not found`);
        }
      } catch (tournamentError) {
        console.error(`Error updating tournament ${tournamentId}:`, tournamentError);
        // Don't fail the entire operation if tournament update fails
      }
    }

    res.status(201).json({
      success: true,
      message: 'Duo team created successfully',
      data: {
        team: {
          _id: team._id,
          username: team.username,
          profile: team.profile,
          teamInfo: team.teamInfo
        }
      }
    });

  } catch (error) {
    log.error('Error creating team:', { error: String(error) });
    
    // Handle validation errors specifically
    if (error.name === 'ValidationError') {
      const validationErrors = Object.values(error.errors).map(err => err.message);
      return res.status(400).json({
        success: false,
        message: 'Validation failed',
        errors: validationErrors
      });
    }
    
    res.status(500).json({
      success: false,
      message: 'Failed to create team',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Send leave request
const sendLeaveRequest = async (req, res) => {
  try {
    const { teamId } = req.params;
    const { game, reason } = req.body;
    const userId = req.user._id;

    // Verify the team exists
    const team = await User.findById(teamId);
    if (!team || team.userType !== 'team') {
      return res.status(404).json({
        success: false,
        message: 'Team not found'
      });
    }

    // Verify the player exists
    const player = await User.findById(userId);
    if (!player || player.userType !== 'player') {
      return res.status(404).json({
        success: false,
        message: 'Player not found'
      });
    }

    // Ensure teamInfo exists
    if (!team.teamInfo) {
      team.teamInfo = { rosters: [], staff: [] };
    }
    if (!team.teamInfo.rosters) {
      team.teamInfo.rosters = [];
    }
    if (!team.teamInfo.staff) {
      team.teamInfo.staff = [];
    }

    // Check if it's a staff member leave request
    // First check if user is in staff array (most reliable method)
    const userInStaff = team.teamInfo.staff.find(s => {
      const staffUserId = s.user ? (s.user._id ? s.user._id.toString() : s.user.toString()) : null;
      return staffUserId === userId.toString() && s.isActive !== false;
    });
    
    // Determine if this is a staff request
    // Priority: 1. User in staff array, 2. Game field is 'Staff' or 'General'
    const isStaffRequest = !!userInStaff || game === 'Staff' || game === 'General';
    
    log.debug('Leave request check:', {
      teamId: teamId.toString(),
      userId: userId.toString(),
      game,
      userInStaff: !!userInStaff,
      isStaffRequest
    });
    
    if (isStaffRequest) {
      // Handle staff member leave request
      const staffMember = team.teamInfo.staff.find(s => {
        const staffUserId = s.user ? (s.user._id ? s.user._id.toString() : s.user.toString()) : null;
        return staffUserId === userId.toString() && s.isActive !== false;
      });

      if (!staffMember) {
        return res.status(404).json({
          success: false,
          message: 'You are not a staff member of this team'
        });
      }

      // Check if there's already a pending leave request for staff
      // Use player field and game='General' for staff leave requests
      const existingRequest = await LeaveRequest.findOne({
        team: teamId,
        player: userId,
        game: 'General',
        status: 'pending'
      });

      if (existingRequest) {
        return res.status(400).json({
          success: false,
          message: 'You already have a pending leave request for this team'
        });
      }

      // Create leave request for staff
      const leaveReason = reason && reason.trim() ? reason.trim() : 'No reason provided';
      
      // For staff, use 'General' as game and player field (not staffMember)
      const leaveRequest = new LeaveRequest({
        team: teamId,
        player: userId, // Use player field even for staff
        game: 'General', // Use 'General' for staff leave requests
        reason: leaveReason
      });

      await leaveRequest.save();

      // Update staff member's leave request status
      staffMember.leaveRequestStatus = 'pending';
      team.markModified('teamInfo.staff');
      await team.save();

      // Send notification to team owner
      await createAndEmitNotification({
        recipient: team._id,
        sender: userId,
        type: 'system',
        title: 'Leave Request',
        message: `${player.profile?.displayName || player.username} wants to leave as staff member`,
        data: {
          customData: {
            eventType: 'leave_request_created',
            leaveRequestId: leaveRequest._id,
            teamId: team._id,
            game: 'Staff',
            reason: leaveReason
          }
        }
      });

      res.status(201).json({
        success: true,
        message: 'Leave request sent successfully',
        data: { leaveRequest }
      });
      return;
    }

    // Handle roster player leave request
    const roster = team.teamInfo.rosters.find(r => r.game === game);
    if (!roster) {
      return res.status(404).json({
        success: false,
        message: 'Roster not found for this game'
      });
    }

    // Check if player exists in roster (handle both ObjectId and populated user)
    const playerInRoster = roster.players.find(p => {
      const playerUserId = p.user ? (p.user._id ? p.user._id.toString() : p.user.toString()) : null;
      return playerUserId === userId.toString() && p.isActive !== false; // Treat undefined as active
    });

    log.debug('Leave request check:', {
      teamId,
      game,
      userId,
      rosterPlayersCount: roster.players.length,
      rosterPlayers: roster.players.map(p => ({
        userId: p.user ? (p.user._id ? p.user._id.toString() : p.user.toString()) : 'null',
        isActive: p.isActive,
        role: p.role
      })),
      playerFound: !!playerInRoster
    });

    if (!playerInRoster) {
      return res.status(400).json({
        success: false,
        message: 'You are not a member of this roster'
      });
    }

    // Check if there's already a pending leave request
    const existingRequest = await LeaveRequest.findOne({
      team: teamId,
      player: userId,
      game,
      status: 'pending'
    });

    if (existingRequest) {
      return res.status(400).json({
        success: false,
        message: 'You already have a pending leave request for this roster'
      });
    }

    // Create leave request for roster player
    // Use default reason if empty or not provided
    const leaveReason = reason && reason.trim() ? reason.trim() : 'No reason provided';
    
    const leaveRequest = new LeaveRequest({
      team: teamId,
      player: userId,
      game,
      reason: leaveReason
    });

    await leaveRequest.save();

    // Send notification to team owner
    await createAndEmitNotification({
      recipient: team._id,
      sender: userId,
      type: 'system',
      title: 'Leave Request',
      message: `${player.profile?.displayName || player.username} wants to leave the ${game} roster`,
      data: {
        customData: {
          eventType: 'leave_request_created',
          leaveRequestId: leaveRequest._id,
          teamId: team._id,
          game,
          reason: leaveReason
        }
      }
    });

    res.status(201).json({
      success: true,
      message: 'Leave request sent successfully',
      data: { leaveRequest }
    });

  } catch (error) {
    log.error('Error sending leave request:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to send leave request',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get team leave requests (for team owner)
const getTeamLeaveRequests = async (req, res) => {
  try {
    const { teamId } = req.params;
    const userId = req.user._id;

    // Verify the team exists and current user is the team owner
    const team = await User.findById(teamId);
    if (!team || team.userType !== 'team') {
      return res.status(404).json({
        success: false,
        message: 'Team not found'
      });
    }

    if (team._id.toString() !== userId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Only team owners can view leave requests'
      });
    }

    const leaveRequests = await LeaveRequest.find({ team: teamId })
      .populate('player', 'username profile.displayName profile.avatar')
      .populate('reviewedBy', 'username profile.displayName')
      .sort({ requestedAt: -1 });

    log.debug('Fetched leave requests:', {
      teamId,
      count: leaveRequests.length,
      requests: leaveRequests.map(r => ({
        id: r._id,
        player: r.player?.username,
        game: r.game,
        status: r.status
      }))
    });

    res.status(200).json({
      success: true,
      data: { leaveRequests }
    });

  } catch (error) {
    log.error('Error fetching leave requests:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to fetch leave requests',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Approve leave request
const approveLeaveRequest = async (req, res) => {
  try {
    const { requestId } = req.params;
    const { reviewNotes } = req.body;
    const userId = req.user._id;

    const leaveRequest = await LeaveRequest.findById(requestId)
      .populate('team', 'username profile.displayName teamInfo')
      .populate('player', 'username profile.displayName userType playerInfo');

    if (!leaveRequest) {
      return res.status(404).json({
        success: false,
        message: 'Leave request not found'
      });
    }

    // Verify current user is the team owner
    const teamId = leaveRequest.team._id ? leaveRequest.team._id.toString() : leaveRequest.team.toString();
    if (teamId !== userId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Only team owners can approve leave requests'
      });
    }

    if (leaveRequest.status !== 'pending') {
      return res.status(400).json({
        success: false,
        message: 'Leave request has already been processed'
      });
    }

    // Update leave request status
    leaveRequest.status = 'approved';
    leaveRequest.reviewedAt = new Date();
    leaveRequest.reviewedBy = userId;
    if (reviewNotes !== undefined) {
      leaveRequest.reviewNotes = reviewNotes || '';
    }
    
    try {
    await leaveRequest.save();
    } catch (saveError) {
      // If it's a duplicate key error due to old index, try to update directly
      if (saveError.code === 11000) {
        if (process.env.NODE_ENV === 'development') { console.log('Duplicate key error detected, updating directly...');}
        await LeaveRequest.findByIdAndUpdate(requestId, {
          status: 'approved',
          reviewedAt: new Date(),
          reviewedBy: userId,
          reviewNotes: reviewNotes || ''
        });
      } else {
        throw saveError;
      }
    }

    // Re-fetch team with full data to ensure we have the latest info
    const teamIdForFetch = leaveRequest.team._id ? leaveRequest.team._id.toString() : leaveRequest.team.toString();
    const team = await User.findById(teamIdForFetch);
    if (!team || !team.teamInfo) {
      throw new Error('Team not found or teamInfo missing');
    }
    
    const playerIdForFetch = leaveRequest.player._id ? leaveRequest.player._id.toString() : leaveRequest.player.toString();
    
    // Check if it's a staff member leave request (game === 'General' and user is in staff array)
    const isStaffLeaveRequest = leaveRequest.game === 'General' || leaveRequest.game === 'Staff';
    let isActuallyStaff = false;
    
    if (isStaffLeaveRequest && team.teamInfo.staff) {
      const staffMember = team.teamInfo.staff.find(s => {
        const staffUserId = s.user ? (s.user._id ? s.user._id.toString() : s.user.toString()) : null;
        return staffUserId === playerIdForFetch && s.isActive !== false;
      });
      if (staffMember) {
        isActuallyStaff = true;
      }
    }
    
    if (isActuallyStaff) {
      // Handle staff member removal
      const staffMember = team.teamInfo.staff.find(s => {
        const staffUserId = s.user ? (s.user._id ? s.user._id.toString() : s.user.toString()) : null;
        return staffUserId === playerIdForFetch && s.isActive !== false;
      });
      
      if (staffMember) {
        staffMember.isActive = false;
        staffMember.leftAt = new Date();
        staffMember.leaveRequestStatus = 'approved';
        team.markModified('teamInfo.staff');
        await team.save();
        if (process.env.NODE_ENV === 'development') { console.log('Staff member removed from team:', playerIdForFetch);}
      }
    } else {
      // Handle roster player removal
      if (!team.teamInfo.rosters) {
        team.teamInfo.rosters = [];
      }
      
      const roster = team.teamInfo.rosters.find(r => r.game === leaveRequest.game);
      if (roster) {
        const playerIndex = roster.players.findIndex(p => {
          const pUserId = p.user ? (p.user._id ? p.user._id.toString() : p.user.toString()) : null;
          return pUserId === playerIdForFetch && p.isActive !== false;
        });
        
        if (playerIndex !== -1) {
          roster.players[playerIndex].isActive = false;
          roster.players[playerIndex].leftAt = new Date();
          team.markModified('teamInfo.rosters');
          await team.save();
        }
      }
    }

    // Remove team from player's joinedTeams
    // Re-fetch player with full data
    const player = await User.findById(playerIdForFetch);
    
    if (player && player.userType === 'player') {
      if (!player.playerInfo) {
        player.playerInfo = {};
      }
      if (!player.playerInfo.joinedTeams) {
        player.playerInfo.joinedTeams = [];
      }
      
      const teamIdStr = team._id.toString();
      
      // For staff, find by team and game='Staff' or 'General'
      // For roster, find by team and specific game
      const teamMembership = player.playerInfo.joinedTeams.find(
        teamRef => {
          const refTeamId = teamRef.team ? (teamRef.team._id ? teamRef.team._id.toString() : teamRef.team.toString()) : null;
          if (refTeamId !== teamIdStr) return false;
          
          if (isActuallyStaff) {
            // For staff, match 'Staff' or 'General' game
            return teamRef.game === 'Staff' || teamRef.game === 'General';
          } else {
            // For roster, match specific game
            return teamRef.game === leaveRequest.game;
          }
        }
      );
      
      if (teamMembership) {
        teamMembership.isActive = false;
        teamMembership.leftAt = new Date();
        player.markModified('playerInfo.joinedTeams');
        await player.save();
        if (process.env.NODE_ENV === 'development') { console.log('Team membership updated for player:', playerIdForFetch);
        }
        // Emit socket event to notify player about removal
        const io = req.app.get('io');
        if (io) {
          io.to(`user-${playerIdForFetch}`).emit('profile-updated', {
            type: 'team-membership-updated',
            message: 'Your leave request has been approved',
            teamId: teamIdStr
          });
        }
      }
    }

    // Send notification to player
    const playerIdForNotif = leaveRequest.player._id ? leaveRequest.player._id.toString() : leaveRequest.player.toString();

    await createAndEmitNotification({
      recipient: playerIdForNotif,
      sender: userId,
      type: 'system',
      title: 'Leave Request Approved',
      message: `Your leave request from ${team.profile?.displayName || team.username} has been approved`,
      data: {
        customData: {
          eventType: 'leave_request_response',
          leaveRequestId: leaveRequest._id,
          teamId: team._id,
          game: leaveRequest.game,
          status: 'approved'
        }
      }
    });

    res.status(200).json({
      success: true,
      message: 'Leave request approved successfully'
    });

  } catch (error) {
    log.error('Error approving leave request:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to approve leave request',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Reject leave request
const rejectLeaveRequest = async (req, res) => {
  try {
    const { requestId } = req.params;
    const { reviewNotes } = req.body;
    const userId = req.user._id;

    const leaveRequest = await LeaveRequest.findById(requestId)
      .populate('team player');

    if (!leaveRequest) {
      return res.status(404).json({
        success: false,
        message: 'Leave request not found'
      });
    }

    // Verify current user is the team owner
    if (leaveRequest.team._id.toString() !== userId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Only team owners can reject leave requests'
      });
    }

    if (leaveRequest.status !== 'pending') {
      return res.status(400).json({
        success: false,
        message: 'Leave request has already been processed'
      });
    }

    // Update leave request status
    leaveRequest.status = 'rejected';
    leaveRequest.reviewedAt = new Date();
    leaveRequest.reviewedBy = userId;
    leaveRequest.reviewNotes = reviewNotes || '';
    await leaveRequest.save();

    // Send notification to player
    await createAndEmitNotification({
      recipient: leaveRequest.player._id,
      sender: userId,
      type: 'system',
      title: 'Leave Request Rejected',
      message: `Your leave request from ${leaveRequest.team.profile?.displayName || leaveRequest.team.username} has been rejected`,
      data: {
        customData: {
          eventType: 'leave_request_response',
          leaveRequestId: leaveRequest._id,
          teamId: leaveRequest.team._id,
          game: leaveRequest.game,
          status: 'rejected',
          reviewNotes: reviewNotes || ''
        }
      }
    });

    res.status(200).json({
      success: true,
      message: 'Leave request rejected successfully'
    });

  } catch (error) {
    log.error('Error rejecting leave request:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to reject leave request',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Block a user (by username)
const blockUser = async (req, res) => {
  try {
    const currentUserId = req.user._id;
    const targetUsername = (req.params.username || '').trim();
    if (!targetUsername) {
      return res.status(400).json({ success: false, message: 'Username is required' });
    }
    const targetUser = await User.findOne({ username: targetUsername });
    if (!targetUser) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    const targetUserId = targetUser._id.toString();
    if (currentUserId.toString() === targetUserId) {
      return res.status(400).json({ success: false, message: 'You cannot block yourself' });
    }
    const currentUser = await User.findById(currentUserId);
    if (!currentUser.blockedUsers) currentUser.blockedUsers = [];
    if (currentUser.blockedUsers.some(id => id.toString() === targetUserId)) {
      return res.status(400).json({ success: false, message: 'User is already blocked' });
    }
    currentUser.blockedUsers.push(targetUser._id);
    currentUser.following = (currentUser.following || []).filter(id => id.toString() !== targetUserId);
    currentUser.followers = (currentUser.followers || []).filter(id => id.toString() !== targetUserId);
    targetUser.followers = (targetUser.followers || []).filter(id => id.toString() !== currentUserId.toString());
    targetUser.following = (targetUser.following || []).filter(id => id.toString() !== currentUserId.toString());
    await Promise.all([
      currentUser.save(),
      targetUser.save(),
      Follow.deleteMany({
        $or: [
          { follower: currentUserId, following: targetUserId },
          { follower: targetUserId, following: currentUserId }
        ]
      }),
      FollowRequest.updateMany(
        {
          status: 'pending',
          $or: [
            { requester: currentUserId, target: targetUserId },
            { requester: targetUserId, target: currentUserId }
          ]
        },
        { $set: { status: 'cancelled', resolvedAt: new Date() } }
      )
    ]);
    await invalidateFollowCaches(currentUserId, targetUserId);
    const presenceIo = req.app?.get?.('io') || global._arcSocketIO;
    removePresenceSubscription(presenceIo, currentUserId, targetUserId);
    removePresenceSubscription(presenceIo, targetUserId, currentUserId);
    res.status(200).json({ success: true, message: 'User blocked' });
  } catch (error) {
    log.error('Block user error:', { error: String(error) });
    res.status(500).json({ success: false, message: 'Failed to block user', error: process.env.NODE_ENV === 'development' ? error.message : undefined });
  }
};

// Unblock a user (by username)
const unblockUser = async (req, res) => {
  try {
    const currentUserId = req.user._id;
    const targetUsername = (req.params.username || '').trim();
    if (!targetUsername) {
      return res.status(400).json({ success: false, message: 'Username is required' });
    }
    const targetUser = await User.findOne({ username: targetUsername });
    if (!targetUser) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    const targetUserId = targetUser._id.toString();
    const currentUser = await User.findById(currentUserId);
    if (!currentUser.blockedUsers) currentUser.blockedUsers = [];
    currentUser.blockedUsers = currentUser.blockedUsers.filter(id => id.toString() !== targetUserId);
    await currentUser.save();
    await invalidateFollowCaches(currentUserId, targetUserId);
    res.status(200).json({ success: true, message: 'User unblocked' });
  } catch (error) {
    log.error('Unblock user error:', { error: String(error) });
    res.status(500).json({ success: false, message: 'Failed to unblock user', error: process.env.NODE_ENV === 'development' ? error.message : undefined });
  }
};

// Get list of blocked users
const getBlockedUsers = async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
      .populate('blockedUsers', 'username profile.displayName profile.avatar')
      .select('blockedUsers')
      .lean();
    const list = user?.blockedUsers || [];
    res.status(200).json({ success: true, data: { blockedUsers: list } });
  } catch (error) {
    log.error('Get blocked users error:', { error: String(error) });
    res.status(500).json({ success: false, message: 'Failed to fetch blocked users', error: process.env.NODE_ENV === 'development' ? error.message : undefined });
  }
};

// Proxy external avatar URLs (e.g. Gmail/Google) so they load in the app (avoids CORS/hotlink blocks)
const axios = require('axios');

const getAvatar = async (req, res) => {
  try {
    const { userId } = req.params;
    const user = await User.findById(userId).select('profile.avatar profilePicture').lean();
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    const avatarUrl = user.profile?.avatar || user.profilePicture;
    if (!avatarUrl || typeof avatarUrl !== 'string') {
      return res.status(404).json({ success: false, message: 'No avatar' });
    }
    const trimmed = avatarUrl.trim();
    if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
      return res.status(400).json({ success: false, message: 'Avatar is not an external URL' });
    }
    const response = await axios({
      method: 'get',
      url: trimmed,
      responseType: 'stream',
      timeout: 10000,
      maxRedirects: 3,
      headers: { 'User-Agent': 'ARC-App/1.0' }
    });
    const contentType = response.headers['content-type'] || 'image/jpeg';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    response.data.pipe(res);
  } catch (err) {
    if (err.response?.status) {
      res.status(err.response.status).json({ success: false, message: 'Failed to fetch avatar' });
    } else {
      res.status(500).json({ success: false, message: 'Failed to fetch avatar', error: err.message });
    }
  }
};

// Get privacy settings for the authenticated user
const getPrivacySettings = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('privacySettings').lean();
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });
    return res.status(200).json(privacySettingsResponse(user.privacySettings, {
      whoCanAddToGroup: user.privacySettings?.whoCanAddToGroup || 'anyone'
    }));
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch privacy settings' });
  }
};

// Update privacy settings for the authenticated user
const updatePrivacySettings = async (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ success: false, message: 'Privacy settings must be an object' });
    }
    if (Object.keys(req.body).length === 0) {
      return res.status(400).json({ success: false, message: 'At least one privacy setting is required' });
    }
    const allowedKeys = new Set([
      'profileVisibility', 'allowMessageFrom', 'showOnlineStatus',
      'allowFollowRequests', 'showPostsToFollowers',
      'accountType', 'whoCanMessage', 'showActivityStatus', 'whoCanAddToGroup'
    ]);
    const unknownKey = Object.keys(req.body).find((key) => !allowedKeys.has(key));
    if (unknownKey) {
      return res.status(400).json({ success: false, message: `Unknown privacy setting: ${unknownKey}` });
    }

    const currentUser = await User.findById(req.user._id).select('username privacySettings');
    if (!currentUser) return res.status(404).json({ success: false, message: 'User not found' });
    const current = normalizePrivacySettings(currentUser.privacySettings);
    const incomingCanonical = {
      ...current,
      ...(req.body.profileVisibility !== undefined
        ? { profileVisibility: req.body.profileVisibility }
        : req.body.accountType !== undefined ? { profileVisibility: req.body.accountType } : {}),
      ...(req.body.allowMessageFrom !== undefined
        ? { allowMessageFrom: req.body.allowMessageFrom }
        : req.body.whoCanMessage !== undefined ? { allowMessageFrom: req.body.whoCanMessage } : {}),
      ...(req.body.showOnlineStatus !== undefined
        ? { showOnlineStatus: req.body.showOnlineStatus }
        : req.body.showActivityStatus !== undefined ? { showOnlineStatus: req.body.showActivityStatus } : {}),
      ...(req.body.allowFollowRequests !== undefined ? { allowFollowRequests: req.body.allowFollowRequests } : {}),
      ...(req.body.showPostsToFollowers !== undefined ? { showPostsToFollowers: req.body.showPostsToFollowers } : {})
    };

    if (!PROFILE_VISIBILITY.includes(String(incomingCanonical.profileVisibility))) {
      return res.status(400).json({ success: false, message: "profileVisibility must be 'public', 'followers', or 'private'" });
    }
    if (!MESSAGE_AUDIENCE.includes(String(incomingCanonical.allowMessageFrom))) {
      const legacyAllowed = ['anyone', 'people_you_follow', 'nobody'];
      if (!legacyAllowed.includes(String(incomingCanonical.allowMessageFrom))) {
        return res.status(400).json({ success: false, message: "allowMessageFrom must be 'everyone', 'followers', or 'none'" });
      }
    }
    for (const key of ['showOnlineStatus', 'allowFollowRequests', 'showPostsToFollowers']) {
      if (typeof incomingCanonical[key] !== 'boolean') {
        return res.status(400).json({ success: false, message: `${key} must be a boolean` });
      }
    }

    const canonical = normalizePrivacySettings(incomingCanonical);
    const legacy = canonicalToLegacyAliases(canonical);
    const update = {};
    Object.entries(canonical).forEach(([key, value]) => { update[`privacySettings.${key}`] = value; });
    Object.entries(legacy).forEach(([key, value]) => { update[`privacySettings.${key}`] = value; });

    if (req.body.whoCanAddToGroup !== undefined) {
      if (!['anyone', 'people_you_follow', 'nobody'].includes(req.body.whoCanAddToGroup)) {
        return res.status(400).json({ success: false, message: "whoCanAddToGroup must be 'anyone', 'people_you_follow', or 'nobody'" });
      }
      update['privacySettings.whoCanAddToGroup'] = req.body.whoCanAddToGroup;
    }

    const user = await User.findByIdAndUpdate(
      req.user._id,
      { $set: update },
      { new: true, runValidators: true }
    ).select('username privacySettings');

    await Promise.all([
      invalidateUserCache(req.user._id),
      invalidateProfileCache(req.user._id, user?.username)
    ]);
    const io = req.app?.get?.('io') || global._arcSocketIO;
    publishPrivacySettingsUpdate(io, req.user._id);
    evictPresenceAudience(io, req.user._id);

    return res.status(200).json(privacySettingsResponse(user.privacySettings, {
      whoCanAddToGroup: user.privacySettings?.whoCanAddToGroup || 'anyone'
    }));
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to update privacy settings' });
  }
};

const getFollowRequests = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const filter = { target: req.user._id, status: 'pending' };
    const requesterIds = await FollowRequest.find(filter).distinct('requester');
    const activeRequesterIds = await User.find({ _id: { $in: requesterIds }, isActive: true }).distinct('_id');
    await FollowRequest.updateMany(
      { ...filter, requester: { $nin: activeRequesterIds } },
      { $set: { status: 'cancelled', resolvedAt: new Date() } }
    );
    const [requests, total] = await Promise.all([
      FollowRequest.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate({
          path: 'requester',
          match: { isActive: true },
          select: 'username userType profile.displayName profile.avatar'
        })
        .lean(),
      FollowRequest.countDocuments(filter)
    ]);
    return res.json({
      success: true,
      data: {
        requests: requests.filter((request) => request.requester),
        pagination: { current: page, total: Math.ceil(total / limit), count: requests.filter((request) => request.requester).length, totalRequests: total }
      }
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to fetch follow requests' });
  }
};

const resolveFollowRequest = async (req, res, status) => {
  try {
    const resolvedAt = new Date();
    const request = await FollowRequest.findOneAndUpdate({
      _id: req.params.requestId,
      target: req.user._id,
      status: 'pending'
    }, {
      $set: { status, resolvedAt }
    }, { new: true });
    if (!request) return res.status(404).json({ success: false, message: 'Follow request not found' });

    if (status === 'accepted') {
      const requesterStillActive = await User.exists({ _id: request.requester, isActive: true });
      if (!requesterStillActive) {
        request.status = 'cancelled';
        await request.save();
        return res.status(404).json({ success: false, message: 'Follow request not found' });
      }
      try {
        await persistFollow(request.requester, request.target);
      } catch (error) {
        await FollowRequest.updateOne(
          { _id: request._id, status: 'accepted', resolvedAt },
          { $set: { status: 'pending' }, $unset: { resolvedAt: 1 } }
        );
        throw error;
      }
    }
    await invalidateFollowCaches(request.requester, request.target);

    if (status === 'accepted') {
      await createAndEmitNotification({
        recipient: request.requester,
        sender: request.target,
        type: 'follow',
        title: 'Follow request accepted',
        message: `${req.user.profile?.displayName || req.user.username || 'Someone'} accepted your follow request.`,
        data: {
          deepLink: `/user/${req.user.username}`,
          customData: {
            eventType: 'follow_acceptance',
            followRequestId: String(request._id),
            notificationDedupeKey: `follow-accepted:${request._id}`,
            pushRequestId: `follow-accepted:${request._id}`
          }
        }
      }).catch(() => {});
    }

    return res.json({
      success: true,
      data: { requestId: request._id, status, isFollowing: status === 'accepted' }
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to update follow request' });
  }
};

const acceptFollowRequest = (req, res) => resolveFollowRequest(req, res, 'accepted');
const rejectFollowRequest = (req, res) => resolveFollowRequest(req, res, 'rejected');

const notificationSettingDefaults = {
  pushEnabled: true,
  inAppEnabled: true,
  likes: true,
  comments: true,
  follows: true,
  messages: true,
  tournamentUpdates: true,
  scrimUpdates: true,
  recruitmentApps: true,
  systemAlerts: true,
  marketingEnabled: true,
  announcementsEnabled: true,
  promotionsEnabled: true,
  mutedBroadcastCategories: []
};

const normalizeNotificationSettings = (settings) => ({
  ...notificationSettingDefaults,
  ...(settings?.toObject ? settings.toObject() : settings || {})
});

const getNotificationSettings = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('notificationSettings').lean();
    return res.status(200).json({
      success: true,
      data: normalizeNotificationSettings(user?.notificationSettings)
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to get notification settings' });
  }
};

const updateNotificationSettings = async (req, res) => {
  try {
    const allowedBooleanKeys = Object.keys(notificationSettingDefaults)
      .filter((key) => key !== 'mutedBroadcastCategories');
    const allowedKeys = new Set([...allowedBooleanKeys, 'mutedBroadcastCategories']);
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({ success: false, message: 'Notification settings must be an object' });
    }
    const unknownKeys = Object.keys(req.body).filter((key) => !allowedKeys.has(key));
    if (unknownKeys.length) {
      return res.status(400).json({ success: false, message: `Unknown notification setting: ${unknownKeys[0]}` });
    }
    const update = {};

    allowedBooleanKeys.forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(req.body, key) && typeof req.body[key] !== 'boolean') {
        update.__invalidBooleanKey = key;
      } else if (typeof req.body?.[key] === 'boolean') {
        update[`notificationSettings.${key}`] = req.body[key];
      }
    });
    if (update.__invalidBooleanKey) {
      return res.status(400).json({ success: false, message: `${update.__invalidBooleanKey} must be a boolean` });
    }

    if (Array.isArray(req.body?.mutedBroadcastCategories)) {
      const allowedCategories = new Set([
        'announcement', 'update', 'maintenance', 'feature_release', 'tournament',
        'recruitment', 'promotion', 'creator', 'premium', 'system', 'custom'
      ]);
      const normalizedCategories = req.body.mutedBroadcastCategories
        .map((category) => typeof category === 'string' ? category.trim().toLowerCase() : '');
      if (normalizedCategories.some((category) => !allowedCategories.has(category))) {
        return res.status(400).json({ success: false, message: 'mutedBroadcastCategories contains an invalid category' });
      }
      const categories = Array.from(new Set(normalizedCategories));
      update['notificationSettings.mutedBroadcastCategories'] = categories;
    } else if (Object.prototype.hasOwnProperty.call(req.body, 'mutedBroadcastCategories')) {
      return res.status(400).json({ success: false, message: 'mutedBroadcastCategories must be an array' });
    }

    delete update.__invalidBooleanKey;

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ success: false, message: 'At least one notification setting is required' });
    }

    const user = await User.findByIdAndUpdate(
      req.user._id,
      { $set: update },
      { new: true, runValidators: true }
    ).select('notificationSettings');

    return res.status(200).json({
      success: true,
      data: normalizeNotificationSettings(user?.notificationSettings)
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to update notification settings' });
  }
};

const getDmPrivacy = async (req, res) => {
  try {
    const targetUserId = req.params.userId;
    const callerId = req.user._id;

    const targetUser = await User.findById(targetUserId)
      .select('username userType profile privacySettings blockedUsers isActive');
    if (!targetUser || !targetUser.isActive) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }
    const { Message } = require('../models/Message');
    const existingConversation = Boolean(await Message.exists({
      messageType: 'direct',
      isDeleted: false,
      $or: [
        { sender: targetUserId, recipient: callerId },
        { sender: callerId, recipient: targetUserId }
      ]
    }));
    const relationship = await resolvePrivacyAccess({ viewer: req.user, targetUser, existingConversation });
    const reason = relationship.access.canMessage
      ? existingConversation ? 'existing_conversation' : 'allowed'
      : relationship.blocked
        ? 'blocked'
        : relationship.settings.allowMessageFrom === 'followers' ? 'not_follower' : 'messages_disabled';
    return res.status(200).json({
      success: true,
      canMessage: relationship.access.canMessage,
      code: relationship.access.canMessage ? 'MESSAGE_ALLOWED' : 'MESSAGE_PRIVACY_RESTRICTED',
      reason,
      privacyAccess: relationship.access
    });
  } catch (error) {
    return res.status(500).json({ success: false, message: 'Failed to get DM privacy' });
  }
};

module.exports = {
  getUsers,
  getUser,
  getAvatar,
  blockUser,
  unblockUser,
  getBlockedUsers,
  getLiveTournamentHistory,
  getUserTournamentHistory,
  toggleFollow,
  getFollowRequests,
  acceptFollowRequest,
  rejectFollowRequest,
  getFollowers,
  getFollowing,
  getUserPosts,
  getUserClips,
  addPlayerToRoster,
  addStaffMember,
  addStaffMemberByUsername,
  removePlayerFromRoster,
  removeStaffMember,
  addTeamToPlayer,
  getTeamPendingInvites,
  getRosterInvites,
  acceptRosterInvite,
  declineRosterInvite,
  cancelRosterInvite,
  cancelStaffInvite,
  cancelStaffInviteByUsername,
  leaveTeam,
  addGamingStat,
  updateGamingStat,
  deleteGamingStat,
  getGamingStats,
  syncClashOfClansData,
  syncClashRoyaleData,
  createTeam,
  sendLeaveRequest,
  getTeamLeaveRequests,
  approveLeaveRequest,
  rejectLeaveRequest,
  getPrivacySettings,
  updatePrivacySettings,
  getNotificationSettings,
  updateNotificationSettings,
  getDmPrivacy
};
