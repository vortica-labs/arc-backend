const toPlainObject = (value) => {
  if (!value) return value;
  return typeof value.toObject === 'function'
    ? value.toObject({ virtuals: true })
    : { ...value };
};

const minimalTournamentUser = (value) => {
  if (!value) return value;
  if (typeof value !== 'object') return value;
  const source = toPlainObject(value);
  if (!source?._id && !source?.username && !source?.profile) {
    return typeof value.toString === 'function' ? value.toString() : value;
  }
  const avatar = source.profile?.avatar
    || source.profilePicture
    || source.avatar
    || '';
  return {
    _id: source._id,
    username: source.username || '',
    ...(source.userType ? { userType: source.userType } : {}),
    profile: {
      displayName: source.profile?.displayName || source.username || '',
      avatar
    },
    profilePicture: avatar,
    avatar
  };
};

const sanitizeMatch = (match = {}) => {
  const safe = { ...match };
  for (const key of ['team1', 'team2', 'winner']) {
    if (safe[key] && typeof safe[key] === 'object') {
      safe[key] = minimalTournamentUser(safe[key]);
    }
  }
  // These fields are host-only audit/workflow metadata and are not required
  // to render a public match schedule.
  delete safe.createdBy;
  delete safe.lastModifiedBy;
  delete safe.originalScheduledTime;
  delete safe.rescheduleReason;
  return safe;
};

/**
 * Public tournament endpoints are shareable by design. Keep competition data
 * public, but never serialize team profile internals, chat history, channel
 * identifiers, or host-only workflow metadata through those endpoints.
 */
const sanitizePublicTournament = (value) => {
  if (!value) return value;
  const tournament = toPlainObject(value);
  const safe = { ...tournament };

  if (safe.host && typeof safe.host === 'object') {
    safe.host = minimalTournamentUser(safe.host);
  }
  safe.participants = Array.isArray(safe.participants)
    ? safe.participants.map(minimalTournamentUser).filter(Boolean)
    : [];
  safe.teams = Array.isArray(safe.teams)
    ? safe.teams.map(minimalTournamentUser).filter(Boolean)
    : [];
  safe.groups = Array.isArray(safe.groups)
    ? safe.groups.map((group) => {
        const sanitizedGroup = {
          ...group,
          participants: Array.isArray(group?.participants)
            ? group.participants.map(minimalTournamentUser).filter(Boolean)
            : []
        };
        delete sanitizedGroup.broadcastChannelId;
        return sanitizedGroup;
      })
    : [];
  safe.matches = Array.isArray(safe.matches) ? safe.matches.map(sanitizeMatch) : [];
  safe.winners = Array.isArray(safe.winners)
    ? safe.winners.map((winner) => ({
        ...winner,
        team: winner?.team && typeof winner.team === 'object'
          ? minimalTournamentUser(winner.team)
          : winner?.team
      }))
    : [];

  // Chat data has dedicated authenticated, membership-authorized endpoints.
  delete safe.tournamentMessages;
  delete safe.groupMessages;
  delete safe.broadcastChannels;

  return safe;
};

const sanitizePublicScrim = (value) => {
  if (!value) return value;
  const source = toPlainObject(value);
  const safe = { ...source };
  if (safe.host && typeof safe.host === 'object') {
    safe.host = minimalTournamentUser(safe.host);
  }
  safe.registeredTeams = Array.isArray(safe.registeredTeams)
    ? safe.registeredTeams.map(minimalTournamentUser).filter(Boolean)
    : [];
  // Broadcast text is delivered to registered participants through their
  // notification inbox; public share links must not become a chat archive.
  delete safe.broadcasts;
  return safe;
};

module.exports = {
  minimalTournamentUser,
  sanitizePublicTournament,
  sanitizePublicScrim
};
