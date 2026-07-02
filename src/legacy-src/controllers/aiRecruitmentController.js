const { GoogleGenerativeAI } = require('@google/generative-ai');
const TeamRecruitment = require('../models/TeamRecruitment');
const PlayerProfile = require('../models/PlayerProfile');
const RecruitmentApplication = require('../models/RecruitmentApplication');
const User = require('../models/User');
const safeAsyncHandler = require('../utils/safeAsyncHandler');
const log = require('../utils/logger');

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

/**
 * Calculate compatibility score based on data (without AI for fallback)
 */
const calculateCompatibilityScore = (candidate, requirements) => {
  let score = 50; // Base score
  
  // Rank matching (if requirements have rank)
  if (requirements.experienceLevel && candidate.rank) {
    const rankMatch = candidate.rank.toLowerCase().includes(requirements.experienceLevel.toLowerCase()) ||
                     requirements.experienceLevel.toLowerCase().includes(candidate.rank.toLowerCase());
    if (rankMatch) score += 15;
  }
  
  // K/D ratio bonus
  if (candidate.kdRatio && candidate.kdRatio >= 2.0) score += 10;
  else if (candidate.kdRatio && candidate.kdRatio >= 1.5) score += 5;
  
  // Win rate bonus
  if (candidate.winRate && candidate.winRate >= 60) score += 10;
  else if (candidate.winRate && candidate.winRate >= 50) score += 5;
  
  // Tournament experience
  if (candidate.tournamentExperience && candidate.tournamentExperience !== 'Not specified') {
    if (candidate.tournamentExperience.toLowerCase().includes('professional') || 
        candidate.tournamentExperience.toLowerCase().includes('competitive')) {
      score += 10;
    }
  }
  
  // Availability match
  if (requirements.dailyPlayingTime && candidate.availability) {
    if (candidate.availability.toLowerCase().includes('full') || 
        candidate.availability.toLowerCase().includes('available')) {
      score += 5;
    }
  }
  
  return Math.min(100, Math.max(0, score));
};

/**
 * Match players to team requirements using AI
 */
