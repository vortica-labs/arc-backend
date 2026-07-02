const MATCHABLE_GENDER_ALIASES = new Map([
  ['male', 'male'],
  ['m', 'male'],
  ['female', 'female'],
  ['f', 'female']
]);

/**
 * Random Connect supports only the two gender values exposed by its filter.
 * Private/other profile values remain unchanged on the user, but become an
 * empty matchmaking value instead of leaking null or an unsupported enum.
 */
const normalizeMatchmakingGender = (value) => {
  if (value === null || value === undefined) return '';
  return MATCHABLE_GENDER_ALIASES.get(String(value).trim().toLowerCase()) || '';
};

const normalizePreferredGender = (value) => normalizeMatchmakingGender(value);

const evaluateGenderCompatibility = (seeker = {}, candidate = {}) => {
  const seekerGender = normalizeMatchmakingGender(seeker.gender);
  const seekerPreference = normalizePreferredGender(seeker.preferredGender);
  const candidateGender = normalizeMatchmakingGender(candidate.gender);
  const candidatePreference = normalizePreferredGender(candidate.preferredGender);

  if (seekerPreference && candidateGender !== seekerPreference) {
    return {
      compatible: false,
      reason: candidateGender ? 'seeker_preference_mismatch' : 'candidate_gender_missing',
      seekerGender,
      seekerPreference,
      candidateGender,
      candidatePreference
    };
  }

  if (candidatePreference && seekerGender !== candidatePreference) {
    return {
      compatible: false,
      reason: seekerGender ? 'candidate_preference_mismatch' : 'seeker_gender_missing',
      seekerGender,
      seekerPreference,
      candidateGender,
      candidatePreference
    };
  }

  return {
    compatible: true,
    reason: 'compatible',
    seekerGender,
    seekerPreference,
    candidateGender,
    candidatePreference
  };
};

// Waiting rows expire quickly, but recognize legacy/cached values during a
// rolling deployment while all new writes are canonicalized by the model.
const buildGenderCandidateQuery = (preference) => {
  const normalized = normalizePreferredGender(preference);
  if (!normalized) return null;
  return normalized === 'male'
    ? /^\s*(?:male|m)\s*$/i
    : /^\s*(?:female|f)\s*$/i;
};

// Apply the reverse preference before MATCH_BATCH_LIMIT so a large queue of
// incompatible users cannot hide a valid mutual match just beyond the batch.
const buildCompatiblePreferenceQuery = (seekerGender) => {
  const genderQuery = buildGenderCandidateQuery(seekerGender);
  const accepted = [
    { preferredGender: '' },
    { preferredGender: null },
    { preferredGender: { $exists: false } }
  ];
  if (genderQuery) accepted.push({ preferredGender: genderQuery });
  return { $or: accepted };
};

module.exports = {
  normalizeMatchmakingGender,
  normalizePreferredGender,
  evaluateGenderCompatibility,
  buildGenderCandidateQuery,
  buildCompatiblePreferenceQuery
};
