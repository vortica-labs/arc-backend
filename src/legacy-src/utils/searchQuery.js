const normalizeQuerySearch = (value) => {
  const raw = value ?? '';
  const normalized = Array.isArray(raw) ? raw[0] : raw;
  return typeof normalized === 'string' ? normalized.trim() : '';
};

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const buildPrefixRegex = (value) => {
  const term = normalizeQuerySearch(value);
  if (!term) return '';
  return `^${escapeRegex(term)}`;
};

module.exports = {
  normalizeQuerySearch,
  escapeRegex,
  buildPrefixRegex,
};
