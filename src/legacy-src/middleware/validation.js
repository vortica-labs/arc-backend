const { validationResult, body } = require('express-validator');
const {
  TEAM_RECRUITMENT_STATUSES,
  PLAYER_PROFILE_STATUSES,
  TEAM_APPLICATION_STATUSES
} = require('../services/recruitmentPolicy');
const ALLOWED_GAMES = ['BGMI', 'Valorant', 'Free Fire', 'Call of Duty Mobile', 'CS:GO', 'Fortnite', 'Apex Legends', 'League of Legends', 'Dota 2'];
const ALLOWED_STAFF_ROLES = [
  'Coach',
  'Manager',
  'Content Creator',
  'Video Editor',
  'Social Media Manager',
  'GFX Artist',
  'Scrims Manager',
  'Tournament Manager',
  'Analyst',
  'Stream Manager'
];

// Middleware to handle validation errors
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  
  if (!errors.isEmpty()) {
    const errorMessages = errors.array().map(error => ({
      field: error.path,
      message: error.msg,
      value: error.value
    }));
    
    return res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors: errorMessages
    });
  }
  
  next();
};

// Team Recruitment Validation
const validateRecruitment = [
  body('recruitmentType')
    .isIn(['roster', 'staff'])
    .withMessage('Recruitment type must be either roster or staff'),
  body('game').custom((value, { req }) => {
    const game = typeof value === 'string' ? value.trim() : value;
    if (req.body?.recruitmentType === 'roster' && !game) {
      throw new Error('Game is required for roster recruitment');
    }
    if (game && !ALLOWED_GAMES.includes(game)) {
      throw new Error('Invalid game selection');
    }
    return true;
  }),
  body('role')
    .if(body('recruitmentType').equals('roster'))
    .notEmpty()
    .withMessage('Role is required for roster recruitment')
    .isLength({ max: 120 })
    .withMessage('Role cannot exceed 120 characters'),
  body('staffRole')
    .if(body('recruitmentType').equals('staff'))
    .notEmpty()
    .withMessage('Staff role is required for staff recruitment')
    .isIn(ALLOWED_STAFF_ROLES)
    .withMessage('Invalid staff role'),
  body('requirements')
    .optional()
    .isObject()
    .withMessage('Requirements must be an object'),
  body('benefits')
    .isObject()
    .withMessage('Benefits must be an object'),
  body('requirements.additionalRequirements')
    .optional()
    .isLength({ max: 1500 })
    .withMessage('Additional requirements cannot exceed 1500 characters'),
  body('requirements.requiredSkills')
    .optional()
    .isLength({ max: 1500 })
    .withMessage('Required skills cannot exceed 1500 characters'),
  body('requirements.portfolioRequirements')
    .optional()
    .isLength({ max: 800 })
    .withMessage('Portfolio requirements cannot exceed 800 characters'),
  body('benefits.salary')
    .optional()
    .isLength({ max: 200 })
    .withMessage('Salary description cannot exceed 200 characters'),
  body('benefits.location')
    .optional()
    .isLength({ max: 120 })
    .withMessage('Location cannot exceed 120 characters'),
  body('benefits.benefitsAndPerks')
    .optional()
    .isLength({ max: 1000 })
    .withMessage('Benefits and perks cannot exceed 1000 characters'),
  body('benefits.contactInformation')
    .notEmpty()
    .withMessage('Contact information is required')
    .isLength({ max: 300 })
    .withMessage('Contact information cannot exceed 300 characters'),
  body().custom((_value, { req }) => {
    const requirements = req.body?.requirements || {};
    const requiredValues = req.body?.recruitmentType === 'roster'
      ? [requirements.experienceLevel, requirements.dailyPlayingTime, requirements.tournamentExperience]
      : [requirements.experienceLevel, requirements.availability];
    if (!requiredValues.some(value => typeof value === 'string' && value.trim())) {
      throw new Error('Provide at least one experience or availability requirement');
    }
    return true;
  }),
  handleValidationErrors
];

