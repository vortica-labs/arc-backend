const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const tournamentHistoryEntrySchema = new mongoose.Schema({
  tournamentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Tournament', required: true },
  teamId:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  teamName:     { type: String, required: true },
  game:         { type: String, required: true },
  tournamentName:      { type: String, required: true },
  tournamentStartDate: { type: Date, required: true },
  tournamentEndDate:   { type: Date, required: true },
  status: {
    type: String,
    enum: ['Upcoming', 'Registration Open', 'Ongoing', 'Completed', 'Cancelled'],
    default: 'Registration Open'
  },
  joinedAt: { type: Date, default: Date.now },
  result: {
    rank:         { type: Number, default: null },
    points:       { type: Number, default: null },
    prizeWon:     { type: Number, default: null },
    specialPrize: { type: String, default: null }
  }
}, { _id: true });

const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: [true, 'Username is required'],
    unique: true,
    trim: true,
    minlength: [3, 'Username must be at least 3 characters'],
    maxlength: [20, 'Username cannot exceed 20 characters'],
    match: [/^[a-zA-Z0-9_]+$/, 'Username can only contain letters, numbers and underscores']
  },
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    match: [/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, 'Please enter a valid email']
  },
  password: {
    type: String,
    required: [true, 'Password is required'],
    minlength: [6, 'Password must be at least 6 characters'],
    select: false
  },
  userType: {
    type: String,
    enum: ['player', 'team', 'admin', 'creator'],
    required: [true, 'User type is required']
  },
  isSuperUser: {
    type: Boolean,
    default: false
  },
  adminRole: {
    type: String,
    enum: ['super_admin', 'admin', 'moderator', 'support', 'finance', 'tournament_manager', 'content_moderator', 'creator_manager'],
    default: undefined,
    index: true
  },
  adminPermissions: [{
    type: String,
    trim: true
  }],
  adminControls: {
    loginDisabled: { type: Boolean, default: false },
    postingDisabled: { type: Boolean, default: false },
    messagingDisabled: { type: Boolean, default: false },
    callsDisabled: { type: Boolean, default: false },
    storiesDisabled: { type: Boolean, default: false },
    clipsDisabled: { type: Boolean, default: false },
    commentsDisabled: { type: Boolean, default: false },
    liveFeaturesDisabled: { type: Boolean, default: false },
    reason: { type: String, default: '', maxlength: 500 },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    updatedAt: { type: Date, default: null }
  },
  moderationStatus: {
    type: String,
    enum: ['active', 'suspended', 'banned', 'soft_deleted'],
    default: 'active',
    index: true
  },
  adminWarnings: [{
    reason: { type: String, default: '', maxlength: 1000 },
    issuedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    issuedAt: { type: Date, default: Date.now }
  }],
  isCreator: {
    type: Boolean,
    default: false
  },
  creatorMonetizationStatus: {
    type: String,
    enum: ['not_eligible', 'eligible', 'pending', 'approved', 'rejected', 'suspended', 'disabled', 'withdrawn'],
    default: 'not_eligible',
    index: true
  },
  creatorCpm: {
    type: Number,
    default: null,
    min: 0
  },
  isPremium: {
    type: Boolean,
    default: false
  },
  isVerifiedHost: {
    type: Boolean,
    default: false
  },
  membership: {
    tier: {
      type: String,
      enum: ['free', 'player_pro', 'player_pro_plus', 'team_pro', 'team_org'],
      default: 'free'
    },
    validUntil: {
      type: Date,
      default: null
    },
    credits: {
      type: Number,
      default: 0,
      min: 0
    }
  },
  profile: {
    displayName: {
      type: String,
      required: [true, 'Display name is required'],
      trim: true
    },
    avatar: {
      type: String,
      default: ''
    },
    banner: {
      type: String,
      default: ''
    },
    bio: {
      type: String,
      maxlength: [500, 'Bio cannot exceed 500 characters'],
      default: ''
    },
    gender: {
      type: String,
      enum: ['', 'male', 'female', 'other', 'prefer_not_to_say'],
      default: ''
    },
    dob: {
      type: Date,
      default: null
    },
    location: {
      type: String,
      default: ''
    },
    website: {
      type: String,
      default: ''
    },
    gamingPreferences: [{
      type: String,
      trim: true
    }],
    socialLinks: {
      discord: {
        type: String,
        default: ''
      },
      steam: {
        type: String,
        default: ''
      },
      twitch: {
        type: String,
        default: ''
      }
    }
  },
  // Player specific fields
  playerInfo: {
    games: [{
      name: String,
      rank: String,
      experience: String
    }],
    achievements: [{
      title: String,
      description: String,
      date: Date
    }],
    gamingStats: [{
      game: {
        type: String,
        required: true
      },
      // BGMI fields
      characterId: String,
      inGameName: String,
      idLevel: Number,
      role: String,
      fdRatio: Number,
      currentTier: String,
      // Clash of Clans fields
      playerTag: String,
      townhallLevel: String,
      trophies: Number,
      bestTrophies: Number,
      warStars: Number,
      attackWins: Number,
      defenseWins: Number,
      clanName: String,
      clanTag: String,
      clanRole: String,
      leagueName: String,
      leagueId: Number,
      builderHallLevel: Number,
      builderBaseTrophies: Number,
      bestBuilderBaseTrophies: Number,
      totalAttacks: Number,
      winRate: Number,
      lastUpdated: Date,
      apiSource: String,
      // Clash Royale fields
      playerTag: String,
      level: Number,
      starPoints: Number,
      expPoints: Number,
      totalExpPoints: Number,
      arena: String,
      arenaId: Number,
      trophies: Number,
      bestTrophies: Number,
      wins: Number,
      losses: Number,
      battleCount: Number,
      threeCrownWins: Number,
      winRate: Number,
      clanName: String,
      clanTag: String,
      clanRole: String,
      clanBadgeId: Number,
      currentSeasonTrophies: Number,
      currentSeasonBestTrophies: Number,
      bestSeasonTrophies: Number,
      bestSeasonId: String,
      currentFavouriteCard: String,
      currentDeck: [{
        name: String,
        level: Number,
        maxLevel: Number,
        count: Number,
        rarity: String,
        elixirCost: Number
      }],
      topCards: [{
        name: String,
        level: Number,
        maxLevel: Number,
        count: Number,
        rarity: String,
        elixirCost: Number
      }],
      totalCards: Number,
      achievementsCount: Number,
      badgesCount: Number,
      // Chess.com fields
      username: String,
      rating: Number,
      title: String,
      puzzleRating: Number,
      // Fortnite fields
      epicUsername: String,
      level: Number,
      wins: Number,
      kd: Number,
      playstyle: String,
      // Valorant fields
      tag: String,
      rank: String,
      rr: Number,
      peakRank: String,
      // Call of Duty Mobile fields
      uid: String,
      // Free Fire Max fields
      // PUBG Mobile fields
      // Rocket League fields
      platform: String,
      mmr: Number,
      // Common fields
    }],
    lookingForTeam: {
      type: Boolean,
      default: false
    },
    preferredRoles: [String],
    skillLevel: {
      type: String,
      enum: ['beginner', 'intermediate', 'advanced', 'professional'],
      default: 'beginner'
    },
    // Team membership info for players
    joinedTeams: [{
      team: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
      },
      game: String,
      role: String,
      inGameName: String,
      joinedAt: {
        type: Date,
        default: Date.now
      },
      leftAt: {
        type: Date,
        default: null
      },
      isActive: {
        type: Boolean,
        default: true
      },
      removedByTeam: {
        type: Boolean,
        default: false
      }
    }],
    tournamentHistory: [tournamentHistoryEntrySchema]
  },
  // Team specific fields
  teamInfo: {
    teamSize: {
      type: Number,
      default: 0
    },
    recruitingFor: [String],
    requirements: {
      type: String,
      default: ''
    },
    teamType: {
      type: String,
      enum: ['casual', 'competitive', 'professional'],
      default: 'casual'
    },
    members: [{
      user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
      },
      role: String,
      joinedAt: {
        type: Date,
        default: Date.now
      }
    }],
    // Game-specific rosters
    rosters: [{
      game: {
        type: String,
        enum: ['BGMI', 'Valorant', 'Free Fire', 'Call of Duty Mobile'],
        required: true
      },
      players: [{
        user: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'User'
        },
        role: {
          type: String,
          enum: [
            // General roles
            'Captain', 'Player', 'Substitute', 'Coach', 'Manager',
            // BGMI roles
            'IGL', 'Assaulter', 'Support', 'Sniper', 'Fragger',
            // Valorant roles
            'Duelist', 'Controller', 'Initiator', 'Sentinel',
            // Free Fire roles
            'Rusher',
            // Call of Duty Mobile roles
            'Assault'
          ],
          default: 'Player'
        },
        inGameName: String,
        joinedAt: {
          type: Date,
          default: Date.now
        },
        leftAt: {
          type: Date,
          default: null
        },
        isActive: {
          type: Boolean,
          default: true
        }
      }],
      isActive: {
        type: Boolean,
        default: true
      }
    }],
    // Team staff
    staff: [{
      user: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
      },
      role: {
        type: String,
        enum: ['Owner', 'Manager', 'Coach', 'Analyst', 'Content Creator'],
        required: true
      },
      game: {
        type: String,
        enum: ['BGMI', 'Valorant', 'Free Fire', 'Call of Duty Mobile', 'General'],
        default: 'General'
      },
      joinedAt: {
        type: Date,
        default: Date.now
      },
      leftAt: {
        type: Date,
        default: null
      },
      isActive: {
        type: Boolean,
        default: true
      },
      leaveRequestStatus: {
        type: String,
        enum: ['none', 'pending', 'approved', 'rejected'],
        default: 'none'
      }
    }]
  },
  followers: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  following: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  blockedUsers: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  posts: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Post'
  }],
  savedPosts: [{
    post: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Post'
    },
    savedAt: {
      type: Date,
      default: Date.now
    }
  }],
  isVerified: {
    type: Boolean,
    default: false
  },
  isActive: {
    type: Boolean,
    default: true
  },
  lastSeen: {
    type: Date,
    default: Date.now
  },
  privacySettings: {
    accountType: {
      type: String,
      enum: ['public', 'private'],
      default: 'public'
    },
    whoCanMessage: {
      type: String,
      enum: ['anyone', 'people_you_follow', 'nobody', 'everyone', 'following', 'followers'],
      default: 'anyone'
    },
    showActivityStatus: {
      type: Boolean,
      default: true
    },
    whoCanAddToGroup: {
      type: String,
      enum: ['anyone', 'people_you_follow', 'nobody'],
      default: 'anyone'
    }
  },
  notificationSettings: {
    pushEnabled: {
      type: Boolean,
      default: true
    },
    inAppEnabled: {
      type: Boolean,
      default: true
    },
    likes: {
      type: Boolean,
      default: true
    },
    comments: {
      type: Boolean,
      default: true
    },
    follows: {
      type: Boolean,
      default: true
    },
    messages: {
      type: Boolean,
      default: true
    },
    tournamentUpdates: {
      type: Boolean,
      default: true
    },
    scrimUpdates: {
      type: Boolean,
      default: true
    },
    recruitmentApps: {
      type: Boolean,
      default: true
    },
    systemAlerts: {
      type: Boolean,
      default: true
    },
    marketingEnabled: {
      type: Boolean,
      default: true
    },
    announcementsEnabled: {
      type: Boolean,
      default: true
    },
    promotionsEnabled: {
      type: Boolean,
      default: true
    },
    mutedBroadcastCategories: [{
      type: String,
      enum: [
        'announcement', 'update', 'maintenance', 'feature_release', 'tournament',
        'recruitment', 'promotion', 'creator', 'premium', 'system', 'custom'
      ]
    }]
  },
  googleId: {
    type: String,
    sparse: true
  },
  appleId: {
    type: String,
    index: true,
    unique: true,
    sparse: true
  },
  needsProfileCompletion: {
    type: Boolean,
    default: false
  },
  mutedChats: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  pushTokens: [{
    token: {
      type: String,
      required: true,
      maxlength: 512
    },
    installationId: {
      type: String,
      default: undefined,
      maxlength: 200
    },
    provider: {
      type: String,
      enum: ['expo'],
      default: 'expo'
    },
    platform: {
      type: String,
      enum: ['ios', 'android', 'web', 'unknown'],
      default: 'unknown'
    },
    deviceName: {
      type: String,
      default: '',
      maxlength: 120
    },
    deviceModel: {
      type: String,
      default: '',
      maxlength: 120
    },
    deviceBrand: {
      type: String,
      default: '',
      maxlength: 120
    },
    manufacturer: {
      type: String,
      default: '',
      maxlength: 120
    },
    deviceType: {
      type: String,
      default: '',
      maxlength: 40
    },
    osName: {
      type: String,
      default: '',
      maxlength: 40
    },
    osVersion: {
      type: String,
      default: '',
      maxlength: 40
    },
    projectId: {
      type: String,
      default: ''
    },
    appVersion: {
      type: String,
      default: '',
      maxlength: 40
    },
    buildVersion: {
      type: String,
      default: '',
      maxlength: 40
    },
    nativeToken: {
      type: {
        type: String,
        default: ''
      },
      data: {
        type: String,
        default: ''
      }
    },
    lastUsedAt: {
      type: Date,
      default: Date.now
    },
    lastDeliveredAt: {
      type: Date,
      default: null
    },
    lastFailedAt: {
      type: Date,
      default: null
    },
    failureCount: {
      type: Number,
      default: 0,
      min: 0
    },
    createdAt: {
      type: Date,
      default: Date.now
    }
  }],
  notificationClients: [{
    clientId: { type: String, required: true, maxlength: 200 },
    platform: {
      type: String,
      enum: ['ios', 'android', 'web', 'unknown'],
      default: 'unknown'
    },
    appVersion: { type: String, default: '', maxlength: 40 },
    notificationPermission: {
      type: String,
      enum: ['granted', 'denied', 'default', 'unsupported', 'unknown'],
      default: 'unknown'
    },
    browserNotificationsSupported: { type: Boolean, default: false },
    lastSeenAt: { type: Date, default: Date.now },
    createdAt: { type: Date, default: Date.now }
  }],
  pinnedChats: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  pinnedGroups: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ChatRoom'
  }]
}, {
  timestamps: true
});