const matchPlayersToTeam = safeAsyncHandler(async (req, res) => {
  try {
    const { teamId, game, role, requirements, limit = 10, recruitmentId } = req.body;
    const userId = req.user._id;

    if (req.user.userType !== 'team') {
      return res.status(403).json({ success: false, message: 'Only teams can match recruitment candidates' });
    }

    if (teamId && teamId.toString() !== userId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'You can only match candidates for your own team'
      });
    }

    const actualTeamId = teamId || userId;

    // Get team's recruitment requirements if recruitmentId provided
    let teamRequirements = requirements || {};
    let actualGame = game;
    let actualRole = role;
    
    if (recruitmentId) {
      const recruitment = await TeamRecruitment.findById(recruitmentId)
        .populate('team', 'username profile.displayName');
      
      if (!recruitment) {
        return res.status(404).json({
          success: false,
          message: 'Recruitment post not found'
        });
      }

      if (recruitment.team._id.toString() !== actualTeamId.toString()) {
        return res.status(403).json({
          success: false,
          message: 'You can only match players for your own recruitment posts'
        });
      }

      actualGame = recruitment.game;
      actualRole = recruitment.role || recruitment.staffRole;
      teamRequirements = {
        ...recruitment.requirements,
        game: recruitment.game,
        role: actualRole
      };
    }

    if (!actualGame || !actualRole) {
      return res.status(400).json({
        success: false,
        message: 'Game and role are required'
      });
    }

    // Find matching player profiles - More flexible search
    const playerProfiles = await PlayerProfile.find({
      profileType: 'looking-for-team',
      game: actualGame,
      status: 'active',
      isActive: true
    })
      .populate('player', 'username profile.displayName profile.avatar profile.location playerInfo.gamingStats')
      .limit(100); // Get more candidates

    // Filter by role if specified
    const filteredProfiles = actualRole 
      ? playerProfiles.filter(p => 
          p.role && p.role.toLowerCase().includes(actualRole.toLowerCase()) ||
          actualRole.toLowerCase().includes(p.role?.toLowerCase() || '')
        )
      : playerProfiles;

    if (filteredProfiles.length === 0) {
      return res.status(200).json({
        success: true,
        message: 'No matching players found',
        data: {
          matches: [],
          totalFound: 0,
          game: actualGame,
          role: actualRole
        }
      });
    }

    // Prepare comprehensive data for AI analysis
    const candidatesData = await Promise.all(
      filteredProfiles.map(async (profile) => {
        const player = profile.player;
        const gamingStats = player.playerInfo?.gamingStats?.find(stat => stat.game === actualGame) || {};
        
        // Calculate base compatibility score
        const baseScore = calculateCompatibilityScore({
          rank: profile.playerInfo?.currentRank || gamingStats.currentTier || '',
          kdRatio: gamingStats.fdRatio || gamingStats.kd,
          winRate: gamingStats.winRate,
          tournamentExperience: profile.playerInfo?.tournamentExperience || '',
          availability: profile.playerInfo?.availability || ''
        }, teamRequirements);
        
        return {
          playerId: player._id.toString(),
          playerName: player.profile?.displayName || player.username,
          profileId: profile._id.toString(),
          role: profile.role || 'Not specified',
          rank: profile.playerInfo?.currentRank || gamingStats.currentTier || gamingStats.rank || 'Not specified',
          experience: profile.playerInfo?.experienceLevel || 'Not specified',
          tournamentExperience: profile.playerInfo?.tournamentExperience || 'Not specified',
          achievements: profile.playerInfo?.achievements || 'Not specified',
          availability: profile.playerInfo?.availability || 'Not specified',
          languages: profile.playerInfo?.languages || 'Not specified',
          location: player.profile?.location || 'Not specified',
          expectedSalary: profile.expectations?.expectedSalary || 'Not specified',
          preferredLocation: profile.expectations?.preferredLocation || 'Not specified',
          additionalInfo: profile.playerInfo?.additionalInfo || '',
          // Gaming stats
          kdRatio: gamingStats.fdRatio || gamingStats.kd || null,
          winRate: gamingStats.winRate || null,
          inGameName: gamingStats.inGameName || profile.playerInfo?.playerName || 'Not specified',
          // Valorant specific
          valorantRank: gamingStats.rank || null,
          valorantRR: gamingStats.rr || null,
          peakRank: gamingStats.peakRank || null,
          // Base score for fallback
          baseScore: baseScore
        };
      })
    );

    // Sort by base score first (pre-filter)
    candidatesData.sort((a, b) => (b.baseScore || 0) - (a.baseScore || 0));
    const topCandidates = candidatesData.slice(0, Math.min(30, candidatesData.length));

    // Create professional AI prompt
    const requirementsSummary = teamRequirements 
      ? Object.entries(teamRequirements)
          .filter(([key, value]) => value && value !== 'Not specified' && key !== 'game' && key !== 'role')
          .map(([key, value]) => `${key}: ${value}`)
          .join(', ')
      : 'No specific requirements';

    const aiPrompt = `You are a professional esports recruitment analyst. Your job is to analyze gaming players and match them to team requirements.

TEAM REQUIREMENTS:
Game: ${actualGame}
Role Needed: ${actualRole}
Additional Requirements: ${requirementsSummary || 'None specified'}

CANDIDATES TO ANALYZE (${topCandidates.length} players):
${JSON.stringify(topCandidates.map(c => ({
  name: c.playerName,
  role: c.role,
  rank: c.rank,
  kdRatio: c.kdRatio,
  winRate: c.winRate,
  tournamentExperience: c.tournamentExperience,
  availability: c.availability,
  location: c.location,
  expectedSalary: c.expectedSalary
})), null, 2)}

ANALYSIS CRITERIA:
1. Role Match (30 points): Does their role match what team needs?
2. Skill Level (25 points): Rank, K/D ratio, win rate
3. Experience (20 points): Tournament experience, achievements
4. Availability (15 points): Can they commit time?
5. Location/Salary (10 points): Practical considerations

TASK:
Analyze each candidate and return a JSON array with:
- compatibilityScore (0-100): Overall match quality
- rank (1-N): Best to worst match
- strengths: 2-3 key strengths
- concerns: Any red flags or concerns
- reasoning: 1-2 sentence explanation

Return ONLY valid JSON array, maximum ${limit} candidates:
[
  {
    "playerId": "exact_playerId_from_data",
    "compatibilityScore": 85,
    "rank": 1,
    "strengths": ["High K/D ratio (2.5)", "Professional tournament experience"],
    "concerns": [],
    "reasoning": "Strong candidate with excellent stats and relevant experience for the role."
  }
]

IMPORTANT: Use exact playerId values from the candidates data. Be realistic with scores - only give 80+ to truly exceptional matches.`;

    // Call AI with better error handling
    let matches = [];
    try {
      const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
      const result = await model.generateContent(aiPrompt);
      const aiResponse = result.response.text();

      // Parse AI response
      const jsonMatch = aiResponse.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        matches = JSON.parse(jsonMatch[0]);
      } else {
        matches = JSON.parse(aiResponse);
      }

      // Validate matches
      if (!Array.isArray(matches)) {
        throw new Error('Invalid response format');
      }

      // Ensure all required fields
      matches = matches.map(m => ({
        ...m,
        strengths: m.strengths || [],
        concerns: m.concerns || [],
        reasoning: m.reasoning || 'Analysis completed'
      }));

    } catch (aiError) {
      log.error('AI analysis error:', { error: String(aiError) });
      // Fallback: Use calculated scores
      matches = topCandidates
        .slice(0, limit)
        .map((candidate, index) => ({
          playerId: candidate.playerId,
          compatibilityScore: candidate.baseScore || (70 - index * 3),
          rank: index + 1,
          strengths: [
            candidate.kdRatio ? `K/D: ${candidate.kdRatio}` : null,
            candidate.winRate ? `Win Rate: ${candidate.winRate}%` : null,
            candidate.tournamentExperience !== 'Not specified' ? 'Tournament experience' : null
          ].filter(Boolean),
          concerns: candidate.availability === 'Not specified' ? ['Availability unclear'] : [],
          reasoning: `Based on stats: ${candidate.rank} rank, ${candidate.kdRatio ? `K/D ${candidate.kdRatio}` : 'stats available'}`
        }));
    }

    // Enrich matches with full player data
    const enrichedMatches = matches
      .map(match => {
        const candidate = candidatesData.find(c => c.playerId === match.playerId);
        const profile = filteredProfiles.find(p => p.player._id.toString() === match.playerId);
        
        if (!candidate || !profile) return null;
        
        return {
          ...match,
          player: {
            _id: candidate.playerId,
            username: candidate.playerName,
            profile: {
              displayName: candidate.playerName,
              avatar: profile?.player?.profile?.avatar || null,
              location: candidate.location
            }
          },
          profile: {
            _id: candidate.profileId,
            role: candidate.role,
            rank: candidate.rank,
            experience: candidate.experience,
            tournamentExperience: candidate.tournamentExperience,
            achievements: candidate.achievements,
            availability: candidate.availability,
            languages: candidate.languages,
            kdRatio: candidate.kdRatio,
            winRate: candidate.winRate,
            inGameName: candidate.inGameName
          },
          expectations: {
            expectedSalary: candidate.expectedSalary,
            preferredLocation: candidate.preferredLocation
          }
        };
      })
      .filter(Boolean); // Remove nulls

    res.status(200).json({
      success: true,
      message: `Found ${enrichedMatches.length} matching players`,
      data: {
        matches: enrichedMatches,
        totalFound: filteredProfiles.length,
        game: actualGame,
        role: actualRole
      }
    });

  } catch (error) {
    log.error('Error matching players:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to match players',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * Analyze a player application using AI
 */
const analyzeApplication = safeAsyncHandler(async (req, res) => {
  try {
    const { applicationId } = req.body;
    const userId = req.user._id;

    // Get application with full data
    const application = await RecruitmentApplication.findById(applicationId)
      .populate('applicant', 'username profile.displayName profile.avatar profile.location playerInfo.gamingStats')
      .populate({
        path: 'recruitment',
        populate: {
          path: 'team',
          select: 'username profile.displayName teamInfo.teamType'
        }
      });

    if (!application) {
      return res.status(404).json({
        success: false,
        message: 'Application not found'
      });
    }

    // Verify team ownership
    const recruitment = await TeamRecruitment.findById(application.recruitment._id);
    if (recruitment.team.toString() !== userId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'You can only analyze applications for your own recruitment posts'
      });
    }

    // Get player profile
    const playerProfile = await PlayerProfile.findOne({
      player: application.applicant._id,
      game: recruitment.game
    });

    const applicant = application.applicant;
    const gamingStats = applicant.playerInfo?.gamingStats?.find(stat => stat.game === recruitment.game) || {};

    // Prepare comprehensive application data
    const applicationData = {
      applicant: {
        name: applicant.profile?.displayName || applicant.username,
        location: applicant.profile?.location || 'Not specified',
        role: playerProfile?.role || 'Not specified',
        rank: playerProfile?.playerInfo?.currentRank || gamingStats.currentTier || gamingStats.rank || 'Not specified',
        experience: playerProfile?.playerInfo?.experienceLevel || 'Not specified',
        tournamentExperience: playerProfile?.playerInfo?.tournamentExperience || 'Not specified',
        achievements: playerProfile?.playerInfo?.achievements || 'Not specified',
        kdRatio: gamingStats.fdRatio || gamingStats.kd || null,
        winRate: gamingStats.winRate || null,
        availability: playerProfile?.playerInfo?.availability || 'Not specified',
        languages: playerProfile?.playerInfo?.languages || 'Not specified',
        inGameName: gamingStats.inGameName || playerProfile?.playerInfo?.playerName || 'Not specified'
      },
      application: {
        message: application.message || 'No message provided',
        resume: application.resume || 'No resume provided',
        portfolio: application.portfolio || 'No portfolio provided'
      },
      requirements: recruitment.requirements,
      benefits: recruitment.benefits,
      position: {
        game: recruitment.game,
        role: recruitment.role || recruitment.staffRole
      }
    };

    // Create professional AI prompt
    const aiPrompt = `You are a professional esports recruitment analyst. Analyze this player application.

POSITION DETAILS:
Game: ${recruitment.game}
Role: ${recruitment.role || recruitment.staffRole}
Team Type: ${recruitment.team?.teamInfo?.teamType || 'Competitive'}

REQUIREMENTS:
${JSON.stringify(recruitment.requirements, null, 2)}

APPLICANT PROFILE:
Name: ${applicationData.applicant.name}
Role: ${applicationData.applicant.role}
Rank: ${applicationData.applicant.rank}
K/D Ratio: ${applicationData.applicant.kdRatio || 'Not available'}
Win Rate: ${applicationData.applicant.winRate ? applicationData.applicant.winRate + '%' : 'Not available'}
Tournament Experience: ${applicationData.applicant.tournamentExperience}
Availability: ${applicationData.applicant.availability}
Location: ${applicationData.applicant.location}
Languages: ${applicationData.applicant.languages}

APPLICATION MESSAGE:
"${applicationData.application.message}"

ANALYSIS TASK:
1. Calculate fit score (0-100) based on:
   - Role match (30 points)
   - Skill level/rank (25 points)
   - Experience (20 points)
   - Availability (15 points)
   - Application quality (10 points)

2. Identify 2-4 key strengths
3. Identify 1-3 concerns or gaps
4. Provide recommendation: "Strong Match" (80+), "Good Match" (65-79), "Average Match" (50-64), "Weak Match" (<50)
5. Generate 5-7 specific interview questions

Return ONLY valid JSON:
{
  "fitScore": 75,
  "recommendation": "Good Match",
  "strengths": ["High K/D ratio (2.3)", "Professional tournament experience"],
  "concerns": ["Availability needs clarification"],
  "reasoning": "Strong candidate with good stats and experience. Main concern is availability commitment.",
  "interviewQuestions": [
    "What is your daily practice schedule?",
    "How do you handle in-game pressure situations?",
    "Describe your experience in competitive tournaments."
  ]
}`;

    // Call AI
    let analysis = {};
    try {
      const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
      const result = await model.generateContent(aiPrompt);
      const aiResponse = result.response.text();

      const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        analysis = JSON.parse(jsonMatch[0]);
      } else {
        analysis = JSON.parse(aiResponse);
      }

      // Validate and ensure all fields
      analysis = {
        fitScore: analysis.fitScore || 50,
        recommendation: analysis.recommendation || 'Average Match',
        strengths: analysis.strengths || [],
        concerns: analysis.concerns || [],
        reasoning: analysis.reasoning || 'Analysis completed',
        interviewQuestions: analysis.interviewQuestions || []
      };

    } catch (aiError) {
      log.error('AI analysis error:', { error: String(aiError) });
      // Fallback analysis
      const baseScore = calculateCompatibilityScore({
        rank: applicationData.applicant.rank,
        kdRatio: applicationData.applicant.kdRatio,
        winRate: applicationData.applicant.winRate,
        tournamentExperience: applicationData.applicant.tournamentExperience,
        availability: applicationData.applicant.availability
      }, recruitment.requirements);

      analysis = {
        fitScore: baseScore,
        recommendation: baseScore >= 80 ? 'Strong Match' : baseScore >= 65 ? 'Good Match' : baseScore >= 50 ? 'Average Match' : 'Weak Match',
        strengths: [
          applicationData.applicant.kdRatio ? `K/D Ratio: ${applicationData.applicant.kdRatio}` : null,
          applicationData.applicant.tournamentExperience !== 'Not specified' ? 'Has tournament experience' : null
        ].filter(Boolean),
        concerns: applicationData.applicant.availability === 'Not specified' ? ['Availability unclear'] : [],
        reasoning: `Based on available data: Rank ${applicationData.applicant.rank}, ${applicationData.applicant.kdRatio ? `K/D ${applicationData.applicant.kdRatio}` : 'stats available'}`,
        interviewQuestions: [
          `What is your experience with ${recruitment.game}?`,
          `Why are you interested in the ${recruitment.role || recruitment.staffRole} role?`,
          'What is your availability for practice and tournaments?'
        ]
      };
    }

    res.status(200).json({
      success: true,
      message: 'Application analyzed successfully',
      data: {
        analysis,
        application: {
          _id: application._id,
          message: application.message,
          status: application.status
        },
        applicant: {
          _id: applicant._id,
          username: applicant.username,
          profile: applicant.profile
        }
      }
    });

  } catch (error) {
    log.error('Error analyzing application:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to analyze application',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * Generate recruitment post content using AI
 */
const generateRecruitmentPost = safeAsyncHandler(async (req, res) => {
  try {
    const { game, role, requirements, benefits, postType = 'professional' } = req.body;
    const userId = req.user._id;

    if (!game || !role) {
      return res.status(400).json({
        success: false,
        message: 'Game and role are required'
      });
    }

    // Get team info for context
    const team = await User.findById(userId);
    if (!team || team.userType !== 'team') {
      return res.status(403).json({
        success: false,
        message: 'Only teams can generate recruitment posts'
      });
    }

    // Create professional AI prompt
    const requirementsText = requirements 
      ? Object.entries(requirements)
          .filter(([key, value]) => value && typeof value === 'string' && value.trim())
          .map(([key, value]) => `- ${key}: ${value}`)
          .join('\n')
      : 'No specific requirements';

    const benefitsText = benefits
      ? Object.entries(benefits)
          .filter(([key, value]) => value && typeof value === 'string' && value.trim())
          .map(([key, value]) => `- ${key}: ${value}`)
          .join('\n')
      : 'Competitive compensation';

    const aiPrompt = `You are a professional esports content writer. Create a recruitment post for a gaming team.

TEAM INFO:
Team Name: ${team.profile?.displayName || team.username}
Team Type: ${team.teamInfo?.teamType || 'Competitive'}

POSITION:
Game: ${game}
Role: ${role}

REQUIREMENTS (may be in any language - extract and translate to English):
${requirementsText || 'Standard requirements apply'}

BENEFITS (may be in any language - extract and translate to English):
${benefitsText || 'Competitive compensation'}

STYLE: ${postType} (professional/casual/enthusiastic)

TASK:
Create a recruitment post with structured data that can be used to fill a recruitment form.
IMPORTANT: Extract information from requirements and benefits text intelligently. Fill ALL fields that you can extract information for. If user input is in Hindi or other language, translate it to English for additionalRequirements and benefitsAndPerks fields.

Return ONLY valid JSON (no markdown, no code blocks, just pure JSON):
{
  "title": "Recruitment Post Title (max 60 chars)",
  "content": "Full post content (150-250 words, natural tone, engaging). Write a compelling recruitment post that describes the position, what you're looking for, and why players should join.",
  "hashtags": ["#hashtag1", "#hashtag2", "#hashtag3"],
  "formData": {
    "requirements": {
      "dailyPlayingTime": "Extract from input: e.g., '4-6 hours daily', 'Flexible timing', 'Weekends only'. If not mentioned, leave empty.",
      "tournamentExperience": "Extract from input: e.g., '2 years competitive', 'Local tournaments', 'Professional experience'. If not mentioned, leave empty.",
      "requiredDevice": "Extract from input: e.g., 'Android 10+', 'iPhone 12+', 'PC with GTX 1660+'. If not mentioned, leave empty.",
      "experienceLevel": "Extract from input: e.g., '3 years', 'Intermediate', 'Advanced', 'Professional'. If not mentioned, leave empty.",
      "language": "ALWAYS use: 'English, Hindi' (standard default for all)",
      "additionalRequirements": "Extract ALL requirements from input. Write in BRIEF English sentences (2-3 sentences max). Translate to English if input is in other language. Keep it concise and professional.",
      "availability": "Extract from input: e.g., 'Full-time', 'Part-time', 'Flexible'. If not mentioned, use 'Flexible' as default."
    },
    "benefits": {
      "salary": "Extract from input: e.g., 'Competitive salary', 'Performance based', 'Negotiable'. If not mentioned, leave empty.",
      "location": "Extract from input: e.g., 'Remote', 'On-site', 'City name'. If not mentioned, leave empty.",
      "benefitsAndPerks": "Extract ALL benefits from input. Write in BRIEF English sentences (2-3 sentences max). Translate to English if input is in other language. Keep it concise.",
      "contactInformation": "Apply through this platform"
    }
  }
}

CRITICAL INSTRUCTIONS - READ CAREFULLY:

FIELD FILLING REQUIREMENTS:
1. Extract information from the input requirements and benefits text intelligently
2. Fill ALL fields in formData.requirements and formData.benefits - DO NOT leave fields empty if you can extract information
3. Analyze the input text and extract relevant information for each field
4. If user mentions playing time, extract it for dailyPlayingTime
5. If user mentions tournament experience, extract it for tournamentExperience
6. If user mentions device requirements, extract it for requiredDevice
7. If user mentions experience level, extract it for experienceLevel
8. If user mentions availability, extract it for availability field
9. If user mentions salary, extract it for salary field
10. If user mentions location, extract it for location field

LANGUAGE REQUIREMENTS:
11. additionalRequirements MUST be written in ENGLISH only, even if user input is in Hindi or other language
12. additionalRequirements should be BRIEF (2-3 sentences maximum)
13. Translate user requirements to English if needed
14. benefitsAndPerks MUST be written in ENGLISH only, even if user input is in other language
15. benefitsAndPerks should be BRIEF (2-3 sentences maximum)

FORMAT REQUIREMENTS:
16. NEVER use numbered lists (0:, 1:, 2:, etc.) in ANY field
17. NEVER use bullet points (-, *, etc.) in ANY field
18. NEVER use single characters or letters in ANY field
19. NEVER use arrays or list format in text fields
20. Write all text as natural sentences and paragraphs only
21. Each field should contain meaningful, complete sentences or phrases

DEFAULTS:
22. For language field, ALWAYS use: "English, Hindi" (standard default for all)
23. For availability field, use "Flexible" if not mentioned in input

CORRECT EXAMPLES:
- dailyPlayingTime: "4-6 hours daily"
- tournamentExperience: "2 years competitive experience"
- requiredDevice: "Android 10+ or iPhone 12+"
- experienceLevel: "Intermediate to Advanced"
- language: "English, Hindi"
- additionalRequirements: "Looking for experienced players with good communication skills. Must be available for daily practice sessions." (BRIEF, ENGLISH)
- availability: "Flexible"
- salary: "Competitive salary based on performance"
- benefitsAndPerks: "Tournament prize sharing and team support. Growth opportunities available." (BRIEF, ENGLISH)

WRONG EXAMPLES (DO NOT USE):
- "- 0: e\n- 1: x\n- 2: p" ❌
- "1. Experience\n2. Skills" ❌
- "e\nx\np\ne\nr\ni\ne\nn\nc\ne" ❌
- Single characters or letters ❌
- Long paragraphs in additionalRequirements ❌
- Non-English text in additionalRequirements ❌`;

    // Helper function to clean text from numbered lists and single characters
    const cleanText = (text) => {
      if (!text || typeof text !== 'string') return '';
      
      // Remove numbered list patterns like "- 0: e", "1. text", etc.
      let cleaned = text
        .replace(/^[\s]*[-*]\s*\d+:\s*[a-zA-Z]\s*$/gm, '') // Remove "- 0: e" (single char lines)
        .replace(/^[\s]*[-*]\s*\d+:\s*/gm, '') // Remove "- 0:", "- 1:", etc.
        .replace(/^\d+[.)]\s*/gm, '') // Remove "1.", "2.", etc.
        .replace(/^[\s]*[-*]\s*/gm, '') // Remove remaining "- " or "* "
        .split('\n')
        .filter(line => {
          // Remove lines that are just single characters or numbers
          const trimmed = line.trim();
          if (trimmed.length <= 1) return false;
          if (/^[\d\s:]+$/.test(trimmed)) return false; // Only numbers and colons
          return true;
        })
        .join('\n')
        .trim();
      
      // If cleaned text is too short or looks like garbage, return empty
      if (cleaned.length < 3) return '';
      if (/^[\d\s:-]+$/.test(cleaned)) return ''; // Only numbers, dashes, colons
      
      return cleaned;
    };

    // Call AI
    let generatedPost = {};
    try {
      const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
      const result = await model.generateContent(aiPrompt);
      const aiResponse = result.response.text();

      const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        generatedPost = JSON.parse(jsonMatch[0]);
      } else {
        generatedPost = JSON.parse(aiResponse);
      }

      // Clean formData if it exists
      if (generatedPost.formData) {
        if (generatedPost.formData.requirements) {
          Object.keys(generatedPost.formData.requirements).forEach(key => {
            if (typeof generatedPost.formData.requirements[key] === 'string') {
              generatedPost.formData.requirements[key] = cleanText(generatedPost.formData.requirements[key]);
            }
          });
        }
        if (generatedPost.formData.benefits) {
          Object.keys(generatedPost.formData.benefits).forEach(key => {
            if (typeof generatedPost.formData.benefits[key] === 'string') {
              generatedPost.formData.benefits[key] = cleanText(generatedPost.formData.benefits[key]);
            }
          });
        }
      }

      // Default common values
      const defaultLanguage = 'English, Hindi';
      const defaultAvailability = 'Flexible';
      
      // Validate and clean with smart defaults
      const defaultFormData = {
        requirements: {
          dailyPlayingTime: '',
          tournamentExperience: '',
          requiredDevice: '',
          experienceLevel: '',
          language: defaultLanguage, // Common default
          additionalRequirements: cleanText(requirementsText) || '',
          availability: defaultAvailability, // Common default
          requiredSkills: '',
          portfolioRequirements: ''
        },
        benefits: {
          salary: '',
          customSalary: '',
          location: '',
          benefitsAndPerks: cleanText(benefitsText) || '',
          contactInformation: 'Apply through this platform'
        }
      };

      // Merge AI generated data with defaults
      if (generatedPost.formData) {
        // Requirements
        if (generatedPost.formData.requirements) {
          defaultFormData.requirements = {
            dailyPlayingTime: cleanText(generatedPost.formData.requirements.dailyPlayingTime) || '',
            tournamentExperience: cleanText(generatedPost.formData.requirements.tournamentExperience) || '',
            requiredDevice: cleanText(generatedPost.formData.requirements.requiredDevice) || '',
            experienceLevel: cleanText(generatedPost.formData.requirements.experienceLevel) || '',
            language: cleanText(generatedPost.formData.requirements.language) || defaultLanguage,
            additionalRequirements: cleanText(generatedPost.formData.requirements.additionalRequirements) || cleanText(requirementsText) || '',
            availability: cleanText(generatedPost.formData.requirements.availability) || defaultAvailability,
            requiredSkills: cleanText(generatedPost.formData.requirements.requiredSkills) || '',
            portfolioRequirements: cleanText(generatedPost.formData.requirements.portfolioRequirements) || ''
          };
        }
        
        // Benefits
        if (generatedPost.formData.benefits) {
          defaultFormData.benefits = {
            salary: cleanText(generatedPost.formData.benefits.salary) || '',
            customSalary: cleanText(generatedPost.formData.benefits.customSalary) || '',
            location: cleanText(generatedPost.formData.benefits.location) || '',
            benefitsAndPerks: cleanText(generatedPost.formData.benefits.benefitsAndPerks) || cleanText(benefitsText) || '',
            contactInformation: cleanText(generatedPost.formData.benefits.contactInformation) || 'Apply through this platform'
          };
        }
      }

      generatedPost = {
        title: generatedPost.title || `${game} ${role} Recruitment`,
        content: cleanText(generatedPost.content) || `We are looking for a skilled ${role} player for ${game}. Join our team!`,
        hashtags: Array.isArray(generatedPost.hashtags) ? generatedPost.hashtags : [`#${game}`, `#${role}`, '#GamingRecruitment'],
        formData: defaultFormData // Always use cleaned and defaulted formData
      };

    } catch (aiError) {
      log.error('AI generation error:', { error: String(aiError) });
      // Professional fallback with formData structure and defaults
      const defaultLanguage = 'English, Hindi';
      const defaultAvailability = 'Flexible';
      
      const defaultFormData = {
        requirements: {
          dailyPlayingTime: '',
          tournamentExperience: '',
          requiredDevice: '',
          experienceLevel: '',
          language: defaultLanguage, // Common default
          additionalRequirements: cleanText(requirementsText) || '',
          availability: defaultAvailability, // Common default
          requiredSkills: '',
          portfolioRequirements: ''
        },
        benefits: {
          salary: '',
          customSalary: '',
          location: '',
          benefitsAndPerks: cleanText(benefitsText) || '',
          contactInformation: 'Apply through this platform'
        }
      };

      generatedPost = {
        title: `${game} ${role} Player Wanted`,
        content: `We are recruiting a skilled ${role} player for ${game}. 

${requirementsText ? `Requirements:\n${cleanText(requirementsText)}` : 'Looking for dedicated and skilled players.'}

${benefitsText ? `Benefits:\n${cleanText(benefitsText)}` : 'Competitive environment with growth opportunities.'}

Interested players can apply through this platform.`,
        hashtags: [`#${game}`, `#${role}`, '#GamingRecruitment', '#Esports'],
        formData: defaultFormData
      };
    }

    res.status(200).json({
      success: true,
      message: 'Recruitment post generated successfully',
      data: generatedPost
    });

  } catch (error) {
    log.error('Error generating post:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to generate recruitment post',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * Generate interview questions using AI
 */
const generateInterviewQuestions = safeAsyncHandler(async (req, res) => {
  try {
    const { game, role, playerProfileId } = req.body;
    const userId = req.user._id;

    if (!game || !role) {
      return res.status(400).json({
        success: false,
        message: 'Game and role are required'
      });
    }

    let playerContext = '';
    if (playerProfileId) {
      const playerProfile = await PlayerProfile.findById(playerProfileId)
        .populate('player', 'username profile.displayName playerInfo.gamingStats');
      
      if (playerProfile) {
        const stats = playerProfile.player.playerInfo?.gamingStats?.find(s => s.game === game) || {};
        playerContext = `
PLAYER PROFILE:
Name: ${playerProfile.player.profile?.displayName || playerProfile.player.username}
Rank: ${playerProfile.playerInfo?.currentRank || stats.currentTier || stats.rank || 'Not specified'}
Experience: ${playerProfile.playerInfo?.experienceLevel || 'Not specified'}
Tournament Experience: ${playerProfile.playerInfo?.tournamentExperience || 'Not specified'}
K/D Ratio: ${stats.fdRatio || stats.kd || 'Not available'}
        `;
      }
    }

    // Create professional AI prompt
    const aiPrompt = `You are an esports recruitment specialist. Generate interview questions for a gaming team position.

POSITION:
Game: ${game}
Role: ${role}
${playerContext}

TASK:
Generate 8-10 professional interview questions covering:
1. Technical skills and gameplay (2-3 questions)
2. Role-specific knowledge (2 questions)
3. Team communication and coordination (1-2 questions)
4. Tournament/competitive experience (1-2 questions)
5. Availability and commitment (1 question)
6. Problem-solving scenarios (1 question)

Make questions:
- Specific to ${game} and ${role} role
- Practical and relevant
- Not generic or obvious
- Professional but conversational

Return ONLY valid JSON:
{
  "questions": [
    {
      "category": "Technical Skills",
      "question": "Specific question text",
      "purpose": "What this evaluates"
    }
  ],
  "totalQuestions": 10
}`;

    // Call AI
    let questions = {};
    try {
      const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
      const result = await model.generateContent(aiPrompt);
      const aiResponse = result.response.text();

      const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        questions = JSON.parse(jsonMatch[0]);
      } else {
        questions = JSON.parse(aiResponse);
      }

      // Validate
      if (!questions.questions || !Array.isArray(questions.questions)) {
        throw new Error('Invalid response format');
      }

    } catch (aiError) {
      log.error('AI generation error:', { error: String(aiError) });
      // Professional fallback questions
      questions = {
        questions: [
          {
            category: 'Technical Skills',
            question: `What is your current rank in ${game} and how long have you been playing at this level?`,
            purpose: 'Assess current skill level and consistency'
          },
          {
            category: 'Role Expertise',
            question: `As a ${role}, what is your primary responsibility in ${game}?`,
            purpose: 'Evaluate role understanding'
          },
          {
            category: 'Team Play',
            question: 'How do you communicate with teammates during intense matches?',
            purpose: 'Assess communication skills'
          },
          {
            category: 'Experience',
            question: 'What competitive tournaments have you participated in?',
            purpose: 'Evaluate competitive experience'
          },
          {
            category: 'Availability',
            question: 'What is your availability for practice sessions and tournaments?',
            purpose: 'Check commitment level'
          }
        ],
        totalQuestions: 5
      };
    }

    res.status(200).json({
      success: true,
      message: 'Interview questions generated successfully',
      data: questions
    });

  } catch (error) {
    log.error('Error generating questions:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to generate interview questions',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * Rank candidates for a recruitment post
 */
const rankCandidates = safeAsyncHandler(async (req, res) => {
  try {
    const { recruitmentId } = req.body;
    const userId = req.user._id;

    // Get recruitment post
    const recruitment = await TeamRecruitment.findById(recruitmentId)
      .populate('applicants.user', 'username profile.displayName profile.avatar profile.location playerInfo.gamingStats');

    if (!recruitment) {
      return res.status(404).json({
        success: false,
        message: 'Recruitment post not found'
      });
    }

    // Verify ownership
    if (recruitment.team.toString() !== userId.toString()) {
      return res.status(403).json({
        success: false,
        message: 'You can only rank candidates for your own recruitment posts'
      });
    }

    if (!recruitment.applicants || recruitment.applicants.length === 0) {
      return res.status(200).json({
        success: true,
        message: 'No applicants to rank',
        data: {
          rankedCandidates: []
        }
      });
    }

    // Get applicant profiles with comprehensive data
    const applicantData = await Promise.all(
      recruitment.applicants.map(async (applicant) => {
        const user = applicant.user;
        const profile = await PlayerProfile.findOne({
          player: user._id,
          game: recruitment.game
        });
        const gamingStats = user.playerInfo?.gamingStats?.find(stat => stat.game === recruitment.game) || {};

        const baseScore = calculateCompatibilityScore({
          rank: profile?.playerInfo?.currentRank || gamingStats.currentTier || gamingStats.rank || '',
          kdRatio: gamingStats.fdRatio || gamingStats.kd,
          winRate: gamingStats.winRate,
          tournamentExperience: profile?.playerInfo?.tournamentExperience || '',
          availability: profile?.playerInfo?.availability || ''
        }, recruitment.requirements);

        return {
          applicantId: applicant.user._id.toString(),
          applicationId: applicant._id?.toString(),
          name: user.profile?.displayName || user.username,
          role: profile?.role || 'Not specified',
          rank: profile?.playerInfo?.currentRank || gamingStats.currentTier || gamingStats.rank || 'Not specified',
          experience: profile?.playerInfo?.experienceLevel || 'Not specified',
          tournamentExperience: profile?.playerInfo?.tournamentExperience || 'Not specified',
          achievements: profile?.playerInfo?.achievements || 'Not specified',
          kdRatio: gamingStats.fdRatio || gamingStats.kd || null,
          winRate: gamingStats.winRate || null,
          availability: profile?.playerInfo?.availability || 'Not specified',
          location: user.profile?.location || 'Not specified',
          applicationMessage: applicant.message || 'No message',
          currentStatus: applicant.status,
          baseScore: baseScore
        };
      })
    );

    // Sort by base score first
    applicantData.sort((a, b) => (b.baseScore || 0) - (a.baseScore || 0));

    // Create professional AI prompt
    const aiPrompt = `You are a professional esports recruitment analyst. Rank these candidates.

POSITION:
Game: ${recruitment.game}
Role: ${recruitment.role || recruitment.staffRole}
Requirements: ${JSON.stringify(recruitment.requirements, null, 2)}

CANDIDATES (${applicantData.length} applicants):
${JSON.stringify(applicantData.map(a => ({
  name: a.name,
  role: a.role,
  rank: a.rank,
  kdRatio: a.kdRatio,
  winRate: a.winRate,
  tournamentExperience: a.tournamentExperience,
  availability: a.availability,
  applicationMessage: a.applicationMessage.substring(0, 100)
})), null, 2)}

TASK:
Rank all candidates from best to worst match. Consider:
- Role match
- Skill level (rank, stats)
- Experience
- Application quality
- Availability

Return ONLY valid JSON array:
[
  {
    "applicantId": "exact_applicantId_from_data",
    "rank": 1,
    "compatibilityScore": 85,
    "reasoning": "Brief explanation (1 sentence)"
  }
]`;

    // Call AI
    let rankings = [];
    try {
      const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
      const result = await model.generateContent(aiPrompt);
      const aiResponse = result.response.text();

      const jsonMatch = aiResponse.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        rankings = JSON.parse(jsonMatch[0]);
      } else {
        rankings = JSON.parse(aiResponse);
      }

      // Validate
      if (!Array.isArray(rankings)) {
        throw new Error('Invalid response format');
      }

    } catch (aiError) {
      log.error('AI ranking error:', { error: String(aiError) });
      // Fallback: Use base scores
      rankings = applicantData.map((app, index) => ({
        applicantId: app.applicantId,
        rank: index + 1,
        compatibilityScore: app.baseScore || (70 - index * 5),
        reasoning: `Ranked based on stats: ${app.rank} rank, ${app.kdRatio ? `K/D ${app.kdRatio}` : 'experience available'}`
      }));
    }

    // Enrich with full data
    const rankedCandidates = rankings
      .map(ranking => {
        const applicant = applicantData.find(a => a.applicantId === ranking.applicantId);
        const application = recruitment.applicants.find(a => a.user._id.toString() === ranking.applicantId);
        
        if (!applicant) return null;
        
        return {
          ...ranking,
          applicant: {
            _id: applicant.applicantId,
            username: applicant.name,
            profile: {
              displayName: applicant.name,
              avatar: application?.user?.profile?.avatar || null,
              location: applicant.location
            }
          },
          application: {
            _id: applicant.applicationId,
            message: applicant.applicationMessage,
            status: applicant.currentStatus
          },
          stats: {
            role: applicant.role,
            rank: applicant.rank,
            experience: applicant.experience,
            tournamentExperience: applicant.tournamentExperience,
            kdRatio: applicant.kdRatio,
            winRate: applicant.winRate,
            availability: applicant.availability
          }
        };
      })
      .filter(Boolean);

    res.status(200).json({
      success: true,
      message: `Ranked ${rankedCandidates.length} candidates`,
      data: {
        rankedCandidates,
        totalApplicants: recruitment.applicants.length
      }
    });

  } catch (error) {
    log.error('Error ranking candidates:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to rank candidates',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

/**
 * Smart Search - Find candidates based on natural language description
 */
const smartSearch = safeAsyncHandler(async (req, res) => {
  try {
    const { searchType, game, role, description, teamId } = req.body;
    const userId = req.user._id;

    if (req.user.userType !== 'team' || (teamId && teamId.toString() !== userId.toString())) {
      return res.status(403).json({ success: false, message: 'Only the owning team can search recruitment candidates' });
    }
    if (!['players', 'staff'].includes(searchType)) {
      return res.status(400).json({ success: false, message: 'Search type must be players or staff' });
    }

    if (!description) {
      return res.status(400).json({
        success: false,
        message: 'Description is required'
      });
    }

    if (searchType === 'players' && !game) {
      return res.status(400).json({ success: false, message: 'Game is required when searching for players' });
    }

    // Find matching profiles
    const profileType = searchType === 'players' ? 'looking-for-team' : 'staff-position';
    const query = {
      profileType,
      status: 'active',
      isActive: true,
      $or: [
        { expiresAt: { $gt: new Date() } },
        { expiresAt: null },
        { expiresAt: { $exists: false } }
      ]
    };

    if (searchType === 'players' && role) {
      query.game = game;
      query.role = { $regex: role, $options: 'i' };
    } else if (searchType === 'staff' && role) {
      query.staffRole = role;
    } else if (searchType === 'players') {
      query.game = game;
    }

    const profiles = await PlayerProfile.find(query)
      .populate('player', 'username profile.displayName profile.avatar profile.location playerInfo.gamingStats')
      .limit(50);

    if (profiles.length === 0) {
      return res.status(200).json({
        success: true,
        message: 'No matching candidates found',
        data: {
          candidates: [],
          totalFound: 0
        }
      });
    }

    // Prepare candidate data for AI analysis
    const candidatesData = profiles.map((profile) => {
      const player = profile.player;
      const gamingStats = player.playerInfo?.gamingStats?.find(stat => stat.game === game) || {};
      
      return {
        profileId: profile._id.toString(),
        playerId: player._id.toString(),
        profileCode: profile.profileCode,
        playerName: player.profile?.displayName || player.username,
        game: profile.game,
        role: profile.role || profile.staffRole,
        rank: profile.playerInfo?.currentRank || gamingStats.currentTier || 'Not specified',
        experience: profile.playerInfo?.experienceLevel || 'Not specified',
        tournamentExperience: profile.playerInfo?.tournamentExperience || 'Not specified',
        kdRatio: gamingStats.fdRatio || gamingStats.kd || null,
        winRate: gamingStats.winRate || null,
        inGameName: gamingStats.inGameName || profile.playerInfo?.playerName || 'Not specified',
        availability: profile.playerInfo?.availability || 'Not specified',
        languages: profile.playerInfo?.languages || 'Not specified',
        additionalInfo: profile.playerInfo?.additionalInfo || '',
        expectedSalary: profile.expectations?.expectedSalary || 'Not specified',
        preferredLocation: profile.expectations?.preferredLocation || 'Not specified'
      };
    });

    // Use AI to analyze and rank candidates based on description
    const aiPrompt = `You are a professional esports recruitment analyst. Analyze candidates based on team requirements.

TEAM REQUIREMENTS (Natural Language Description):
${description}

GAME: ${game}
ROLE: ${role || 'Any'}

CANDIDATES DATA:
${JSON.stringify(candidatesData.slice(0, 30), null, 2)}

TASK:
1. Analyze each candidate against the team requirements
2. Calculate compatibility score (0-100) for each candidate
3. Generate a brief summary (2-3 sentences) for each candidate explaining why they match
4. List key strengths (2-3 points)
5. List any concerns (1-2 points if any)
6. Provide reasoning for the match score

Return ONLY valid JSON array:
[
  {
    "profileId": "candidate_profile_id",
    "compatibilityScore": 85,
    "summary": "Brief 2-3 sentence summary explaining why this candidate matches the requirements",
    "strengths": ["strength1", "strength2", "strength3"],
    "concerns": ["concern1"] or [],
    "reasoning": "Detailed reasoning for the compatibility score"
  },
  ...
]

IMPORTANT:
- Rank candidates by compatibility score (highest first)
- Summaries should be in English, brief and professional
- Focus on how candidate matches the description
- Be honest about concerns if any`;

    try {
      const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
      const result = await model.generateContent(aiPrompt);
      const aiResponse = result.response.text();

      const jsonMatch = aiResponse.match(/\[[\s\S]*\]/);
      let aiAnalysis = [];
      if (jsonMatch) {
        aiAnalysis = JSON.parse(jsonMatch[0]);
      }

      // Merge AI analysis with candidate data
      const enrichedCandidates = candidatesData.map((candidate) => {
        const analysis = aiAnalysis.find(a => a.profileId === candidate.profileId) || {
          compatibilityScore: calculateCompatibilityScore(candidate, { description }),
          summary: `${candidate.playerName} is a ${candidate.role} player for ${candidate.game} with ${candidate.experience} experience.`,
          strengths: [],
          concerns: [],
          reasoning: 'Analyzed based on available profile data.'
        };

        const profile = profiles.find(p => p._id.toString() === candidate.profileId);
        
        return {
          ...candidate,
          ...analysis,
          profile: {
            _id: candidate.profileId,
            profileType,
            game: candidate.game,
            role: searchType === 'players' ? candidate.role : undefined,
            staffRole: searchType === 'staff' ? candidate.role : undefined,
            rank: candidate.rank,
            experience: candidate.experience,
            tournamentExperience: candidate.tournamentExperience,
            kdRatio: candidate.kdRatio,
            winRate: candidate.winRate,
            inGameName: candidate.inGameName,
            profileCode: profile?.profileCode || candidate.profileCode
          },
          player: profile?.player || {
            _id: candidate.playerId,
            username: candidate.playerName,
            profile: {
              displayName: candidate.playerName
            }
          },
          expectations: {
            expectedSalary: candidate.expectedSalary,
            preferredLocation: candidate.preferredLocation
          }
        };
      });

      // Sort by compatibility score
      enrichedCandidates.sort((a, b) => (b.compatibilityScore || 0) - (a.compatibilityScore || 0));

      // Add rank
      enrichedCandidates.forEach((candidate, idx) => {
        candidate.rank = idx + 1;
      });

      res.status(200).json({
        success: true,
        message: `Found ${enrichedCandidates.length} matching candidates`,
        data: {
          candidates: enrichedCandidates.slice(0, 20), // Return top 20
          totalFound: enrichedCandidates.length
        }
      });

    } catch (aiError) {
      log.error('AI analysis error:', { error: String(aiError) });
      // Fallback: return candidates with basic scoring
      const fallbackCandidates = candidatesData.map((candidate, idx) => ({
        ...candidate,
        compatibilityScore: calculateCompatibilityScore(candidate, { description }),
        summary: `${candidate.playerName} is a ${candidate.role} player for ${candidate.game}.`,
        strengths: [],
        concerns: [],
        reasoning: 'Basic analysis based on profile data.',
        rank: idx + 1,
        profile: {
          _id: candidate.profileId,
          profileType,
          game: candidate.game,
          role: searchType === 'players' ? candidate.role : undefined,
          staffRole: searchType === 'staff' ? candidate.role : undefined
        }
      }));

      res.status(200).json({
        success: true,
        message: `Found ${fallbackCandidates.length} candidates`,
        data: {
          candidates: fallbackCandidates,
          totalFound: fallbackCandidates.length
        }
      });
    }

  } catch (error) {
    log.error('Error in smart search:', { error: String(error) });
    res.status(500).json({
      success: false,
      message: 'Failed to search candidates',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

module.exports = {
  matchPlayersToTeam,
  analyzeApplication,
  generateRecruitmentPost,
  generateInterviewQuestions,
  rankCandidates,
  smartSearch
};
