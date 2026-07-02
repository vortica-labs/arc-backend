const Scrim = require('../models/Scrim');
const User = require('../models/User'); // Required for populate()
const { createAndEmitNotification } = require('../utils/notificationEmitter');
const { calculateBGMIPoints } = require('../utils/bgmiPoints');
const mongoose = require('mongoose');
const log = require('../utils/logger');

const uniqueRecipientIds = (values = []) =>
  Array.from(new Set(values.map((value) => String(value?._id || value)).filter(Boolean)));

const notifyScrimRecipients = async ({ scrim, recipients, sender, title, message, eventType, revision, extraData = {} }) => {
  const recipientIds = uniqueRecipientIds(recipients);
  if (recipientIds.length === 0) return [];
  const dedupeKey = `scrim:${scrim._id}:${eventType}:${String(revision || scrim.updatedAt || '').slice(0, 80)}`;
  return Promise.all(recipientIds.map((recipient) => createAndEmitNotification({
    recipient,
    sender,
    type: 'tournament',
    title,
    message,
    data: {
      deepLink: `/scrim/${scrim.scrimCode || scrim._id}`,
      customData: {
        eventType,
        scrimId: scrim._id,
        scrimCode: scrim.scrimCode,
        notificationDedupeKey: dedupeKey,
        pushRequestId: dedupeKey,
        ...extraData
      }
    }
  })));
};

// Helper to find scrim by ObjectId or Scrim Code
const findScrimByIdOrCode = async (idOrCode) => {
  if (!idOrCode) return null;
  if (mongoose.Types.ObjectId.isValid(idOrCode)) {
    return await Scrim.findById(idOrCode);
  }
  return await Scrim.findOne({ scrimCode: idOrCode.toUpperCase() });
};


