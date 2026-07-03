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

const minimalTournamentTeam = (value) => {
  const safe = minimalTournamentUser(value);
  if (!safe || typeof safe !== 'object' || !value || typeof value !== 'object') return safe;
  const source = toPlainObject(value);
  const members = Array.isArray(source?.teamInfo?.members)
    ? source.teamInfo.members
        .map((member) => {
          const memberUser = minimalTournamentUser(member?.user);
          if (!memberUser) return null;
          return {
            user: memberUser,
            ...(member?.role ? { role: String(member.role) } : {})
          };
        })
        .filter(Boolean)
    : [];

  // Clients use this minimal roster to determine whether the authenticated
  // player participates through a team. Never expose rosters, staff,
  // requirements, invitations, contact data, or other team profile internals.
  return {
    ...safe,
    teamInfo: { members }
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
    ? safe.teams.map(minimalTournamentTeam).filter(Boolean)
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

  // Mongoose materializes an empty nested finalResult object by default. The
  // Web source flow treats presence as "generated", so omit only the empty
  // placeholder and retain real published standings.
  if (safe.finalResult
    && !safe.finalResult.generatedAt
    && (!Array.isArray(safe.finalResult.standings) || safe.finalResult.standings.length === 0)) {
    delete safe.finalResult;
  }

  // Chat data has dedicated authenticated, membership-authorized endpoints.
  delete safe.tournamentMessages;
  delete safe.groupMessages;
  delete safe.broadcastChannels;
  delete safe.bannerPublicId;
  delete safe.duoRegistrationMembers;

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
  minimalTournamentTeam,
  sanitizePublicTournament,
  sanitizePublicScrim
};
