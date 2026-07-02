const { del } = require('./redisCache');

const profileCacheKey = (identifier) => `profile:${identifier}`;

const invalidateProfileCache = async (...identifiers) => {
  const uniqueIdentifiers = [...new Set(
    identifiers
      .flat()
      .filter((identifier) => identifier !== undefined && identifier !== null && String(identifier).trim())
      .map((identifier) => String(identifier).trim())
  )];
  await Promise.all(uniqueIdentifiers.map((identifier) => del(profileCacheKey(identifier))));
};

module.exports = {
  profileCacheKey,
  invalidateProfileCache
};