// Player Profile Validation
const validatePlayerProfile = [
  body('profileType')
    .isIn(['looking-for-team', 'staff-position'])
    .withMessage('Profile type must be either looking-for-team or staff-position'),
  body('game')
    .if(body('profileType').equals('looking-for-team'))
    .notEmpty()
    .withMessage('Game is required for looking for team profile')
    .isIn(ALLOWED_GAMES)
    .withMessage('Invalid game selection'),
  body('role')
    .if(body('profileType').equals('looking-for-team'))
    .notEmpty()
    .withMessage('Role is required for looking for team profile'),
  body('staffRole')
    .if(body('profileType').equals('staff-position'))
    .notEmpty()
    .withMessage('Staff role is required for staff position profile')
    .isIn(ALLOWED_STAFF_ROLES)
    .withMessage('Invalid staff role'),
  body('playerInfo.playerName')
    .if(body('profileType').equals('looking-for-team'))
    .notEmpty()
    .withMessage('Player name is required for looking for team profile')
    .isLength({ max: 120 })
    .withMessage('Player name cannot exceed 120 characters'),
  body('playerInfo.currentRank')
    .if(body('profileType').equals('looking-for-team'))
    .notEmpty()
    .withMessage('Current rank is required for looking for team profile')
    .isLength({ max: 120 })
    .withMessage('Current rank cannot exceed 120 characters'),
  body('professionalInfo.fullName')
    .if(body('profileType').equals('staff-position'))
    .notEmpty()
    .withMessage('Full name is required for staff position profile')
    .isLength({ max: 120 })
    .withMessage('Full name cannot exceed 120 characters'),
  body('professionalInfo.skillsAndExpertise')
    .if(body('profileType').equals('staff-position'))
    .notEmpty()
    .withMessage('Skills and expertise are required for staff position profile')
    .isLength({ max: 1500 })
    .withMessage('Skills and expertise cannot exceed 1500 characters'),
  body('expectations')
    .isObject()
    .withMessage('Expectations must be an object'),
  body('expectations.contactInformation')
    .notEmpty()
    .withMessage('Contact information is required')
    .isLength({ max: 300 })
    .withMessage('Contact information cannot exceed 300 characters'),
  body('playerInfo.achievements')
    .optional()
    .isLength({ max: 1500 })
    .withMessage('Achievements cannot exceed 1500 characters'),
  body('playerInfo.additionalInfo')
    .optional()
    .isLength({ max: 1000 })
    .withMessage('Additional information cannot exceed 1000 characters'),
  body('professionalInfo.skillsAndExpertise')
    .optional()
    .isLength({ max: 1500 })
    .withMessage('Skills and expertise cannot exceed 1500 characters'),
  body('professionalInfo.portfolio')
    .optional()
    .isLength({ max: 800 })
    .withMessage('Portfolio cannot exceed 800 characters'),
  handleValidationErrors
];

const validateRecruitmentUpdate = [
  body('recruitmentType').optional().isIn(['roster', 'staff']).withMessage('Invalid recruitment type'),
  body('game').optional({ checkFalsy: true }).isIn(ALLOWED_GAMES).withMessage('Invalid game selection'),
  body('role').optional({ checkFalsy: true }).isLength({ max: 120 }).withMessage('Role cannot exceed 120 characters'),
  body('staffRole').optional({ checkFalsy: true }).isIn(ALLOWED_STAFF_ROLES).withMessage('Invalid staff role'),
  body('requirements').optional().isObject().withMessage('Requirements must be an object'),
  body('benefits').optional().isObject().withMessage('Benefits must be an object'),
  body('requirements.additionalRequirements').optional().isLength({ max: 1500 }).withMessage('Additional requirements cannot exceed 1500 characters'),
  body('requirements.requiredSkills').optional().isLength({ max: 1500 }).withMessage('Required skills cannot exceed 1500 characters'),
  body('requirements.portfolioRequirements').optional().isLength({ max: 800 }).withMessage('Portfolio requirements cannot exceed 800 characters'),
  body('benefits.salary').optional().isLength({ max: 200 }).withMessage('Salary description cannot exceed 200 characters'),
  body('benefits.location').optional().isLength({ max: 120 }).withMessage('Location cannot exceed 120 characters'),
  body('benefits.benefitsAndPerks').optional().isLength({ max: 1000 }).withMessage('Benefits and perks cannot exceed 1000 characters'),
  body('benefits.contactInformation').optional().isLength({ max: 300 }).withMessage('Contact information cannot exceed 300 characters'),
  body('status').optional().isIn(TEAM_RECRUITMENT_STATUSES).withMessage('Invalid recruitment status'),
  handleValidationErrors
];

