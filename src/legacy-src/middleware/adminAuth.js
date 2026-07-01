const { protect } = require('./auth');
const { randomUUID } = require('crypto');
const AdminAuditLog = require('../models/AdminAuditLog');

const ROLE_PERMISSIONS = {
  super_admin: ['*'],
  admin: ['dashboard:read', 'users:manage', 'content:manage', 'reports:manage', 'hosts:manage', 'boosts:manage', 'boost_delivery:manage', 'monetization:manage', 'broadcasts:read', 'broadcasts:manage', 'broadcasts:send', 'premium:read', 'analytics:read', 'audit:read'],
  moderator: ['dashboard:read', 'content:manage', 'reports:manage', 'users:read'],
  support: ['dashboard:read', 'users:read', 'reports:read', 'feedback:manage'],
  finance: ['dashboard:read', 'payments:read', 'boosts:read', 'boost_delivery:manage', 'monetization:manage', 'premium:read', 'premium:refund'],
  tournament_manager: ['dashboard:read', 'tournaments:manage', 'hosts:read'],
  content_moderator: ['dashboard:read', 'content:manage', 'reports:manage'],
  creator_manager: ['dashboard:read', 'monetization:manage', 'analytics:read']
};

const getAdminRole = (user) => {
  if (user?.adminRole) return user.adminRole;
  if (user?.isSuperUser) return 'super_admin';
  return 'admin';
};

const getAdminActorKey = (user) => user?._id
  ? `user:${String(user._id)}`
  : `hardcoded:${String(user?.username || 'admin').trim().toLowerCase()}`;

const getAdminPermissions = (user) => {
  const role = getAdminRole(user);
  const rolePermissions = ROLE_PERMISSIONS[role] || [];
  const explicitPermissions = Array.isArray(user?.adminPermissions) ? user.adminPermissions : [];
  return Array.from(new Set([...rolePermissions, ...explicitPermissions]));
};

const hasPermission = (user, permission) => {
  const permissions = getAdminPermissions(user);
  const [domain, action] = String(permission).split(':');
  return permissions.includes('*') ||
    permissions.includes(permission) ||
    (action === 'read' && permissions.includes(`${domain}:manage`));
};

const sanitizeForAudit = (value) => {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(sanitizeForAudit);
  return Object.entries(value).reduce((acc, [key, nestedValue]) => {
    if (/password|token|secret|authorization|cookie/i.test(key)) {
      acc[key] = '[REDACTED]';
    } else if (nestedValue && typeof nestedValue === 'object') {
      acc[key] = sanitizeForAudit(nestedValue);
    } else {
      acc[key] = nestedValue;
    }
    return acc;
  }, {});
};

const inferResource = (req) => {
  const path = req.path || req.originalUrl || '';
  const parts = path.split('/').filter(Boolean);
  return {
    resourceType: parts[0] || 'admin',
    resourceId: Object.values(req.params || {})[0] ? String(Object.values(req.params)[0]) : ''
  };
};

// Require admin access - use protect middleware before this, or use requireAdminWithAuth for standalone
const requireAdmin = (req, res, next) => {
  // Check if user is authenticated (should be done by protect middleware before this)
  if (!req.user) {
    return res.status(401).json({
      success: false,
      message: 'Authentication required. Please use protect middleware first.'
    });
  }
  
  // Check if user is admin
  if (req.user.userType !== 'admin') {
    return res.status(403).json({
      success: false,
      message: 'Admin access required. Only administrators can access this resource.'
    });
  }
  
  next();
};

const requireAdminPermission = (permission) => {
  return (req, res, next) => {
    requireAdmin(req, res, () => {
      if (!hasPermission(req.user, permission)) {
        return res.status(403).json({
          success: false,
          message: 'You do not have permission to perform this admin action.'
        });
      }
      next();
    });
  };
};

// Standalone admin middleware that includes authentication
const requireAdminWithAuth = async (req, res, next) => {
  // First authenticate
  if (!req.user) {
    return protect(req, res, () => {
      // After authentication, check admin
      if (!req.user || req.user.userType !== 'admin') {
        return res.status(403).json({
          success: false,
          message: 'Admin access required.'
        });
      }
      next();
    });
  }
  
  // User already authenticated, just check admin
  if (req.user.userType !== 'admin') {
    return res.status(403).json({
      success: false,
      message: 'Admin access required.'
    });
  }
  
  next();
};

