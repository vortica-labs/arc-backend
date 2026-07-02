const { verifyToken, extractToken } = require('../utils/jwt');
const User = require('../models/User');
const mongoose = require('mongoose');
const { getJson, setJson, del } = require('../utils/redisCache');
const log = require('../utils/logger');

// ── Cache helpers ────────────────────────────────────────────────────────────
const USER_CACHE_TTL = 300; // 5 minutes
const userCacheKey = (id) => `auth:user:${id}`;

/**
 * Fetch user by ID — Redis-first, MongoDB fallback.
 * Caches user for 5 minutes to avoid hitting DB on every request.
 * @param {string} userId
 * @returns {Promise<Object|null>}
 */
async function getCachedUser(userId) {
  // 1. Try Redis
  const cached = await getJson(userCacheKey(userId));
  if (cached) {
    delete cached.password;
    delete cached.pushTokens;
    delete cached.notificationClients;
    return cached;
  }

  // 2. Hit DB
  const user = await User.findById(userId).select('-password -pushTokens -notificationClients').lean();
  if (!user) return null;

  // 3. Store in Redis for next time
  await setJson(userCacheKey(userId), user, USER_CACHE_TTL);
  return user;
}

/**
 * Invalidate a user's auth cache (call after profile updates, deactivation, etc.)
 * @param {string} userId
 */
async function invalidateUserCache(userId) {
  await del(userCacheKey(userId));
}

const sendProfileCompletionRequired = (res) => {
  return res.status(403).json({
    success: false,
    code: 'PROFILE_COMPLETION_REQUIRED',
    message: 'Complete your profile to continue.'
  });
};

// Protect routes - require authentication
const protect = async (req, res, next) => {
  try {
    // Check if database is connected
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({
        success: false,
        message: 'Database connection not ready. Please try again in a moment.'
      });
    }

    const token = extractToken(req);
    
    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Access denied. No token provided.'
      });
    }

    const decoded = verifyToken(token);
    
    if (!decoded || !decoded.id) {
      return res.status(401).json({
        success: false,
        message: 'Invalid token format.'
      });
    }

    const user = await getCachedUser(decoded.id);
    
    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'Token is valid but user no longer exists.'
      });
    }

    if (!user.isActive) {
      return res.status(401).json({
        success: false,
        message: 'User account is deactivated.'
      });
    }

    if (user.needsProfileCompletion === true && req.allowIncompleteProfile !== true) {
      return sendProfileCompletionRequired(res);
    }

    req.user = user;
    next();
  } catch (error) {
    log.error('Auth error', { error: String(error) });
    return res.status(401).json({
      success: false,
      message: 'Invalid token.'
    });
  }
};

// Authentication-only variant for the small set of onboarding-safe routes
// such as /me and /complete-profile.
const protectAllowIncomplete = (req, res, next) => {
  req.allowIncompleteProfile = true;
  return protect(req, res, next);
};

// Role-based access control
const authorize = (...roles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({
        success: false,
        message: 'Access denied. Please login first.'
      });
    }

    if (!roles.includes(req.user.userType)) {
      return res.status(403).json({
        success: false,
        message: `Access denied. This resource is only available to ${roles.join(', ')} users.`
      });
    }

    next();
  };
};

// Optional authentication - now requires at least a valid User or Guest token
const optionalAuth = async (req, res, next) => {
  try {
    const token = extractToken(req);
    
    if (!token) {
      return res.status(401).json({
        success: false,
        message: 'Access denied. Valid User or Guest token required.'
      });
    }

    try {
      const decoded = verifyToken(token);
      if (decoded && decoded.id) {
        if (decoded.userType === 'guest') {
          // Token is a valid guest token
          req.user = { _id: decoded.id, username: decoded.username, userType: 'guest' };
          return next();
        }

        // Token is a real user token — use Redis-cached lookup
        const user = await getCachedUser(decoded.id);
        
        if (user && user.isActive) {
          if (user.needsProfileCompletion === true) {
            return sendProfileCompletionRequired(res);
          }
          req.user = user;
        } else {
          return res.status(401).json({
            success: false,
            message: 'User account is deactivated or not found.'
          });
        }
      }
    } catch (tokenError) {
      return res.status(401).json({
        success: false,
        message: 'Invalid or expired token.'
      });
    }
    
    next();
  } catch (error) {
    log.error('Auth error', { error: String(error) });
    return res.status(500).json({
      success: false,
      message: 'Authentication error'
    });
  }
};

// Public-read authentication: anonymous requests continue, while a supplied
// token is still validated and attached so controllers can recognize owners.
// Keep this separate from optionalAuth because existing routes intentionally
// require either a User or Guest token through that legacy middleware.
const publicOptionalAuth = async (req, res, next) => {
  const token = extractToken(req);
  if (!token) return next();
  return optionalAuth(req, res, next);
};

// Check if user owns the resource
const checkOwnership = (resourceModel, resourceIdParam = 'id') => {
  return async (req, res, next) => {
    try {
      const resourceId = req.params[resourceIdParam];
      
      if (!resourceId) {
        return res.status(400).json({
          success: false,
          message: 'Resource ID is required.'
        });
      }

      const resource = await resourceModel.findById(resourceId);
      
      if (!resource) {
        return res.status(404).json({
          success: false,
          message: 'Resource not found.'
        });
      }

      // Check if user owns the resource
      const ownerId = resource.author || resource.sender || resource.user || resource._id;
      
      if (!ownerId) {
        return res.status(500).json({
          success: false,
          message: 'Resource ownership cannot be determined.'
        });
      }

      if (ownerId.toString() !== req.user._id.toString()) {
        return res.status(403).json({
          success: false,
          message: 'Access denied. You can only access your own resources.'
        });
      }

      req.resource = resource;
      next();
    } catch (error) {
      log.error('Auth error', { error: String(error) });
      return res.status(500).json({
        success: false,
        message: 'Error checking resource ownership.',
        error: error.message
      });
    }
  };
};

module.exports = {
  protect,
  protectAllowIncomplete,
  authorize,
  optionalAuth,
  publicOptionalAuth,
  checkOwnership,
  invalidateUserCache,
  getCachedUser
};
