const mongoose = require('mongoose');
const crypto = require('crypto');

// Generate unique shareable ID with prefix and role
const generateShareableId = function() {
  const prefix = this.recruitmentType === 'roster' ? 'RST' : 'STF';
  
  // Get role abbreviation (first 2-3 letters)
  let roleAbbr = '';
  if (this.recruitmentType === 'roster' && this.role) {
    roleAbbr = this.role.substring(0, 3).toUpperCase().replace(/\s/g, '');
  } else if (this.recruitmentType === 'staff' && this.staffRole) {
    roleAbbr = this.staffRole.substring(0, 3).toUpperCase().replace(/\s/g, '');
  } else {
    roleAbbr = 'GEN';
  }
  
  // Generate random part (8 chars)
  const randomPart = crypto.randomBytes(4).toString('hex').toUpperCase();
  
  return `${prefix}-${roleAbbr}-${randomPart}`;
};

const teamRecruitmentSchema = new mongoose.Schema({
  team: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: [true, 'Team is required']
  },
  // Unique shareable ID for recruitment posts
  recruitmentCode: {
    type: String,
    unique: true,
    default: generateShareableId,
    index: true
  },
  recruitmentType: {
    type: String,
    enum: ['roster', 'staff'],
    required: [true, 'Recruitment type is required']
  },
  // Game and Role Information
  game: {
    type: String,
    required: function() {
      return this.recruitmentType === 'roster';
    },
    enum: ['BGMI', 'Valorant', 'Free Fire', 'Call of Duty Mobile', 'CS:GO', 'Fortnite', 'Apex Legends', 'League of Legends', 'Dota 2']
  },
  role: {
    type: String,
    required: function() {
      return this.recruitmentType === 'roster';
    }
  },
  // For staff recruitment
  staffRole: {
    type: String,
    enum: ['Coach', 'Manager', 'Content Creator', 'Video Editor', 'Social Media Manager', 'GFX Artist', 'Scrims Manager', 'Tournament Manager', 'Analyst', 'Stream Manager'],
    required: function() {
      return this.recruitmentType === 'staff';
    }
  },
  // Requirements
  requirements: {
    dailyPlayingTime: String,
    tournamentExperience: String,
    requiredDevice: String,
    experienceLevel: String,
    language: String,
    additionalRequirements: String,
    // Staff specific requirements
    availability: String,
    requiredSkills: String,
    portfolioRequirements: String
  },
  // Benefits and Contact
  benefits: {
    salary: String,
    customSalary: String,
    location: String,
    benefitsAndPerks: String,
    contactInformation: String
  },
  // Status and Metadata
  status: {
    type: String,
    enum: ['active', 'paused', 'closed', 'filled'],
    default: 'active'
  },
  applicants: [{
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    appliedAt: {
      type: Date,
      default: Date.now
    },
    status: {
      type: String,
      enum: ['pending', 'reviewed', 'shortlisted', 'rejected', 'accepted'],
      default: 'pending'
    },
    message: String,
    resume: String,
    portfolio: String
  }],
  views: {
    type: Number,
    default: 0
  },
  isActive: {
    type: Boolean,
    default: true
  },
  expiresAt: {
    type: Date,
    default: function() {
      return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days from now
    }
  }
}, {
  timestamps: true
});

// Indexes for better performance
teamRecruitmentSchema.index({ team: 1, createdAt: -1 });
teamRecruitmentSchema.index({ recruitmentType: 1, game: 1, status: 1 });
teamRecruitmentSchema.index({ 'benefits.location': 1 });
teamRecruitmentSchema.index({ createdAt: -1 });
teamRecruitmentSchema.index({ expiresAt: 1 });

// Virtual for applicant count
teamRecruitmentSchema.virtual('applicantCount').get(function() {
  return this.applicants ? this.applicants.length : 0;
});

// Pre-save hook to ensure recruitmentCode is always uppercase
teamRecruitmentSchema.pre('save', function(next) {
  if (this.recruitmentCode && typeof this.recruitmentCode === 'string') {
    this.recruitmentCode = this.recruitmentCode.toUpperCase().trim();
  }
  next();
});

// Ensure virtual fields are included in JSON
teamRecruitmentSchema.set('toJSON', { virtuals: true });

module.exports = mongoose.model('TeamRecruitment', teamRecruitmentSchema);