// Require super admin access (for critical operations)
const requireSuperAdmin = (req, res, next) => {
  // First check admin access
  requireAdmin(req, res, () => {
    // Check for super admin role
    if (getAdminRole(req.user) !== 'super_admin') {
      return res.status(403).json({
        success: false,
        message: 'Super admin access required for this operation.'
      });
    }
    
    next();
  });
};

// Log admin actions for audit
const auditLog = (action) => {
  return (req, res, next) => {
    const startedAt = Date.now();

    res.on('finish', () => {
      const { resourceType, resourceId } = inferResource(req);
      AdminAuditLog.create({
        actor: {
          actorKey: getAdminActorKey(req.user),
          user: req.user?._id || null,
          username: req.user?.username || 'admin',
          role: getAdminRole(req.user),
          permissions: getAdminPermissions(req.user)
        },
        action,
        resourceType,
        resourceId,
        method: req.method,
        path: req.originalUrl || req.path,
        statusCode: res.statusCode,
        request: {
          query: sanitizeForAudit(req.query || {}),
          body: sanitizeForAudit(req.body || {})
        },
        before: res.locals?.auditBefore || null,
        after: res.locals?.auditAfter || null,
        ip: String(req.ip || req.headers['x-forwarded-for'] || ''),
        userAgent: req.get ? (req.get('user-agent') || '') : '',
        metadata: { durationMs: Date.now() - startedAt }
      }).catch((error) => {
        console.error('[ADMIN AUDIT LOG FAILED]', error.message);
      });
    });
    
    next();
  };
};

// Broadcast mutations fail closed unless an immutable intent record is
// durable. The response is held until a second immutable outcome record is
// appended, providing an audit trail even if the process dies after mutation.
const durableMutationAudit = (action) => {
  return async (req, res, next) => {
    const correlationId = randomUUID();
    const startedAt = Date.now();
    const { resourceType, resourceId } = inferResource(req);
    const base = {
      actor: {
        actorKey: getAdminActorKey(req.user),
        user: req.user?._id || null,
        username: req.user?.username || 'admin',
        role: getAdminRole(req.user),
        permissions: getAdminPermissions(req.user)
      },
      resourceType,
      resourceId,
      method: req.method,
      path: req.originalUrl || req.path,
      request: {
        query: sanitizeForAudit(req.query || {}),
        body: sanitizeForAudit(req.body || {})
      },
      ip: String(req.ip || req.headers['x-forwarded-for'] || ''),
      userAgent: req.get ? (req.get('user-agent') || '') : ''
    };
    try {
      const intent = await AdminAuditLog.create({
        ...base,
        action: `${action}_INTENT`,
        statusCode: 102,
        metadata: { phase: 'intent', correlationId }
      });
      res.locals.auditIntentId = String(intent._id);
      res.locals.auditCorrelationId = correlationId;
    } catch (error) {
      console.error('[ADMIN DURABLE AUDIT INTENT FAILED]', error.message);
      return res.status(503).json({ success: false, message: 'Audit service unavailable; admin mutation was not executed' });
    }

    const originalJson = res.json.bind(res);
    let outcomeStarted = false;
    res.json = (body) => {
      if (outcomeStarted) return res;
      outcomeStarted = true;
      const intendedStatus = res.statusCode;
      AdminAuditLog.create({
        ...base,
        action: `${action}_OUTCOME`,
        statusCode: intendedStatus,
        before: res.locals?.auditBefore || null,
        after: res.locals?.auditAfter || null,
        metadata: {
          phase: 'outcome',
          correlationId,
          intentId: res.locals.auditIntentId,
          durationMs: Date.now() - startedAt
        }
      }).then(() => originalJson(body)).catch((error) => {
        console.error('[ADMIN DURABLE AUDIT OUTCOME FAILED]', error.message);
        res.status(503);
        originalJson({ success: false, message: 'Mutation completed but its audit outcome could not be persisted', auditIntentId: res.locals.auditIntentId });
      });
      return res;
    };
    next();
  };
};

module.exports = { 
  requireAdmin, 
  requireAdminWithAuth,
  requireAdminPermission,
  requireSuperAdmin, 
  auditLog,
  durableMutationAudit,
  ROLE_PERMISSIONS,
  hasPermission,
  getAdminPermissions
};
