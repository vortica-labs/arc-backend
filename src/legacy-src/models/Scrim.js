const mongoose = require('mongoose');
const crypto = require('crypto');
const { calculateBGMIPoints } = require('../utils/bgmiPoints');

// Generate unique shareable ID for scrims
const generateScrimCode = function() {
  const prefix = 'SCR';
  const gameAbbr = 'BGM'; // BGMI only for now
  const randomPart = crypto.randomBytes(4).toString('hex').toUpperCase();
  return `${prefix}-${gameAbbr}-${randomPart}`;
};

// BGMI Maps list
const BGMI_MAPS = [
  'Erangel',
  'Miramar',
  'Sanhok',
  'Vikendi',
  'Livik',
  'Karakin',
  'Nusa'
];

const scrimSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    required: false,
    maxlength: 5000,
    default: ''
  },
  game: {
    type: String,
    required: true,
    enum: ['BGMI'],
    default: 'BGMI'
  },
  format: {
    type: String,
    required: true,
    enum: ['Solo', 'Squad'],
    default: 'Squad'
  },
  
  // Scrim Type: Daily or Weekly
  scrimType: {
    type: String,
    required: true,
    enum: ['Daily', 'Weekly'],
    default: 'Daily'
  },
  
  // Time Slot for Daily scrims (e.g., '1-2', '1-3', '1-4')
  timeSlot: {
    type: String,
    required: false,
    default: null
  },
  
  // Number of matches exposed by the Web creation flow: 1 through 6.
  numberOfMatches: {
    type: Number,
    required: true,
    enum: [1, 2, 3, 4, 5, 6],
    default: 1
  },
  
  // Status
  status: {
    type: String,
    required: true,
    enum: ['Open', 'Full', 'In Progress', 'Completed', 'Cancelled'],
    default: 'Open'
  },
  
  // Dates
  date: {
    type: Date,
    required: true
  },
  endDate: {
    type: Date, // For weekly scrims
    required: false
  },
  
  // Teams
  maxTeams: {
    type: Number,
    required: true,
    min: 16,
    max: 25,
    default: 16
  },
  registeredTeams: {
    type: [{
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User'
    }],
    default: []
  },
  
  // Unique shareable ID
  scrimCode: {
    type: String,
    unique: true,
    default: generateScrimCode,
    index: true
  },
  
  // Host
  host: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  
  // Matches array
  matches: [{
    matchNumber: {
      type: Number,
      required: true,
      min: 1,
      max: 6
    },
    map: {
      type: String,
      required: true,
      enum: BGMI_MAPS
    },
    idpTime: {
      type: String, // HH:MM format
      required: true
    },
    startTime: {
      type: String, // HH:MM format
      required: true
    },
    status: {
      type: String,
      enum: ['Scheduled', 'IDP Shared', 'In Progress', 'Completed', 'Cancelled'],
      default: 'Scheduled'
    },
    
    // Match Results (submitted by host)
    results: {
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
        placement: {
          type: Number,
          required: true,
          min: 1,
          max: 25
        },
        kills: {
          type: Number,
          required: true,
          min: 0,
          max: 50,
          default: 0
        },
        // Auto-calculated fields
        placementPoints: {
          type: Number,
          default: 0
        },
        killPoints: {
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
        }
      }],
      submittedAt: {
        type: Date,
        default: null
      }
    }
  }],
  
  // Overall Standings (auto-calculated)
  overallStandings: {
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
      // Per-match breakdown
      matches: [{
        matchNumber: {
          type: Number,
          required: true
        },
        placement: Number,
        kills: Number,
        placementPoints: Number,
        killPoints: Number,
        totalPoints: Number,
        rank: Number
      }],
      // Overall stats
      totalPlacementPoints: {
        type: Number,
        default: 0
      },
      totalKillPoints: {
        type: Number,
        default: 0
      },
      totalPoints: {
        type: Number,
        default: 0
      },
      averagePoints: {
        type: Number,
        default: 0
      },
      bestMatch: {
        type: Number,
        default: null
      },
      worstMatch: {
        type: Number,
        default: null
      },
      rank: {
        type: Number,
        default: 0
      }
    }],
    lastUpdated: {
      type: Date,
      default: Date.now
    }
  },
  
  // Prize Pool
  prizePool: { type: Number, min: 0, default: 0 },
  prizePoolType: {
    type: String,
    enum: ['with_prize', 'without_prize', 'no_prize'],
    default: 'without_prize'
  },
  prizePoolCurrency: {
    type: String,
    enum: ['INR', 'USD', 'EUR', 'GBP'],
    default: 'INR'
  },
  // Prize Distribution — host decides how to split the prize pool
  prizeDistribution: [{
    rank: { type: Number, required: true, min: 1 },
    label: { type: String, maxlength: 120, default: '' },
    amount: { type: Number, required: true, min: 0 },
    percentage: { type: Number, min: 0, max: 100, default: 0 }
  }],
  // Special Prizes — custom categories like Most Finishes, Most Wins
  specialPrizes: [{
    category: { type: String, required: true, maxlength: 120 },
    amount: { type: Number, required: true, min: 0 },
    winnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    winnerName: { type: String, default: '' }
  }],
  
  // Final Result — compiled overall standings after all matches
  finalResult: {
    standings: [{
      rank: Number,
      teamId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      teamName: String,
      teamLogo: String,
      totalPlacementPoints: { type: Number, default: 0 },
      totalKillPoints: { type: Number, default: 0 },
      totalPoints: { type: Number, default: 0 },
      prizeAmount: { type: Number, default: 0 }
    }],
    specialPrizeWinners: [{
      category: String,
      amount: Number,
      winnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      winnerName: String
    }],
    generatedAt: { type: Date, default: null }
  },
  
  timezone: {
    type: String,
    default: 'Asia/Kolkata'
  },

  broadcasts: [{
    message: { type: String, required: true, maxlength: 2000 },
    type: { type: String, enum: ['info', 'warning', 'match_starting', 'custom'], default: 'info' },
    senderName: { type: String, maxlength: 120 },
    sentAt: { type: Date, default: Date.now }
  }]
}, {
  timestamps: true
});