const stripPrivateDeviceFields = (_document, value) => {
  delete value.password;
  delete value.pushTokens;
  delete value.notificationClients;
  return value;
};
userSchema.set('toJSON', { transform: stripPrivateDeviceFields });
userSchema.set('toObject', { transform: stripPrivateDeviceFields });

// Index for better search performance
userSchema.index({ username: 1, email: 1 });
userSchema.index({ 'profile.displayName': 1 });
userSchema.index({ userType: 1 });
userSchema.index({ 'playerInfo.tournamentHistory.tournamentId': 1 });
userSchema.index({ 'playerInfo.tournamentHistory.status': 1 });
// Compound indexes for hot-path queries at scale
userSchema.index({ isActive: 1, username: 1 }); // user list + search
userSchema.index({ isActive: 1, createdAt: -1 }); // admin: new users
userSchema.index({ isActive: 1, lastSeen: -1 }); // admin: active users
userSchema.index({ isActive: 1, userType: 1, createdAt: -1 }); // filtered user lists
userSchema.index({ isActive: 1, isPremium: 1, _id: 1 });
userSchema.index({ isActive: 1, isVerifiedHost: 1, _id: 1 });
userSchema.index({ isActive: 1, creatorMonetizationStatus: 1, _id: 1 });
userSchema.index({ isActive: 1, 'membership.tier': 1, _id: 1 });
userSchema.index({ 'notificationClients.platform': 1, 'notificationClients.appVersion': 1, 'notificationClients.lastSeenAt': -1 });
userSchema.index({ 'pushTokens.platform': 1, 'pushTokens.appVersion': 1, 'pushTokens.lastUsedAt': -1 });
userSchema.index({ 'notificationClients.clientId': 1 }, { unique: true, sparse: true });
userSchema.index({ 'pushTokens.token': 1 }, { unique: true, sparse: true });
userSchema.index(
  { 'pushTokens.installationId': 1 },
  { unique: true, partialFilterExpression: { 'pushTokens.installationId': { $type: 'string', $gt: '' } } }
);

