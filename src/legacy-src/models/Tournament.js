const mongoose = require('mongoose');
const crypto = require('crypto');

// Generate unique shareable ID with prefix and game
const generateShareableId = function() {
  const prefix = 'TRN';
  
  // Get game abbreviation (first 3 letters)
  let gameAbbr = '';
  if (this.game) {
    // Map games to abbreviations
    const gameMap = {
      'BGMI': 'BGM',
      'Valorant': 'VAL',
      'Free Fire': 'FF',
      'Call of Duty Mobile': 'COD',
      'CS:GO': 'CSG',
      'Fortnite': 'FTN',
      'Apex Legends': 'APX',
      'League of Legends': 'LOL',
      'Dota 2': 'DOT'
    };
    gameAbbr = gameMap[this.game] || this.game.substring(0, 3).toUpperCase().replace(/\s/g, '');
  } else {
    gameAbbr = 'GEN';
  }
  
  // Generate random part (8 chars)
  const randomPart = crypto.randomBytes(4).toString('hex').toUpperCase();
  
  return `${prefix}-${gameAbbr}-${randomPart}`;
};

const tournamentSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    required: true
  },
  game: {
    type: String,
    required: true,
    enum: ['BGMI', 'Valorant', 'Free Fire', 'Call of Duty Mobile']
  },
  mode: {
    type: String,
    required: false,
    enum: ['Battle Royale', 'Deathmatch', '5v5', 'Solo']
  },
  format: {
    type: String,
    required: true,
    enum: ['Solo', 'Duo', 'Squad', '5v5']
  },

  status: {
    type: String,
    required: true,
    enum: ['Upcoming', 'Registration Open', 'Ongoing', 'Completed', 'Cancelled'],
    default: 'Upcoming'
  },
  registrationStartDate: {
    type: Date,
    required: true
  },
  registrationEndDate: {
    type: Date,
    required: true
  },
  tournamentStartDate: {
    type: Date,
    required: true
  },
  tournamentEndDate: {
    type: Date,
    required: true
  },
  startDate: {
    type: Date,
    required: false
  },
  endDate: {
    type: Date,
    required: false
  },
  registrationDeadline: {
    type: Date,
    required: false
  },
  location: {
    type: String,
    default: 'Online'
  },
  timezone: {
    type: String,
    default: 'UTC'
  },
  prizePool: {
    type: Number,
    default: 0
  },
  totalSlots: {
    type: Number,
    required: true,
    min: 4
  },
  teamsPerGroup: {
    type: Number,
    required: true,
    min: 2,
    max: 100
  },
  numberOfGroups: {
    type: Number,
    required: true,
    min: 1
  },
  prizePoolType: {
    type: String,
    required: true,
    enum: ['with_prize', 'without_prize'],
    default: 'with_prize'
  },
  prizePoolCurrency: {
    type: String,
    enum: ['INR', 'USD', 'EUR', 'GBP'],
    default: 'INR'
  },
  // Prize Distribution — host decides how to split the prize pool
  prizeDistribution: [{
    rank: { type: Number, required: true },
    label: { type: String, default: '' },
    amount: { type: Number, required: true },
    percentage: { type: Number, default: 0 }
  }],
  // Special Prizes — custom categories like Most Finishes, Most Wins
  specialPrizes: [{
    category: { type: String, required: true },
    amount: { type: Number, required: true },
    winnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    winnerName: { type: String, default: '' }
  }],
  currentRound: {
    type: Number,
    default: 1
  },
  totalRounds: {
    type: Number,
    default: 1
  },
  // Unique shareable ID for tournaments
  tournamentCode: {
    type: String,
    unique: true,
    default: generateShareableId,
    index: true
  },
  host: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  participants: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  teams: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  groups: [{
    name: String,
    round: {
      type: Number,
      default: 1
    },
    groupLetter: String,
    participants: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    }],
    broadcastChannelId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Message'
    }
  }],
  banner: {
    type: String,
    default: null
  },
  rules: [{
    type: String
  }],
  // Group-wise messaging system
  groupMessages: [{
    groupId: String,
    round: {
      type: Number,
      default: 1
    },
    messages: [{
      sender: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
      },
      message: String,
      timestamp: {
        type: Date,
        default: Date.now
      },
      type: {
        type: String,
        enum: ['text', 'announcement', 'system'],
        default: 'text'
      }
    }]
  }],
  
  // Tournament-wide messaging system
  tournamentMessages: [{
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    message: String,
    timestamp: {
      type: Date,
      default: Date.now
    },
    type: {
      type: String,
      enum: ['text', 'announcement', 'system'],
      default: 'text'
    }
  }],
  matches: [{
    round: Number,
    groupId: String,
    groupName: String,
    team1: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: false
    },
    team2: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: false
    },
    winner: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    status: {
      type: String,
      enum: ['Scheduled', 'In Progress', 'Completed', 'Cancelled'],
      default: 'Scheduled'
    },
    scheduledTime: Date,
    scheduledDate: String, // YYYY-MM-DD format for easy filtering
    scheduledTimeString: String, // HH:MM format for display
    matchDuration: {
      type: Number,
      default: 30 // minutes
    },
    venue: {
      type: String,
      default: 'Online'
    },
    description: String,
    result: {
      team1Score: Number,
      team2Score: Number
    },
    // Schedule management fields
    isRescheduled: {
      type: Boolean,
      default: false
    },
    originalScheduledTime: Date,
    rescheduleReason: String,
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    lastModifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    }
  }],
  
  // Schedule configuration
  scheduleConfig: {
    defaultMatchDuration: {
      type: Number,
      default: 30 // minutes
    },
    timeSlots: [{
      startTime: String, // HH:MM format
      endTime: String,   // HH:MM format
      isActive: {
        type: Boolean,
        default: true
      }
    }],
    availableDates: [{
      date: String, // YYYY-MM-DD format
      isActive: {
        type: Boolean,
        default: true
      },
      maxMatches: {
        type: Number,
        default: 10
      }
    }],
    timezone: {
      type: String,
      default: 'Asia/Kolkata'
    }
  },
  
  // Results and Qualification System
  groupResults: [{
    round: {
      type: Number,
      required: true
    },
    groupId: {
      type: String,
      required: true
    },
    groupName: {
      type: String,
      required: true
    },
    teams: [{
      teamId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true
      },
      teamName: {
        type: String,
        required: true
      },
      teamLogo: {
        type: String,
        default: null
      },
      wins: {
        type: Number,
        default: 0
      },
      finishPoints: {
        type: Number,
        default: 0
      },
      positionPoints: {
        type: Number,
        default: 0
      },
      totalPoints: {
        type: Number,
        default: 0
      },
      rank: {
        type: Number,
        default: 0
      },
      qualified: {
        type: Boolean,
        default: false
      }
    }],
    submittedAt: {
      type: Date,
      default: Date.now
    }
  }],
  
  qualifications: [{
    round: {
      type: Number,
      required: true
    },
    qualifiedTeams: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    }],
    qualificationCriteria: {
      type: Number,
      default: 8 // teams that qualify per group
    },
    totalQualified: {
      type: Number,
      default: 0
    },
    qualifiedAt: {
      type: Date,
      default: Date.now
    }
  }],
  
  roundSettings: [{
    round: {
      type: Number,
      required: true
    },
    teamsPerGroup: {
      type: Number,
      required: true
    },
    qualificationCriteria: {
      type: Number,
      default: 8
    },
    totalGroups: {
      type: Number,
      required: true
    },
    totalTeams: {
      type: Number,
      required: true
    }
  }],
  
  qualificationSettings: {
    teamsPerGroup: {
      type: Number,
      default: 8
    },
    nextRoundTeamsPerGroup: {
      type: Number,
      default: 16
    }
  },
  
  winners: [{
    position: Number,
    team: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    },
    prize: Number
  }],
  
  // Final Result — compiled overall standings after all rounds
  finalResult: {
    standings: [{
      rank: Number,
      teamId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      teamName: String,
      teamLogo: String,
      totalPoints: { type: Number, default: 0 },
      wins: { type: Number, default: 0 },
      finishPoints: { type: Number, default: 0 },
      positionPoints: { type: Number, default: 0 },
      prizeAmount: { type: Number, default: 0 }
    }],
    specialPrizeWinners: [{
      category: String,
      amount: Number,
      winnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      winnerName: String
    }],
    generatedAt: { type: Date, default: null }
  }
}, {
  timestamps: true
});

// Pre-save hook to ensure tournamentCode is always uppercase
tournamentSchema.pre('save', function(next) {
  if (this.tournamentCode && typeof this.tournamentCode === 'string') {
    this.tournamentCode = this.tournamentCode.toUpperCase().trim();
  }
  next();
});

// Indexes for better performance
tournamentSchema.index({ status: 1, startDate: 1 });
tournamentSchema.index({ host: 1 });
tournamentSchema.index({ game: 1, format: 1 });

module.exports = mongoose.model('Tournament', tournamentSchema);
