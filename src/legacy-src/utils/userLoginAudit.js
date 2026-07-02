const mongoose = require('mongoose');
const UserLoginEvent = require('../models/UserLoginEvent');
const log = require('./logger');

const AUTH_METHODS = new Set(UserLoginEvent.AUTH_METHODS);
const PLATFORM_ALIASES = new Map([
  ['android', 'android'],
  ['ios', 'ios'],
  ['iphone', 'ios'],
  ['ipad', 'ios'],
  ['web', 'web'],
  ['browser', 'web'],
  ['desktop', 'web'],
]);

const boundedText = (value, maxLength) => String(value || '')
  .replace(/[\u0000-\u001f\u007f]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, maxLength);

const requestHeader = (request, name) => {
  if (!request) return '';
  const viaGetter = typeof request.get === 'function' ? request.get(name) : '';
  if (viaGetter) return viaGetter;
  return request.headers?.[name.toLowerCase()] || '';
};

const inferPlatform = (request, userAgent) => {
  const explicit = boundedText(
    requestHeader(request, 'x-client-platform')
      || requestHeader(request, 'x-app-platform')
      || requestHeader(request, 'x-platform'),
    24,
  ).toLowerCase();
  if (PLATFORM_ALIASES.has(explicit)) return PLATFORM_ALIASES.get(explicit);
  if (/android/i.test(userAgent)) return 'android';
  if (/iphone|ipad|ipod/i.test(userAgent)) return 'ios';
  if (userAgent) return 'web';
  return 'unknown';
};

const inferDevice = (request, userAgent, platform) => {
  const explicit = requestHeader(request, 'x-device-name')
    || requestHeader(request, 'x-device-model')
    || requestHeader(request, 'x-client-device');
  if (explicit) return boundedText(explicit, 120);
  if (/ipad/i.test(userAgent)) return 'iPad';
  if (/iphone|ipod/i.test(userAgent)) return 'iPhone';
  if (platform === 'android') return 'Android device';
  if (platform === 'web') return 'Web browser';
  return '';
};

const safeLoginEvent = ({ user, authMethod, request }) => {
  const userId = user?._id || user;
  if (!AUTH_METHODS.has(authMethod) || !mongoose.Types.ObjectId.isValid(userId)) return null;
  const userAgent = boundedText(requestHeader(request, 'user-agent'), 512);
  const platform = inferPlatform(request, userAgent);
  return {
    user: userId,
    authMethod,
    timestamp: new Date(),
    ip: boundedText(request?.ip || request?.socket?.remoteAddress || request?.connection?.remoteAddress, 64),
    userAgent,
    platform,
    device: inferDevice(request, userAgent, platform),
  };
};

const createLoginEventRecorder = ({
  model = UserLoginEvent,
  connection = mongoose.connection,
  logger = log,
} = {}) => async (input) => {
  try {
    if (connection?.readyState !== 1) return false;
    const event = safeLoginEvent(input || {});
    if (!event) return false;
    await model.create(event);
    return true;
  } catch (error) {
    try {
      logger?.warn?.('Successful login audit could not be stored', {
        code: boundedText(error?.code || error?.name || 'LOGIN_AUDIT_WRITE_FAILED', 80),
      });
    } catch (_) {
      // Auditing and audit diagnostics are both fail-open for login availability.
    }
    return false;
  }
};

const recordSuccessfulLogin = createLoginEventRecorder();

module.exports = {
  boundedText,
  createLoginEventRecorder,
  recordSuccessfulLogin,
  safeLoginEvent,
};