// Create new scrim
const createScrim = async (req, res) => {
  try {
    const {
      name,
      description,
      format,
      scrimType,
      timeSlot,
      numberOfMatches,
      date,
      endDate,
      maxTeams,
      timezone,
      matches,
      prizePool,
      prizePoolType,
      prizePoolCurrency,
      prizeDistribution,
      specialPrizes
    } = req.body;

    const hostId = req.user._id;

    // Validate dates
    const now = new Date();
    const scrimDate = new Date(date);
    
    if (scrimDate < now) {
      return res.status(400).json({
        success: false,
        message: 'Scrim date must be in the future'
      });
    }

    // Validate number of matches
    if (![1, 2, 3, 4].includes(parseInt(numberOfMatches))) {
      return res.status(400).json({
        success: false,
        message: 'Number of matches must be between 1 and 4'
      });
    }

    const normalizedFormat = typeof format === 'string' ? format.trim() : 'Squad';
    if (!['Solo', 'Squad'].includes(normalizedFormat)) {
      return res.status(400).json({
        success: false,
        message: 'Scrim format must be either Solo or Squad'
      });
    }

    // Validate matches array
    if (!matches || !Array.isArray(matches) || matches.length !== parseInt(numberOfMatches)) {
      return res.status(400).json({
        success: false,
        message: `Matches array must contain exactly ${numberOfMatches} matches`
      });
    }

    // Validate each match
    for (let i = 0; i < matches.length; i++) {
      const match = matches[i];
      if (!match.map || !match.idpTime || !match.startTime) {
        return res.status(400).json({
          success: false,
          message: `Match ${i + 1} must have map, idpTime, and startTime`
        });
      }
    }

    const host = await User.findById(hostId).select('isVerifiedHost').lean();
    const isVerifiedHost = host?.isVerifiedHost === true;

    // Enforce isVerifiedHost for prize pool scrims
    if (prizePoolType === 'with_prize' && isVerifiedHost !== true) {
      return res.status(403).json({
        success: false,
        message: 'You are not authorized to host prize pool scrims. Please apply for Verified Host status.'
      });
    }

    // ── Daily limit for unverified hosts (5 scrims per day) ──
    if (!isVerifiedHost) {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const Scrim = require('../models/Scrim');
      const todayCount = await Scrim.countDocuments({
        host: hostId,
        createdAt: { $gte: startOfDay }
      });

      if (todayCount >= 5) {
        const tomorrow = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);
        return res.status(429).json({
          success: false,
          message: 'Daily scrim limit reached (5/day).',
          limitType: 'scrim_daily',
          nextAllowedAt: tomorrow.toISOString(),
          upgradeMessage: 'Get Verified Host status to host unlimited scrims.'
        });
      }
    }

    // Create scrim data
    const scrimData = {
      name,
      description: description || '',
      game: 'BGMI',
      format: normalizedFormat,
      scrimType,
      timeSlot: scrimType === 'Daily' ? timeSlot : null,
      numberOfMatches: parseInt(numberOfMatches),
      date: scrimDate,
      endDate: endDate ? new Date(endDate) : null,
      maxTeams: parseInt(maxTeams) || 16,
      timezone: timezone || 'Asia/Kolkata',
      prizePool: prizePoolType === 'with_prize' ? (prizePool || 0) : 0,
      prizePoolType: prizePoolType || 'without_prize',
      prizePoolCurrency: prizePoolCurrency || 'INR',
      prizeDistribution: (prizeDistribution || []).filter(p => p.rank && p.amount),
      specialPrizes: (specialPrizes || []).filter(p => p.category && p.category.trim() !== '' && p.amount),
      host: hostId,
      status: 'Open',
      matches: matches.map((match, index) => ({
        matchNumber: index + 1,
        map: match.map,
        idpTime: match.idpTime,
        startTime: match.startTime,
        status: 'Scheduled',
        results: {
          teams: [],
          submittedAt: null
        }
      })),
      overallStandings: {
        teams: [],
        lastUpdated: new Date()
      }
    };

    const scrim = await Scrim.create(scrimData);

    // Populate host info
    await scrim.populate('host', 'username profile.displayName profile.avatar');

    res.status(201).json({
      success: true,
      message: 'Scrim created successfully',
      data: {
        scrim
      }
    });
  } catch (error) {
    log.error('Scrim creation error:', { error: String(error) });
    
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
      message: 'Failed to create scrim',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get all scrims
const getScrims = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 100;
    const skip = (page - 1) * limit;

    const { scrimType, status, search, filter } = req.query;

    // Build filter object
    const queryFilter = {};
    const now = new Date();

    if (filter === 'hosted') {
      const userId = req.user?._id || req.user?.id;
      if (userId) {
        queryFilter.host = userId;
      } else {
        queryFilter._id = { $exists: false };
      }
    } else if (filter === 'participating') {
      const userId = req.user?._id || req.user?.id;
      if (userId) {
        queryFilter.registeredTeams = userId;
      } else {
        queryFilter._id = { $exists: false };
      }
    } else if (filter === 'all') {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      queryFilter.$and = [
        {
          $or: [
            { status: { $in: ['Open', 'Full', 'In Progress'] } },
            {
              status: 'Completed',
              date: { $gte: thirtyDaysAgo }
            }
          ]
        },
        { status: { $ne: 'Cancelled' } }
      ];
    } else if (filter === 'completed') {
      queryFilter.status = 'Completed';
    } else if (status) {
      queryFilter.status = status;
    }

    if (scrimType) queryFilter.scrimType = scrimType;

    if (search) {
      queryFilter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { description: { $regex: search, $options: 'i' } },
        { scrimCode: { $regex: search, $options: 'i' } }
      ];
    }

    let scrims = await Scrim.find(queryFilter)
      .populate('host', 'username profile.displayName profile.avatar')
      .populate('registeredTeams', 'username profile.displayName profile.avatar')
      .sort({ date: -1 })
      .skip(skip)
      .limit(limit);

    // Auto-mark scrims as Completed if date has passed
    const scrimsToUpdate = [];
    for (let scrim of scrims) {
      const beforeStatus = scrim.status;
      
      if (scrim.date < now && scrim.status !== 'Completed' && scrim.status !== 'Cancelled') {
        // Check if all matches are completed
        const allMatchesCompleted = scrim.matches.every(match => 
          match.status === 'Completed' || match.results?.submittedAt
        );
        
        if (allMatchesCompleted) {
          scrim.status = 'Completed';
          await scrim.save();
          scrimsToUpdate.push(scrim._id);
        }
      }
    }

    // Count total scrims for pagination
    const total = await Scrim.countDocuments(queryFilter);

    res.status(200).json({
      success: true,
      data: {
        scrims,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit)
        }
      }
    });
  } catch (error) {
    log.error('Error fetching scrims:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to fetch scrims',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Get single scrim
const getScrim = async (req, res) => {
  try {
    const { id, code } = req.params;

    let scrim;
    if (code) {
      scrim = await Scrim.findOne({ scrimCode: code.toUpperCase() });
    } else if (id) {
      scrim = await findScrimByIdOrCode(id);
    }

    if (!scrim) {
      return res.status(404).json({
        success: false,
        message: 'Scrim not found'
      });
    }

    await scrim.populate('host', 'username profile.displayName profile.avatar');
    await scrim.populate('registeredTeams', 'username profile.displayName profile.avatar');
    
    // Populate team info in results
    if (scrim.matches) {
      for (let match of scrim.matches) {
        if (match.results && match.results.teams) {
          await Scrim.populate(match.results.teams, { path: 'teamId', select: 'username profile.displayName profile.avatar' });
        }
      }
    }

    // Populate team info in overall standings
    if (scrim.overallStandings && scrim.overallStandings.teams) {
      await Scrim.populate(scrim.overallStandings.teams, { path: 'teamId', select: 'username profile.displayName profile.avatar' });
    }

    res.status(200).json({
      success: true,
      data: {
        scrim
      }
    });
  } catch (error) {
    log.error('Error fetching scrim (full traceback):', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to fetch scrim',
      error: process.env.NODE_ENV === 'development' ? error.stack || error.message : undefined
    });
  }
};

// Join scrim
const joinScrim = async (req, res) => {
  try {
    const scrim = await findScrimByIdOrCode(req.params.id);

    if (!scrim) {
      return res.status(404).json({
        success: false,
        message: 'Scrim not found'
      });
    }

    // Check if scrim is open
    if (scrim.status !== 'Open' && scrim.status !== 'Full') {
      return res.status(400).json({
        success: false,
        message: `Cannot join scrim. Current status: ${scrim.status}`
      });
    }

    const userId = req.user._id;

    // Check if user is already registered
    if (scrim.registeredTeams.includes(userId)) {
      return res.status(400).json({
        success: false,
        message: 'You are already registered for this scrim'
      });
    }

    // Check if scrim is full
    if (scrim.registeredTeams.length >= scrim.maxTeams) {
      scrim.status = 'Full';
      await scrim.save();
      return res.status(400).json({
        success: false,
        message: 'Scrim is full'
      });
    }

    // Format-based join validation
    const User = require('../models/User');
    const joiningUser = await User.findById(userId).select('userType');
    
    if (scrim.format === 'Squad') {
      // Squad scrims: only teams can join
      if (!joiningUser || joiningUser.userType !== 'team') {
        return res.status(400).json({
          success: false,
          message: 'Only teams can join Squad scrims. Please use a team account.'
        });
      }
    }
    // Solo scrims: both players and teams can join (no restriction)

    // Add user to registered teams
    scrim.registeredTeams.push(userId);
    
    // Update status if full
    if (scrim.registeredTeams.length >= scrim.maxTeams) {
      scrim.status = 'Full';
    }

    await scrim.save();

    if (String(scrim.host) !== String(userId)) {
      await notifyScrimRecipients({
        scrim,
        recipients: [scrim.host],
        sender: userId,
        title: 'New Scrim Registration',
        message: `${req.user.profile?.displayName || req.user.username} joined "${scrim.name}"`,
        eventType: 'scrim_registration_joined',
        revision: scrim.updatedAt,
        extraData: { participantId: userId }
      });
    }

    // Populate team info
    await scrim.populate('registeredTeams', 'username profile.displayName profile.avatar');

    res.status(200).json({
      success: true,
      message: 'Successfully joined scrim',
      data: {
        scrim
      }
    });
  } catch (error) {
    log.error('Error joining scrim:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to join scrim',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Leave scrim
const leaveScrim = async (req, res) => {
  try {
    const scrim = await findScrimByIdOrCode(req.params.id);

    if (!scrim) {
      return res.status(404).json({
        success: false,
        message: 'Scrim not found'
      });
    }

    const userId = req.user._id;

    // Check if user is registered
    if (!scrim.registeredTeams.includes(userId)) {
      return res.status(400).json({
        success: false,
        message: 'You are not registered for this scrim'
      });
    }

    // Remove user from registered teams
    scrim.registeredTeams = scrim.registeredTeams.filter(
      teamId => teamId.toString() !== userId.toString()
    );

    // Update status if not full anymore
    if (scrim.status === 'Full' && scrim.registeredTeams.length < scrim.maxTeams) {
      scrim.status = 'Open';
    }

    await scrim.save();

    if (String(scrim.host) !== String(userId)) {
      await notifyScrimRecipients({
        scrim,
        recipients: [scrim.host],
        sender: userId,
        title: 'Scrim Registration Withdrawn',
        message: `${req.user.profile?.displayName || req.user.username} left "${scrim.name}"`,
        eventType: 'scrim_registration_left',
        revision: scrim.updatedAt,
        extraData: { participantId: userId }
      });
    }

    // Populate team info
    await scrim.populate('registeredTeams', 'username profile.displayName profile.avatar');

    res.status(200).json({
      success: true,
      message: 'Successfully left scrim',
      data: {
        scrim
      }
    });
  } catch (error) {
    log.error('Error leaving scrim:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to leave scrim',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Submit match results
const submitMatchResults = async (req, res) => {
  try {
    const { matchNumber, teams } = req.body;
    const scrim = await findScrimByIdOrCode(req.params.id);

    if (!scrim) {
      return res.status(404).json({
        success: false,
        message: 'Scrim not found'
      });
    }

    // Check if user is the host
    if (scrim.host.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Only scrim host can submit match results'
      });
    }

    // Find match
    const match = scrim.matches.find(m => m.matchNumber === parseInt(matchNumber));
    if (!match) {
      return res.status(404).json({
        success: false,
        message: `Match ${matchNumber} not found`
      });
    }

    // Validate teams data
    if (!teams || !Array.isArray(teams) || teams.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Teams data is required'
      });
    }

    // Validate all teams are registered
    const registeredTeamIds = scrim.registeredTeams.map(t => t.toString());
    for (let team of teams) {
      if (!registeredTeamIds.includes(team.teamId)) {
        return res.status(400).json({
          success: false,
          message: `Team ${team.teamName} is not registered for this scrim`
        });
      }
    }

    // Calculate points for each team
    const teamsWithPoints = teams.map(team => {
      const points = calculateBGMIPoints(team.placement, team.kills || 0);
      return {
        teamId: team.teamId,
        teamName: team.teamName,
        teamLogo: team.teamLogo || null,
        placement: team.placement,
        kills: team.kills || 0,
        placementPoints: points.placementPoints,
        killPoints: points.killPoints,
        totalPoints: points.totalPoints,
        rank: 0 // Will be calculated after sorting
      };
    });

    // Sort by totalPoints (descending) and assign ranks
    teamsWithPoints.sort((a, b) => b.totalPoints - a.totalPoints);
    teamsWithPoints.forEach((team, index) => {
      team.rank = index + 1;
    });

    // Update match results
    match.results = {
      teams: teamsWithPoints,
      submittedAt: new Date()
    };
    match.status = 'Completed';

    // Calculate match results using model method
    scrim.calculateMatchResults(parseInt(matchNumber));

    // Calculate overall standings
    scrim.calculateOverallStandings();

    await scrim.save();

    await notifyScrimRecipients({
      scrim,
      recipients: scrim.registeredTeams,
      sender: req.user._id,
      title: `Results Update: ${scrim.name}`,
      message: `Match ${matchNumber} results are now available.`,
      eventType: 'scrim_match_results',
      revision: scrim.updatedAt,
      extraData: { matchNumber: Number(matchNumber) }
    });

    res.status(200).json({
      success: true,
      message: `Match ${matchNumber} results submitted successfully`,
      data: {
        match: match,
        overallStandings: scrim.overallStandings
      }
    });
  } catch (error) {
    log.error('Error submitting match results:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to submit match results',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Update scrim
const updateScrim = async (req, res) => {
  try {
    const scrim = await findScrimByIdOrCode(req.params.id);

    if (!scrim) {
      return res.status(404).json({
        success: false,
        message: 'Scrim not found'
      });
    }

    // Check if user is the host
    if (scrim.host.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Only scrim host can update scrim'
      });
    }

    // Check if scrim can be updated
    if (scrim.status === 'Completed' || scrim.status === 'Cancelled') {
      return res.status(400).json({
        success: false,
        message: 'Cannot update completed or cancelled scrim'
      });
    }

    // Update allowed fields
    const allowedUpdates = ['name', 'description', 'date', 'endDate', 'maxTeams', 'timezone', 'matches', 'prizePool', 'prizePoolType', 'prizePoolCurrency', 'prizeDistribution', 'specialPrizes'];
    allowedUpdates.forEach(field => {
      if (req.body[field] !== undefined) {
        scrim[field] = req.body[field];
      }
    });

    await scrim.save();
    await scrim.populate('host', 'username profile.displayName profile.avatar');

    res.status(200).json({
      success: true,
      message: 'Scrim updated successfully',
      data: {
        scrim
      }
    });
  } catch (error) {
    log.error('Error updating scrim:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to update scrim',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Delete scrim
const deleteScrim = async (req, res) => {
  try {
    const scrim = await findScrimByIdOrCode(req.params.id);

    if (!scrim) {
      return res.status(404).json({
        success: false,
        message: 'Scrim not found'
      });
    }

    // Check if user is the host
    if (scrim.host.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Only scrim host can delete scrim'
      });
    }

    await scrim.deleteOne();

    res.status(200).json({
      success: true,
      message: 'Scrim deleted successfully'
    });
  } catch (error) {
    log.error('Error deleting scrim:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to delete scrim',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// Cancel scrim
const cancelScrim = async (req, res) => {
  try {
    const scrim = await findScrimByIdOrCode(req.params.id);

    if (!scrim) {
      return res.status(404).json({
        success: false,
        message: 'Scrim not found'
      });
    }

    // Check if user is the host
    if (scrim.host.toString() !== req.user._id.toString()) {
      return res.status(403).json({
        success: false,
        message: 'Only scrim host can cancel scrim'
      });
    }

    scrim.status = 'Cancelled';
    await scrim.save();

    await notifyScrimRecipients({
      scrim,
      recipients: scrim.registeredTeams,
      sender: req.user._id,
      title: `Scrim Cancelled: ${scrim.name}`,
      message: 'This scrim has been cancelled by the host.',
      eventType: 'scrim_cancelled',
      revision: 'cancelled'
    });

    res.status(200).json({
      success: true,
      message: 'Scrim cancelled successfully',
      data: {
        scrim
      }
    });
  } catch (error) {
    log.error('Error cancelling scrim:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to cancel scrim',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
};

// -----------------------------------------------------------------------------
// Prize & Final Result Management
// -----------------------------------------------------------------------------

// Update prize distribution
const updateScrimPrizeDistribution = async (req, res) => {
  try {
    const { prizeDistribution, specialPrizes } = req.body;
    const scrim = await findScrimByIdOrCode(req.params.id);

    if (!scrim) {
      return res.status(404).json({ success: false, message: 'Scrim not found' });
    }

    if (scrim.host.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Only host can update prize distribution' });
    }

    if (prizeDistribution) scrim.prizeDistribution = prizeDistribution;
    if (specialPrizes) scrim.specialPrizes = specialPrizes;

    await scrim.save();

    res.status(200).json({
      success: true,
      message: 'Prize distribution updated successfully',
      data: {
        prizeDistribution: scrim.prizeDistribution,
        specialPrizes: scrim.specialPrizes
      }
    });
  } catch (error) {
    log.error('Error updating scrim prize distribution:', { error: String(error) });
    res.status(500).json({ success: false, message: 'Failed to update prize distribution' });
  }
};

// Generate final result by compiling overall standings
const generateScrimFinalResult = async (req, res) => {
  try {
    const scrim = await findScrimByIdOrCode(req.params.id);

    if (!scrim) {
      return res.status(404).json({ success: false, message: 'Scrim not found' });
    }

    if (scrim.host.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Only host can generate final result' });
    }

    // Use existing calculateOverallStandings to ensure standings are up to date
    scrim.calculateOverallStandings();
    
    const standings = [...(scrim.overallStandings?.teams || [])];
    
    // Assign ranks and prize money based on prize distribution
    standings.forEach((team, index) => {
      // Re-assign rank just to be safe
      team.rank = index + 1;
      
      const prizeSplit = scrim.prizeDistribution.find(p => p.rank === team.rank);
      team.prizeAmount = prizeSplit ? prizeSplit.amount : 0;
    });

    scrim.finalResult = {
      standings,
      specialPrizeWinners: scrim.specialPrizes,
      generatedAt: new Date()
    };

    // Auto-mark scrim as completed if not already
    const allMatchesCompleted = scrim.matches.every(match => 
      match.status === 'Completed' || match.results?.submittedAt
    );
    
    if (scrim.status !== 'Completed' && allMatchesCompleted) {
      scrim.status = 'Completed';
    }

    await scrim.save();

    await notifyScrimRecipients({
      scrim,
      recipients: scrim.registeredTeams,
      sender: req.user._id,
      title: `Final Results: ${scrim.name}`,
      message: 'The final scrim standings are now available.',
      eventType: 'scrim_final_results',
      revision: scrim.finalResult.generatedAt
    });

    res.status(200).json({
      success: true,
      message: 'Final result generated successfully',
      data: { finalResult: scrim.finalResult }
    });
  } catch (error) {
    log.error('Error generating scrim final result:', { error: String(error) });
    res.status(500).json({ success: false, message: 'Failed to generate final result' });
  }
};

// Assign special prize winner
const assignScrimSpecialPrize = async (req, res) => {
  try {
    const { category, winnerId, winnerName } = req.body;
    const scrim = await findScrimByIdOrCode(req.params.id);

    if (!scrim) {
      return res.status(404).json({ success: false, message: 'Scrim not found' });
    }

    if (scrim.host.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Only host can assign special prizes' });
    }

    const prizeIndex = scrim.specialPrizes.findIndex(p => p.category === category);
    if (prizeIndex === -1) {
      return res.status(404).json({ success: false, message: 'Special prize category not found' });
    }

    scrim.specialPrizes[prizeIndex].winnerId = winnerId;
    scrim.specialPrizes[prizeIndex].winnerName = winnerName;

    // Optional: update finalResult if it exists
    if (scrim.finalResult && scrim.finalResult.specialPrizeWinners) {
      const frIndex = scrim.finalResult.specialPrizeWinners.findIndex(p => p.category === category);
      if (frIndex !== -1) {
        scrim.finalResult.specialPrizeWinners[frIndex].winnerId = winnerId;
        scrim.finalResult.specialPrizeWinners[frIndex].winnerName = winnerName;
      }
    }

    await scrim.save();

    res.status(200).json({
      success: true,
      message: 'Special prize assigned successfully',
      data: { specialPrizes: scrim.specialPrizes }
    });
  } catch (error) {
    log.error('Error assigning scrim special prize:', { error: String(error) });
    res.status(500).json({ success: false, message: 'Failed to assign special prize' });
  }
};

// Broadcast message to all scrim participants
const broadcastScrimMessage = async (req, res) => {
  try {
    const { message, type } = req.body;
    const scrim = await findScrimByIdOrCode(req.params.id);

    if (!scrim) {
      return res.status(404).json({ success: false, message: 'Scrim not found' });
    }

    if (scrim.host.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Only scrim host can send broadcasts' });
    }

    if (!message || !message.trim()) {
      return res.status(400).json({ success: false, message: 'Message is required' });
    }

    const senderName = req.user.profile?.displayName || req.user.username || 'Host';

    // Save broadcast to scrim document
    const broadcastEntry = {
      message: message.trim(),
      type: type || 'info',
      senderName,
      sentAt: new Date()
    };
    scrim.broadcasts = scrim.broadcasts || [];
    scrim.broadcasts.push(broadcastEntry);
    // Keep last 100 broadcasts
    if (scrim.broadcasts.length > 100) {
      scrim.broadcasts = scrim.broadcasts.slice(-100);
    }
    await scrim.save();

    // Send notification to all registered participants.
    const broadcastDeliveryKey = `scrim-broadcast:${scrim._id}:${broadcastEntry.sentAt.toISOString()}`;
    const broadcastRecipients = uniqueRecipientIds(scrim.registeredTeams);
    const notificationPromises = broadcastRecipients.map(teamId =>
      createAndEmitNotification({
        recipient: teamId,
        sender: req.user._id,
        type: 'tournament',
        title: `📢 ${scrim.name}`,
        message: message.trim(),
        data: {
          scrimId: scrim._id,
          scrimCode: scrim.scrimCode,
          broadcastType: type || 'info',
          openTab: 'broadcast',
          customData: {
            scrimId: scrim._id,
            scrimCode: scrim.scrimCode,
            broadcastType: type || 'info',
            openTab: 'broadcast',
            notificationDedupeKey: broadcastDeliveryKey,
            pushRequestId: broadcastDeliveryKey
          }
        }
      })
    );

    const notificationResults = await Promise.allSettled(notificationPromises);
    notificationResults.forEach((result, index) => {
      if (result.status === 'rejected') {
        log.error('Scrim broadcast notification failed', {
          error: String(result.reason),
          recipientId: broadcastRecipients[index],
          scrimId: String(scrim._id)
        });
      }
    });

    res.status(200).json({
      success: true,
      message: `Broadcast sent to ${scrim.registeredTeams.length} participants`,
      data: {
        sentTo: scrim.registeredTeams.length,
        broadcast: broadcastEntry,
        timestamp: new Date()
      }
    });
  } catch (error) {
    log.error('Error broadcasting scrim message:', { error: String(error) });
    res.status(500).json({ success: false, message: 'Failed to send broadcast' });
  }
};

module.exports = {
  createScrim,
  getScrims,
  getScrim,
  joinScrim,
  leaveScrim,
  submitMatchResults,
  updateScrim,
  deleteScrim,
  cancelScrim,
  updateScrimPrizeDistribution,
  generateScrimFinalResult,
  assignScrimSpecialPrize,
  broadcastScrimMessage
};