// Hash password before saving
userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// Ensure playerInfo.joinedTeams exists for players
userSchema.pre('save', function(next) {
  if (this.userType === 'player') {
    if (!this.playerInfo) {
      this.playerInfo = {};
    }
    if (!this.playerInfo.joinedTeams) {
      this.playerInfo.joinedTeams = [];
    }
  }
  next();
});

// Compare password method
userSchema.methods.comparePassword = async function(candidatePassword) {
  try {
    if (!candidatePassword || !this.password) {
      return false;
    }
    return await bcrypt.compare(candidatePassword, this.password);
  } catch (error) {
    console.error('Password comparison error:', error);
    return false;
  }
};

// Get public profile
userSchema.methods.getPublicProfile = function() {
  const userObject = this.toObject();
  delete userObject.password;
  delete userObject.email;
  delete userObject.pushTokens;
  delete userObject.notificationClients;
  
  // Add followers and following counts
  userObject.followersCount = this.followers ? this.followers.length : 0;
  userObject.followingCount = this.following ? this.following.length : 0;
  
  return userObject;
};

// Populate team information
userSchema.methods.populateTeamInfo = async function() {
  if (this.userType === 'team') {
    await this.populate([
      {
        path: 'teamInfo.members.user',
        select: 'username profile.displayName profile.avatar'
      },
      {
        path: 'teamInfo.rosters.players.user',
        select: 'username profile.displayName profile.avatar'
      },
      {
        path: 'teamInfo.staff.user',
        select: 'username profile.displayName profile.avatar'
      }
    ]);
    
    // Filter out inactive staff members after population, but keep those with pending leave requests
    if (this.teamInfo && this.teamInfo.staff) {
      this.teamInfo.staff = this.teamInfo.staff.filter(staff => 
        staff.isActive || staff.leaveRequestStatus === 'pending'
      );
    }
    
    // Filter out inactive roster players after population
    // Only filter if isActive is explicitly false, not if undefined (new players might not have it set yet)
    if (this.teamInfo && this.teamInfo.rosters) {
      this.teamInfo.rosters.forEach(roster => {
        if (roster.players) {
          roster.players = roster.players.filter(player => {
            // Include player if isActive is true or undefined (treat undefined as active)
            return player.isActive !== false;
          });
        }
      });
    }
  }
  return this;
};

userSchema.index({ 'savedPosts.post': 1 });

module.exports = mongoose.model('User', userSchema);