const validatePlayerProfileUpdate = [
  body('profileType').optional().isIn(['looking-for-team', 'staff-position']).withMessage('Invalid profile type'),
  body('game').optional({ checkFalsy: true }).isIn(ALLOWED_GAMES).withMessage('Invalid game selection'),
  body('role').optional({ checkFalsy: true }).isLength({ max: 120 }).withMessage('Role cannot exceed 120 characters'),
  body('staffRole').optional({ checkFalsy: true }).isIn(ALLOWED_STAFF_ROLES).withMessage('Invalid staff role'),
  body('playerInfo').optional().isObject().withMessage('Player information must be an object'),
  body('professionalInfo').optional().isObject().withMessage('Professional information must be an object'),
  body('expectations').optional().isObject().withMessage('Expectations must be an object'),
  body('playerInfo.playerName').optional().isLength({ max: 120 }).withMessage('Player name cannot exceed 120 characters'),
  body('playerInfo.currentRank').optional().isLength({ max: 120 }).withMessage('Current rank cannot exceed 120 characters'),
  body('playerInfo.achievements').optional().isLength({ max: 1500 }).withMessage('Achievements cannot exceed 1500 characters'),
  body('playerInfo.additionalInfo').optional().isLength({ max: 1000 }).withMessage('Additional information cannot exceed 1000 characters'),
  body('professionalInfo.fullName').optional().isLength({ max: 120 }).withMessage('Full name cannot exceed 120 characters'),
  body('professionalInfo.skillsAndExpertise').optional().isLength({ max: 1500 }).withMessage('Skills and expertise cannot exceed 1500 characters'),
  body('professionalInfo.portfolio').optional().isLength({ max: 800 }).withMessage('Portfolio cannot exceed 800 characters'),
  body('expectations.contactInformation').optional().isLength({ max: 300 }).withMessage('Contact information cannot exceed 300 characters'),
  body('status').optional().isIn(PLAYER_PROFILE_STATUSES).withMessage('Invalid profile status'),
  handleValidationErrors
];

// Application Validation
const validateApplication = [
  body('message')
    .optional()
    .isLength({ max: 1000 })
    .withMessage('Message cannot exceed 1000 characters'),
  body('resume')
    .optional()
    .custom((value) => {
      if (value && value.trim() !== '') {
        return /^https?:\/\/.+/.test(value);
      }
      return true;
    })
    .withMessage('Resume must be a valid URL'),
  body('portfolio')
    .optional()
    .custom((value) => {
      if (value && value.trim() !== '') {
        return /^https?:\/\/.+/.test(value);
      }
      return true;
    })
    .withMessage('Portfolio must be a valid URL'),
  handleValidationErrors
];

const validateApplicationStatus = [
  body('status').isIn(TEAM_APPLICATION_STATUSES).withMessage('Invalid application status'),
  body('message').optional().isLength({ max: 1000 }).withMessage('Message cannot exceed 1000 characters'),
  handleValidationErrors
];

const validateProfileInterest = [
  body('message').optional().isLength({ max: 1000 }).withMessage('Message cannot exceed 1000 characters'),
  handleValidationErrors
];

module.exports = {
  handleValidationErrors,
  validateRecruitment,
  validateRecruitmentUpdate,
  validatePlayerProfile,
  validatePlayerProfileUpdate,
  validateApplication,
  validateApplicationStatus,
  validateProfileInterest
};