// Pre-save hook to ensure scrimCode is always uppercase
scrimSchema.pre('save', function(next) {
  if (this.scrimCode && typeof this.scrimCode === 'string') {
    this.scrimCode = this.scrimCode.toUpperCase().trim();
  }
  next();
});

// Method to calculate and update match results
scrimSchema.methods.calculateMatchResults = function(matchNumber) {
  const match = this.matches.find(m => m.matchNumber === matchNumber);
  if (!match || !match.results || !match.results.teams) return;
  
  // Calculate points for each team
  match.results.teams = match.results.teams.map(team => {
    const points = calculateBGMIPoints(team.placement, team.kills);
    return {
      ...(typeof team?.toObject === 'function' ? team.toObject() : team),
      placementPoints: points.placementPoints,
      killPoints: points.killPoints,
      totalPoints: points.totalPoints
    };
  });
  
  // Sort by totalPoints (descending) and assign ranks
  match.results.teams.sort((a, b) => b.totalPoints - a.totalPoints);
  match.results.teams.forEach((team, index) => {
    team.rank = index + 1;
  });
  
  match.results.submittedAt = new Date();
};

// Method to calculate and update overall standings
scrimSchema.methods.calculateOverallStandings = function() {
  const allTeams = {};
  
  // Collect all team data from all matches
  this.matches.forEach(match => {
    if (match.results && match.results.teams) {
      match.results.teams.forEach(team => {
        if (!team?.teamId) return;
        const teamId = team.teamId.toString();
        
        if (!allTeams[teamId]) {
          allTeams[teamId] = {
            teamId: team.teamId,
            teamName: team.teamName,
            teamLogo: team.teamLogo,
            matches: [],
            totalPlacementPoints: 0,
            totalKillPoints: 0,
            totalPoints: 0
          };
        }
        
        // Add match result
        allTeams[teamId].matches.push({
          matchNumber: match.matchNumber,
          placement: team.placement,
          kills: team.kills,
          placementPoints: team.placementPoints,
          killPoints: team.killPoints,
          totalPoints: team.totalPoints,
          rank: team.rank
        });
        
        // Accumulate points
        allTeams[teamId].totalPlacementPoints += team.placementPoints || 0;
        allTeams[teamId].totalKillPoints += team.killPoints || 0;
        allTeams[teamId].totalPoints += team.totalPoints || 0;
      });
    }
  });
  
  // Convert to array and calculate additional stats
  const standingsTeams = Object.values(allTeams).map(team => {
    const completedMatches = team.matches.length;
    const averagePoints = completedMatches > 0 ? team.totalPoints / completedMatches : 0;
    
    // Find best and worst matches
    let bestMatch = null;
    let worstMatch = null;
    let bestPoints = -1;
    let worstPoints = Infinity;
    
    team.matches.forEach(match => {
      if (match.totalPoints > bestPoints) {
        bestPoints = match.totalPoints;
        bestMatch = match.matchNumber;
      }
      if (match.totalPoints < worstPoints) {
        worstPoints = match.totalPoints;
        worstMatch = match.matchNumber;
      }
    });
    
    return {
      ...team,
      averagePoints: Math.round(averagePoints * 100) / 100,
      bestMatch,
      worstMatch
    };
  });
  
  // Sort by totalPoints (descending) and assign ranks
  standingsTeams.sort((a, b) => b.totalPoints - a.totalPoints);
  standingsTeams.forEach((team, index) => {
    team.rank = index + 1;
  });
  
  // Update overall standings
  this.overallStandings = {
    teams: standingsTeams,
    lastUpdated: new Date()
  };
};

// Indexes for better performance
scrimSchema.index({ status: 1, date: 1 });
scrimSchema.index({ host: 1 });
scrimSchema.index({ scrimType: 1, date: 1 });
scrimSchema.index({ registeredTeams: 1, date: -1 });

module.exports = mongoose.model('Scrim', scrimSchema);
