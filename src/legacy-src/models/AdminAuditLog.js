const mongoose = require('mongoose');

const adminAuditLogSchema = new mongoose.Schema({
  actor: {
    actorKey: {
      type: String,
      required: true,
      default: 'hardcoded:admin',
      index: true
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    },
    username: {
      type: String,
      default: 'admin',
      index: true
    },
    role: {
      type: String,
      default: 'super_admin',
      index: true
    },
    permissions: [{
      type: String
    }]
  },
  action: {
    type: String,
    required: true,
    index: true
  },
  resourceType: {
    type: String,
    default: 'system',
    index: true
  },
  resourceId: {
    type: String,
    default: '',
    index: true
  },
  method: {
    type: String,
    default: ''
  },
  path: {
    type: String,
    default: ''
  },
  statusCode: {
    type: Number,
    default: 0,
    index: true
  },
  request: {
    query: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    },
    body: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    }
  },
  before: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  after: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  ip: {
    type: String,
    default: '',
    index: true
  },
  userAgent: {
    type: String,
    default: ''
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, {
  timestamps: true
});

adminAuditLogSchema.index({ createdAt: -1 });
adminAuditLogSchema.index({ action: 1, createdAt: -1 });
adminAuditLogSchema.index({ resourceType: 1, resourceId: 1, createdAt: -1 });

const rejectMutation = function(next) {
  next(new Error('Admin audit logs are immutable'));
};

adminAuditLogSchema.pre('updateOne', rejectMutation);
adminAuditLogSchema.pre('updateMany', rejectMutation);
adminAuditLogSchema.pre('findOneAndUpdate', rejectMutation);
adminAuditLogSchema.pre('replaceOne', rejectMutation);
adminAuditLogSchema.pre('findOneAndReplace', rejectMutation);
adminAuditLogSchema.pre('deleteOne', rejectMutation);
adminAuditLogSchema.pre('deleteOne', { document: true, query: false }, rejectMutation);
adminAuditLogSchema.pre('deleteMany', rejectMutation);
adminAuditLogSchema.pre('findOneAndDelete', rejectMutation);
adminAuditLogSchema.pre('save', function(next) {
  if (!this.isNew) return next(new Error('Admin audit logs are immutable'));
  return next();
});
adminAuditLogSchema.pre('bulkWrite', function(next, operations) {
  if ((operations || []).some((operation) => !operation.insertOne)) {
    return next(new Error('Admin audit logs are immutable'));
  }
  return next();
});

module.exports = mongoose.model('AdminAuditLog', adminAuditLogSchema);
