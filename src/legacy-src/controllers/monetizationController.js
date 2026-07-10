/**
 * Creator monetization: eligibility, apply, application status, bank details, earnings dashboard.
 */

const User = require('../models/User');
const MonetizationEligibility = require('../models/MonetizationEligibility');
const MonetizationApplication = require('../models/MonetizationApplication');
const CreatorBankDetails = require('../models/CreatorBankDetails');
const CreatorBankDetailsHistory = require('../models/CreatorBankDetailsHistory');
const CreatorPayout = require('../models/CreatorPayout');
const PayoutCycle = require('../models/PayoutCycle');
const Post = require('../models/Post');
const WithdrawalRequest = require('../models/WithdrawalRequest');
const CreatorDisbursementReservation = require('../models/CreatorDisbursementReservation');
const MonetizationApplicationTimeline = require('../models/MonetizationApplicationTimeline');
const { getOrComputeEligibility } = require('../services/MonetizationEligibilityEngine');
const { getEstimatedEarningsForCreator, getOrCreateCurrentCycle } = require('../services/CreatorEarningsCalculationService');
const log = require('../utils/logger');
const { sendInternalError } = require('../utils/internalErrorResponse');
const { normalizeAndValidateBankDetails, firstValidationMessage } = require('../utils/bankDetailsPolicy');
const {
  FINANCIAL_TRANSACTION_OPTIONS,
  startFinancialSession,
  maskedBankSnapshot
} = require('../utils/financialTransactions');
const setPrivateNoStore = (res) => res.setHeader('Cache-Control', 'private, no-store, max-age=0');
const maskEmail = (value) => {
  const [local = '', domain = ''] = String(value || '').split('@');
  return local && domain ? `${local.slice(0, 1)}${'*'.repeat(Math.max(3, Math.min(8, local.length - 1)))}@${domain}` : '';
};
const maskPaymentAddress = (value) => {
  const [local = '', handle = ''] = String(value || '').split('@');
  return local && handle ? `${local.slice(0, 1)}***@${handle}` : '';
};
const maskIdentifier = (value) => value ? `•••• ${String(value).slice(-4)}` : '';
const decryptOptional = (bank, encryptedField, legacyField) => (
  bank?.[encryptedField]
    ? CreatorBankDetails.decryptAccountNumber(bank[encryptedField])
    : String(bank?.[legacyField] || '')
);
const BANK_OWNER_SENSITIVE_SELECT = '+taxIdHash +upiId +upiIdEncrypted +paypalEmail +paypalEmailEncrypted +gstNumber +gstNumberEncrypted';

// Only errors deliberately created by this controller may control a public
// status/message. Database/driver errors sometimes expose `code`, `statusCode`,
// or sensitive infrastructure text, so never reflect their message directly.
const PUBLIC_MONETIZATION_ERRORS = Object.freeze({
  CREATOR_NOT_APPROVED: Object.freeze({
    status: 403,
    message: 'Only approved creators can submit withdrawal requests.'
  }),
  VERIFIED_BANK_DETAILS_REQUIRED: Object.freeze({
    status: 409,
    message: 'Bank details must be verified before submitting a withdrawal request.'
  }),
  BANK_DETAILS_NOT_FOUND: Object.freeze({
    status: 404,
    message: 'Bank details not found.'
  }),
  STALE_BANK_DETAILS: Object.freeze({
    status: 409,
    message: 'Bank details changed. Refresh and try again.'
  }),
  BANK_DETAILS_LOCKED_FOR_PAYOUT: Object.freeze({
    status: 409,
    message: 'Bank details cannot be changed while a payout or withdrawal is pending or processing.'
  }),
  PAYOUT_ON_HOLD: Object.freeze({
    status: 409,
    message: 'Your creator payout is currently on hold and cannot be withdrawn.'
  }),
  EARNINGS_CYCLE_NOT_FINALIZED: Object.freeze({
    status: 409,
    message: 'Current-cycle earnings cannot be withdrawn until the cycle is finalized.'
  }),
  MINIMUM_WITHDRAWAL_NOT_MET: Object.freeze({
    status: 422,
    message: 'Finalized earnings are below the payout threshold and will carry forward.'
  }),
  NO_FINALIZED_EARNINGS: Object.freeze({
    status: 409,
    message: 'No finalized, unreserved earnings are available for withdrawal.'
  }),
  DUPLICATE_WITHDRAWAL_REQUEST: Object.freeze({
    status: 409,
    message: 'A withdrawal request for this cycle already exists.'
  }),
  DISBURSEMENT_ALREADY_RESERVED: Object.freeze({
    status: 409,
    message: 'A payout or withdrawal is already reserved for this earnings cycle.'
  }),
  EARNINGS_NO_LONGER_AVAILABLE: Object.freeze({
    status: 409,
    message: 'These earnings are no longer available for withdrawal.'
  })
});

const sendPublicMonetizationError = (res, code) => {
  const response = PUBLIC_MONETIZATION_ERRORS[code];
  if (!response) return false;
  res.status(response.status).json({ success: false, code, message: response.message });
  return true;
};

function maskBankDetails(bank) {
  if (!bank) return null;
  const verificationStatus = bank.verificationStatus === 'failed' ? 'rejected' : bank.verificationStatus;
  const upiId = decryptOptional(bank, 'upiIdEncrypted', 'upiId');
  const paypalEmail = decryptOptional(bank, 'paypalEmailEncrypted', 'paypalEmail');
  const gstNumber = decryptOptional(bank, 'gstNumberEncrypted', 'gstNumber');
  return {
    accountHolderName: bank.accountHolderName,
    bankName: bank.bankName,
    ifsc: bank.ifsc,
    swiftCode: bank.swiftCode,
    branch: bank.branch,
    upiId,
    paypalEmail,
    country: bank.country || 'IN',
    gstNumber,
    lastFourDigits: bank.lastFourDigits,
    hasTaxId: Boolean(bank.taxIdEncrypted || bank.taxIdHash),
    verificationStatus,
    verificationReason: verificationStatus === 'rejected'
      ? bank.verificationReason || ''
      : '',
    verifiedAt: bank.verifiedAt,
    createdAt: bank.createdAt,
    updatedAt: bank.updatedAt,
    version: bank.version || 1
  };
}

function summarizeBankDetails(bank) {
  if (!bank) return null;
  const verificationStatus = bank.verificationStatus === 'failed' ? 'rejected' : bank.verificationStatus;
  return {
    accountHolderName: bank.accountHolderName,
    bankName: bank.bankName,
    ifsc: bank.ifsc,
    swiftCode: bank.swiftCode,
    country: bank.country || 'IN',
    lastFourDigits: bank.lastFourDigits,
    hasTaxId: Boolean(bank.taxIdHash),
    verificationStatus,
    verificationReason: verificationStatus === 'rejected' ? bank.verificationReason || '' : '',
    verifiedAt: bank.verifiedAt,
    updatedAt: bank.updatedAt,
    version: bank.version || 1
  };
}

const requestActor = (req) => ({
  actorKey: `user:${String(req.user?._id || '')}`,
  username: req.user?.username || '',
  role: 'creator',
  type: 'user'
});

const recordBankHistory = async ({ req, bank, userId, action, previous = null, next = null, reason = '', session = null }) => {
  const sanitizeSnapshot = (snapshot) => snapshot ? {
    ...snapshot,
    upiId: maskPaymentAddress(snapshot.upiId),
    paypalEmail: maskEmail(snapshot.paypalEmail),
    gstNumber: maskIdentifier(snapshot.gstNumber)
  } : null;
  const entry = {
    bankDetails: bank?._id || null,
    user: userId,
    action,
    actor: requestActor(req),
    previous: sanitizeSnapshot(previous),
    next: sanitizeSnapshot(next),
    reason,
    ip: String(req.ip || req.headers?.['x-forwarded-for'] || ''),
    userAgent: req.get ? (req.get('user-agent') || '') : ''
  };
  if (session) return CreatorBankDetailsHistory.create([entry], { session });
  return CreatorBankDetailsHistory.create(entry);
};

const hasLockedPayout = (userId) => CreatorPayout.exists({
  user: userId,
  $or: [
    { status: { $in: ['approved', 'processing'] } },
    { status: 'held', bankDetails: { $ne: null } }
  ]
});
const hasActiveWithdrawal = (userId) => WithdrawalRequest.exists({
  user: userId,
  status: { $in: ['pending', 'approved', 'processing'] }
});

function deriveCreatorStatus({ user, eligibility, application }) {
  const explicitStatus = user?.creatorMonetizationStatus;
  const knownStatuses = new Set(['not_eligible', 'eligible', 'pending', 'approved', 'rejected', 'suspended', 'disabled', 'withdrawn']);
  // The persisted status is authoritative. `isCreator` is only a compatibility
  // fallback for documents created before creatorMonetizationStatus existed.
  if (knownStatuses.has(explicitStatus)) return explicitStatus;
  if (explicitStatus == null && user?.isCreator) return 'approved';
  if (application?.status === 'pending') return 'pending';
  if (application?.status === 'rejected') return 'rejected';
  if (application?.status === 'withdrawn') return eligibility?.isEligible ? 'eligible' : 'withdrawn';
  if (eligibility?.isEligible) return 'eligible';
  return 'not_eligible';
}

async function recordTimeline({ application, user, action, actor = null, actorType = 'creator', reason = '', oldValue = null, newValue = null }) {
  if (!application || !user || !action) return;
  await MonetizationApplicationTimeline.create({
    application,
    user,
    action,
    actor,
    actorType,
    reason,
    oldValue,
    newValue
  });
}

// Only players can be creators
async function assertPlayer(req, res, next) {
  if (req.user?.userType !== 'player') {
    return res.status(403).json({ success: false, message: 'Only players can access creator monetization.' });
  }
  next();
}

/**
 * GET /api/monetization/eligibility
 * Returns eligibility for current user (on profile load).
 */
async function getEligibility(req, res) {
  try {
    const userId = req.user._id;
    const eligibility = await getOrComputeEligibility(userId, false);
    if (!eligibility) {
      return res.status(404).json({ success: false, message: 'Eligibility could not be computed.' });
    }
    res.status(200).json({
      success: true,
      data: {
        isEligible: eligibility.isEligible,
        failedConditions: eligibility.failedConditions,
        requirements: eligibility.requirements || [],
        progressPercent: eligibility.progressPercent,
        metrics: eligibility.metrics,
        lastCalculatedAt: eligibility.lastCalculatedAt
      }
    });
  } catch (err) {
    return sendInternalError({
      res,
      log,
      operation: 'Creator monetization eligibility lookup failed',
      publicMessage: 'Failed to get eligibility',
      error: err
    });
  }
}

/**
 * GET /api/monetization/application
 * Returns current user's active/latest application status.
 */
async function getApplication(req, res) {
  try {
    const userId = req.user._id;
    const app = await MonetizationApplication.findOne({ user: userId })
      .sort({ appliedAt: -1 })
      .lean();
    if (!app) {
      return res.status(200).json({
        success: true,
        data: { application: null }
      });
    }
    res.status(200).json({
      success: true,
      data: {
        application: {
          _id: app._id,
          status: app.status,
          adminRemark: app.adminRemark,
          rejectionReason: app.rejectionReason,
          appliedAt: app.appliedAt,
          reviewedAt: app.reviewedAt,
          reapplyAfter: app.reapplyAfter,
          eligibilitySnapshot: app.eligibilitySnapshot
        }
      }
    });
  } catch (err) {
    return sendInternalError({
      res,
      log,
      operation: 'Creator monetization application lookup failed',
      publicMessage: 'Failed to get application',
      error: err
    });
  }
}

/**
 * POST /api/monetization/apply
 * Apply for monetization. Only if eligible; one active (pending) at a time.
 */
async function applyForMonetization(req, res) {
  try {
    const userId = req.user._id;

    const eligibility = await getOrComputeEligibility(userId, true);
    if (!eligibility.isEligible) {
      return res.status(400).json({
        success: false,
        message: 'You are not eligible for monetization yet.',
        failedConditions: eligibility.failedConditions
      });
    }

    const existingPending = await MonetizationApplication.findOne({
      user: userId,
      status: 'pending'
    });
    if (existingPending) {
      return res.status(400).json({
        success: false,
        message: 'You already have an application under review.'
      });
    }

    const reapplyBlock = await MonetizationApplication.findOne({
      user: userId,
      status: 'rejected',
      reapplyAfter: { $gt: new Date() }
    }).sort({ reviewedAt: -1 });
    if (reapplyBlock) {
      return res.status(400).json({
        success: false,
        message: 'You cannot re-apply until after the cooldown period.',
        reapplyAfter: reapplyBlock.reapplyAfter
      });
    }

    const application = await MonetizationApplication.create({
      user: userId,
      status: 'pending',
          eligibilitySnapshot: {
            isEligible: eligibility.isEligible,
            progressPercent: eligibility.progressPercent,
            failedConditions: eligibility.failedConditions,
            requirements: eligibility.requirements || [],
            metrics: eligibility.metrics
          }
    });

    await User.findByIdAndUpdate(userId, { creatorMonetizationStatus: 'pending' });
    await recordTimeline({
      application: application._id,
      user: userId,
      action: 'applied',
      actor: userId,
      actorType: 'creator',
      newValue: { status: 'pending', eligibilitySnapshot: application.eligibilitySnapshot }
    });

    res.status(201).json({
      success: true,
      message: 'Application submitted. It will be reviewed by the team.',
      data: {
        application: {
          _id: application._id,
          status: application.status,
          appliedAt: application.appliedAt
        }
      }
    });
  } catch (err) {
    return sendInternalError({
      res,
      log,
      operation: 'Creator monetization application submission failed',
      publicMessage: 'Failed to submit application',
      error: err
    });
  }
}

/**
 * POST /api/monetization/application/withdraw
 * Withdraw the current pending application.
 */
async function withdrawApplication(req, res) {
  try {
    const userId = req.user._id;
    const { reason = '' } = req.body || {};
    const application = await MonetizationApplication.findOne({ user: userId, status: 'pending' }).sort({ appliedAt: -1 });
    if (!application) {
      return res.status(404).json({ success: false, message: 'No pending application found to withdraw.' });
    }

    const before = application.toObject();
    application.status = 'withdrawn';
    application.adminRemark = String(reason || '').slice(0, 1000);
    application.reviewedAt = new Date();
    await application.save();

    const eligibility = await getOrComputeEligibility(userId, true);
    await User.findByIdAndUpdate(userId, {
      creatorMonetizationStatus: eligibility?.isEligible ? 'eligible' : 'withdrawn'
    });
    await recordTimeline({
      application: application._id,
      user: userId,
      action: 'withdrawn',
      actor: userId,
      actorType: 'creator',
      reason,
      oldValue: { status: before.status },
      newValue: { status: application.status }
    });

    res.status(200).json({
      success: true,
      message: 'Application withdrawn successfully.',
      data: { application: { _id: application._id, status: application.status } }
    });
  } catch (err) {
    return sendInternalError({
      res,
      log,
      operation: 'Creator monetization application withdrawal failed',
      publicMessage: 'Failed to withdraw application',
      error: err
    });
  }
}

/**
 * GET /api/monetization/application/history
 */
async function getApplicationHistory(req, res) {
  try {
    const userId = req.user._id;
    const [applications, timeline] = await Promise.all([
      MonetizationApplication.find({ user: userId })
        .sort({ appliedAt: -1 })
        .select('status adminRemark rejectionReason appliedAt reviewedAt reapplyAfter eligibilitySnapshot')
        .lean(),
      MonetizationApplicationTimeline.find({ user: userId })
        .sort({ createdAt: -1 })
        .limit(100)
        .lean()
    ]);
    res.status(200).json({
      success: true,
      data: { applications, timeline }
    });
  } catch (err) {
    return sendInternalError({
      res,
      log,
      operation: 'Creator monetization application history lookup failed',
      publicMessage: 'Failed to get application history',
      error: err
    });
  }
}

/**
 * GET /api/monetization/dashboard
 * Earnings dashboard for approved creators: estimated earnings, payout history, next payout, bank status.
 */
async function getDashboard(req, res) {
  try {
    setPrivateNoStore(res);
    const userId = req.user._id;
    const user = await User.findById(userId).select('isCreator creatorMonetizationStatus').lean();
    if (!user?.isCreator || user.creatorMonetizationStatus !== 'approved') {
      return res.status(403).json({
        success: false,
        message: 'Monetization not enabled for your account. Apply and get approved first.'
      });
    }

    const cycle = await getOrCreateCurrentCycle();
    const estimated = await getEstimatedEarningsForCreator(userId);
    const creatorUser = await User.findById(userId).select('creatorCpm').lean();
    const PLATFORM_DEFAULT_CPM = Number(process.env.PLATFORM_DEFAULT_CPM) || 50;
    const cpm = (creatorUser?.creatorCpm != null && creatorUser.creatorCpm > 0)
      ? creatorUser.creatorCpm
      : PLATFORM_DEFAULT_CPM;

    const payouts = await CreatorPayout.find({ user: userId })
      .populate('payoutCycle', 'cycleLabel periodType endDate')
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();

    const bank = await CreatorBankDetails.findOne({ user: userId })
      .select('accountHolderName ifsc swiftCode country +taxIdHash bankName lastFourDigits verificationStatus verificationReason verifiedAt updatedAt version')
      .lean();

    res.status(200).json({
      success: true,
      data: {
        estimatedEarnings: {
          amount: estimated.amount,
          cycleLabel: estimated.cycleLabel,
          cycleEndDate: estimated.cycleEndDate,
          isEstimate: estimated.isEstimate,
          held: estimated.held,
          inputs: estimated.inputs
        },
        organicAnalytics: {
          totalOrganicClipViews: estimated.inputs?.totalOrganicClipViews || estimated.inputs?.totalClipViews || 0,
          cpm: estimated.inputs?.cpm || cpm,
          boostedViewsExcluded: true
        },
        cpm,
        nextPayoutDate: cycle.endDate,
        payoutHistory: payouts.map(p => ({
          _id: p._id,
          amount: p.amount,
          status: p.status,
          cycleLabel: p.payoutCycle?.cycleLabel,
          paidAt: p.paidAt,
          bankReference: p.bankReference,
          failureReason: p.failureReason
        })),
        bankDetails: summarizeBankDetails(bank)
      }
    });
  } catch (err) {
    return sendInternalError({
      res,
      log,
      operation: 'Creator monetization dashboard lookup failed',
      publicMessage: 'Failed to get dashboard',
      error: err
    });
  }
}

async function getEarnings(req, res) {
  return getDashboard(req, res);
}

async function getPayoutHistory(req, res) {
  try {
    setPrivateNoStore(res);
    const userId = req.user._id;
    const [payouts, withdrawals] = await Promise.all([
      CreatorPayout.find({ user: userId })
        .populate('payoutCycle', 'cycleLabel periodType startDate endDate')
        .sort({ createdAt: -1 })
        .limit(50)
        .lean(),
      WithdrawalRequest.find({ user: userId })
        .populate('payoutCycle', 'cycleLabel periodType startDate endDate')
        .sort({ requestedAt: -1 })
        .limit(50)
        .lean()
    ]);

    res.status(200).json({
      success: true,
      data: {
        payouts,
        withdrawalRequests: withdrawals
      }
    });
  } catch (err) {
    return sendInternalError({
      res,
      log,
      operation: 'Creator monetization payout history lookup failed',
      publicMessage: 'Failed to get payout history',
      error: err
    });
  }
}

/**
 * GET /api/monetization/bank-details
 * Get current user's bank details (masked).
 */
async function getBankDetails(req, res) {
  try {
    setPrivateNoStore(res);
    const userId = req.user._id;
    const bank = await CreatorBankDetails.findOne({ user: userId })
      .select('accountHolderName ifsc swiftCode branch +upiId +upiIdEncrypted +paypalEmail +paypalEmailEncrypted country +taxIdHash +gstNumber +gstNumberEncrypted bankName lastFourDigits verificationStatus verificationReason verifiedAt createdAt updatedAt version')
      .lean();
    if (!bank) {
      return res.status(200).json({ success: true, data: { bankDetails: null } });
    }
    res.status(200).json({
      success: true,
      data: {
        bankDetails: maskBankDetails(bank)
      }
    });
  } catch (err) {
    return sendInternalError({
      res,
      log,
      operation: 'Creator monetization bank details lookup failed',
      publicMessage: 'Failed to get bank details',
      error: err
    });
  }
}

/**
 * PUT /api/monetization/bank-details
 * Create or update bank details. Account number encrypted server-side.
 */
async function upsertBankDetails(req, res) {
  try {
    setPrivateNoStore(res);
    const userId = req.user._id;
    const validation = normalizeAndValidateBankDetails(req.body || {});
    if (!validation.valid) {
      return res.status(422).json({
        success: false,
        code: 'INVALID_BANK_DETAILS',
        message: firstValidationMessage(validation),
        details: validation.errors
      });
    }
    const value = validation.value;
    const expectedVersion = Number(req.body?.expectedVersion);
    const session = await startFinancialSession();
    let bank;
    let created = false;
    let next;
    try {
      await session.withTransaction(async () => {
        const existing = await CreatorBankDetails.findOne({ user: userId }).select(BANK_OWNER_SENSITIVE_SELECT).session(session).lean();
        const effectiveVersion = existing ? Math.max(1, Number(existing.version || 1)) : 0;
        if (existing && (!Number.isInteger(expectedVersion) || expectedVersion !== effectiveVersion)) {
          const staleError = new Error('Bank details changed since this form was loaded. Refresh and try again.');
          staleError.code = 'STALE_BANK_DETAILS';
          throw staleError;
        }
        const activePayout = await hasLockedPayout(userId).session(session);
        const activeWithdrawal = await hasActiveWithdrawal(userId).session(session);
        if (activePayout || activeWithdrawal || existing?.activePayoutLocks?.length || existing?.activeWithdrawalLocks?.length) {
          const lockedError = new Error('Bank details cannot be changed while a payout or withdrawal is pending or processing.');
          lockedError.code = 'BANK_DETAILS_LOCKED_FOR_PAYOUT';
          throw lockedError;
        }

        const encrypted = CreatorBankDetails.encryptAccountNumber(value.accountNumber);
        const now = new Date();
        const $set = {
          accountHolderName: value.accountHolderName,
          accountNumberEncrypted: encrypted,
          accountNumberHash: CreatorBankDetails.hashSensitiveValue(value.accountNumber, 'account-number'),
          bankName: value.bankName,
          country: value.country,
          lastFourDigits: value.accountNumber.slice(-4),
          verificationStatus: 'pending',
          verificationReason: '',
          lastSubmittedAt: now
        };
        const $unset = { verifiedAt: 1, verifiedByActorKey: 1, rejectedAt: 1 };
        ['branch'].forEach((field) => {
          if (value[field]) $set[field] = value[field];
          else $unset[field] = 1;
        });
        const encryptedOptionalFields = [
          ['upiId', maskPaymentAddress],
          ['paypalEmail', maskEmail],
          ['gstNumber', maskIdentifier]
        ];
        encryptedOptionalFields.forEach(([field, masker]) => {
          const encryptedField = `${field}Encrypted`;
          const maskedField = `${field}Masked`;
          if (value[field]) {
            $set[encryptedField] = CreatorBankDetails.encryptSensitiveValue(value[field]);
            $set[maskedField] = masker(value[field]);
            $unset[field] = 1;
          } else {
            $unset[field] = 1;
            $unset[encryptedField] = 1;
            $unset[maskedField] = 1;
          }
        });
        if (value.country === 'IN') {
          $set.ifsc = value.ifsc;
          $unset.swiftCode = 1;
        } else {
          $set.swiftCode = value.swiftCode;
          $unset.ifsc = 1;
        }
        if (value.taxId) {
          $set.taxIdEncrypted = CreatorBankDetails.encryptSensitiveValue(value.taxId);
          $set.taxIdHash = CreatorBankDetails.hashSensitiveValue(value.taxId, 'tax-id');
        } else if (req.body?.removeTaxId === true) {
          $unset.taxIdEncrypted = 1;
          $unset.taxIdHash = 1;
        }

        if (existing) {
          const versionFilter = existing.version == null
            ? { $or: [{ version: { $exists: false } }, { version: 1 }] }
            : { version: effectiveVersion };
          const versionUpdate = existing.version == null
            ? { $set: { ...$set, version: effectiveVersion + 1 }, $unset }
            : { $set, $unset, $inc: { version: 1 } };
          bank = await CreatorBankDetails.findOneAndUpdate(
            { _id: existing._id, 'activePayoutLocks.0': { $exists: false }, 'activeWithdrawalLocks.0': { $exists: false }, ...versionFilter },
            versionUpdate,
            { new: true, runValidators: true, context: 'query', session }
          ).select(BANK_OWNER_SENSITIVE_SELECT);
        } else {
          created = true;
          $set.version = 1;
          bank = await CreatorBankDetails.findOneAndUpdate(
            { user: userId, 'activePayoutLocks.0': { $exists: false }, 'activeWithdrawalLocks.0': { $exists: false } },
            { $set, $unset, $setOnInsert: { user: userId } },
            { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true, context: 'query', session }
          ).select(BANK_OWNER_SENSITIVE_SELECT);
        }
        if (!bank) {
          const conflictError = new Error('Bank details changed while saving. Refresh and try again.');
          conflictError.code = 'STALE_BANK_DETAILS';
          throw conflictError;
        }
        next = maskBankDetails(bank);
        await recordBankHistory({
          req,
          bank,
          userId,
          action: created ? 'created' : 'updated',
          previous: existing ? maskBankDetails(existing) : null,
          next,
          session
        });
      }, FINANCIAL_TRANSACTION_OPTIONS);
    } catch (error) {
      if (error?.code === 11000 || error?.code === 'STALE_BANK_DETAILS') {
        sendPublicMonetizationError(res, 'STALE_BANK_DETAILS');
        return;
      }
      if (error?.code === 'BANK_DETAILS_LOCKED_FOR_PAYOUT') {
        sendPublicMonetizationError(res, 'BANK_DETAILS_LOCKED_FOR_PAYOUT');
        return;
      }
      throw error;
    } finally {
      await session.endSession().catch(() => null);
    }

    res.status(created ? 201 : 200).json({
      success: true,
      message: 'Bank details saved. They will be verified before payouts.',
      data: {
        bankDetails: {
          ...next
        }
      }
    });
  } catch (err) {
    return sendInternalError({
      res,
      log,
      operation: 'Creator monetization bank details update failed',
      publicMessage: 'Failed to save bank details',
      error: err
    });
  }
}

async function deleteBankDetails(req, res) {
  try {
    setPrivateNoStore(res);
    const userId = req.user._id;
    const expectedVersion = Number(req.body?.expectedVersion ?? req.query?.expectedVersion);
    const session = await startFinancialSession();
    let found = false;
    try {
      await session.withTransaction(async () => {
        const bank = await CreatorBankDetails.findOne({ user: userId }).select(BANK_OWNER_SENSITIVE_SELECT).session(session).lean();
        if (!bank) return;
        found = true;
        const effectiveVersion = Math.max(1, Number(bank.version || 1));
        if (!Number.isInteger(expectedVersion) || expectedVersion !== effectiveVersion) {
          const staleError = new Error('Bank details changed since this screen was loaded. Refresh and try again.');
          staleError.code = 'STALE_BANK_DETAILS';
          throw staleError;
        }
        const activePayout = await hasLockedPayout(userId).session(session);
        const activeWithdrawal = await hasActiveWithdrawal(userId).session(session);
        if (activePayout || activeWithdrawal || bank.activePayoutLocks?.length || bank.activeWithdrawalLocks?.length) {
          const lockedError = new Error('Bank details cannot be deleted while a payout or withdrawal is pending or processing.');
          lockedError.code = 'BANK_DETAILS_LOCKED_FOR_PAYOUT';
          throw lockedError;
        }
        const versionFilter = bank.version == null
          ? { $or: [{ version: { $exists: false } }, { version: 1 }] }
          : { version: effectiveVersion };
        await recordBankHistory({ req, bank, userId, action: 'deleted', previous: maskBankDetails(bank), next: null, session });
        const deleted = await CreatorBankDetails.deleteOne({
          _id: bank._id,
          user: userId,
          'activePayoutLocks.0': { $exists: false },
          'activeWithdrawalLocks.0': { $exists: false },
          ...versionFilter
        }, { session });
        if (deleted.deletedCount !== 1) throw Object.assign(new Error('Bank details changed while deleting.'), { code: 'STALE_BANK_DETAILS' });
      }, FINANCIAL_TRANSACTION_OPTIONS);
    } catch (error) {
      if (error?.code === 'STALE_BANK_DETAILS' || error?.code === 'BANK_DETAILS_LOCKED_FOR_PAYOUT') {
        sendPublicMonetizationError(res, error.code);
        return;
      }
      throw error;
    } finally {
      await session.endSession().catch(() => null);
    }
    if (!found) return res.status(204).send();
    res.status(200).json({
      success: true,
      message: 'Bank details deleted successfully.'
    });
  } catch (err) {
    return sendInternalError({
      res,
      log,
      operation: 'Creator monetization bank details deletion failed',
      publicMessage: 'Failed to delete bank details',
      error: err
    });
  }
}

async function deleteBankTaxId(req, res) {
  try {
    setPrivateNoStore(res);
    const userId = req.user._id;
    const expectedVersion = Number(req.body?.expectedVersion);
    let session;
    let next;
    try {
      session = await startFinancialSession();
      await session.withTransaction(async () => {
        const bank = await CreatorBankDetails.findOne({ user: userId }).select(BANK_OWNER_SENSITIVE_SELECT).session(session).lean();
        if (!bank) throw Object.assign(new Error('Bank details not found.'), { code: 'BANK_DETAILS_NOT_FOUND' });
        const effectiveVersion = Math.max(1, Number(bank.version || 1));
        if (!Number.isInteger(expectedVersion) || expectedVersion !== effectiveVersion) {
          throw Object.assign(new Error('Bank details changed since this screen was loaded. Refresh and try again.'), { code: 'STALE_BANK_DETAILS' });
        }
        const activePayout = await hasLockedPayout(userId).session(session);
        const activeWithdrawal = await hasActiveWithdrawal(userId).session(session);
        if (activePayout || activeWithdrawal || bank.activePayoutLocks?.length || bank.activeWithdrawalLocks?.length) {
          throw Object.assign(new Error('Tax details cannot be changed while a payout or withdrawal is pending or processing.'), { code: 'BANK_DETAILS_LOCKED_FOR_PAYOUT' });
        }
        if (!bank.taxIdHash) {
          next = maskBankDetails(bank);
          return;
        }
        const now = new Date();
        const versionFilter = bank.version == null
          ? { $or: [{ version: { $exists: false } }, { version: 1 }] }
          : { version: effectiveVersion };
        const update = {
          $unset: { taxIdEncrypted: 1, taxIdHash: 1, verifiedAt: 1, verifiedByActorKey: 1, rejectedAt: 1 },
          $set: { verificationStatus: 'pending', verificationReason: '', lastSubmittedAt: now },
          ...(bank.version == null ? {} : { $inc: { version: 1 } })
        };
        if (bank.version == null) update.$set.version = effectiveVersion + 1;
        const updated = await CreatorBankDetails.findOneAndUpdate(
          { _id: bank._id, ...versionFilter, 'activePayoutLocks.0': { $exists: false }, 'activeWithdrawalLocks.0': { $exists: false } },
          update,
          { new: true, runValidators: true, session }
        ).select(BANK_OWNER_SENSITIVE_SELECT);
        if (!updated) throw Object.assign(new Error('Bank details changed while removing the tax ID.'), { code: 'STALE_BANK_DETAILS' });
        next = maskBankDetails(updated);
        await recordBankHistory({
          req,
          bank: updated,
          userId,
          action: 'updated',
          previous: maskBankDetails(bank),
          next,
          reason: 'Stored tax ID removed by owner',
          session
        });
      }, FINANCIAL_TRANSACTION_OPTIONS);
    } catch (error) {
      if (error?.code === 'BANK_DETAILS_NOT_FOUND') {
        sendPublicMonetizationError(res, 'BANK_DETAILS_NOT_FOUND');
        return;
      }
      if (error?.code === 'STALE_BANK_DETAILS' || error?.code === 'BANK_DETAILS_LOCKED_FOR_PAYOUT') {
        sendPublicMonetizationError(res, error.code);
        return;
      }
      throw error;
    } finally {
      if (session) await session.endSession().catch(() => null);
    }
    return res.status(200).json({ success: true, message: 'Stored tax ID removed. Bank details require verification again.', data: { bankDetails: next } });
  } catch (err) {
    return sendInternalError({
      res,
      log,
      operation: 'Creator monetization tax ID deletion failed',
      publicMessage: 'Failed to remove stored tax ID',
      error: err
    });
  }
}

/**
 * GET /api/monetization/status
 * Combined status for profile Earnings tab: eligibility + application + approved (isCreator).
 */
async function getMonetizationStatus(req, res) {
  try {
    const userId = req.user._id;
    // forceRecalculate: true so cached eligibility is refreshed (testing: low thresholds apply)
    const [user, eligibility, application] = await Promise.all([
      User.findById(userId).select('isCreator creatorMonetizationStatus').lean(),
      getOrComputeEligibility(userId, true),
      MonetizationApplication.findOne({ user: userId }).sort({ appliedAt: -1 }).lean()
    ]);

    const creatorStatus = deriveCreatorStatus({ user, eligibility, application });
    const isApproved = creatorStatus === 'approved';
    const applicationStatus = application?.status || null;
    const reapplyAfter = application?.reapplyAfter || null;
    const rejectionReason = application?.rejectionReason || '';

    res.status(200).json({
      success: true,
      data: {
        isEligible: eligibility?.isEligible ?? false,
        isApproved,
        creatorStatus,
        applicationStatus,
        reapplyAfter,
        rejectionReason,
        failedConditions: eligibility?.failedConditions ?? [],
        progressPercent: eligibility?.progressPercent ?? 0,
        metrics: eligibility?.metrics ?? {},
        requirements: eligibility?.requirements ?? [],
        lastCalculatedAt: eligibility?.lastCalculatedAt,
        application: application ? {
          _id: application._id,
          status: application.status,
          appliedAt: application.appliedAt,
          reviewedAt: application.reviewedAt
        } : null
      }
    });
  } catch (err) {
    return sendInternalError({
      res,
      log,
      operation: 'Creator monetization status lookup failed',
      publicMessage: 'Failed to get status',
      error: err
    });
  }
}

/**
 * POST /api/monetization/withdrawal-request
 * Creator submits a withdrawal request for one finalized payout cycle.
 * Open/current-cycle estimates are never withdrawable: reserving them would
 * freeze an unfinished liability and discard later earnings in that cycle.
 */
async function submitWithdrawalRequest(req, res) {
  try {
    const userId = req.user._id;
    const EarningsSnapshot = require('../models/EarningsSnapshot');
    let session;
    let request;
    try {
      session = await startFinancialSession();
      await session.withTransaction(async () => {
        const user = await User.findById(userId).select('isCreator creatorMonetizationStatus').session(session).lean();
        if (!user?.isCreator || user.creatorMonetizationStatus !== 'approved') {
          throw Object.assign(new Error('Creator is not approved.'), { code: 'CREATOR_NOT_APPROVED' });
        }
        const bank = await CreatorBankDetails.findOne({ user: userId, verificationStatus: 'verified' })
          .select('accountHolderName bankName lastFourDigits ifsc swiftCode branch country version activePayoutLocks activeWithdrawalLocks')
          .session(session);
        if (!bank) {
          throw Object.assign(new Error('Bank details must be verified before submitting a withdrawal request.'), { statusCode: 409, code: 'VERIFIED_BANK_DETAILS_REQUIRED' });
        }

        const finalizedCycles = await PayoutCycle.find({
          status: { $in: ['closed', 'paid'] }
        }).select('_id cycleLabel minimumPayoutThreshold endDate status').sort({ endDate: -1 }).session(session).lean();
        const finalizedCycleIds = finalizedCycles.map((item) => item._id);
        const cycleById = new Map(finalizedCycles.map((item) => [String(item._id), item]));
        const finalizedSnapshots = finalizedCycleIds.length > 0
          ? await EarningsSnapshot.find({
              user: userId,
              payoutCycle: { $in: finalizedCycleIds },
              disbursementReservedAt: null,
              disbursementId: null,
              amount: { $gt: 0 }
            }).sort({ calculatedAt: -1, _id: -1 }).session(session).lean()
          : [];
        const heldEarnings = finalizedSnapshots.find((item) => item.held === true);
        const earnings = finalizedSnapshots.find((item) => {
          if (item.held === true) return false;
          const sourceCycle = cycleById.get(String(item.payoutCycle));
          const thresholdMinor = Math.max(0, Math.round(Number(sourceCycle?.minimumPayoutThreshold ?? 500) * 100));
          const amountMinor = Number.isSafeInteger(item.amountMinor)
            ? item.amountMinor
            : Math.max(0, Math.round(Number(item.amount || 0) * 100));
          return amountMinor >= thresholdMinor;
        });

        if (!earnings && heldEarnings) {
          throw Object.assign(new Error('Your creator payout is currently on hold and cannot be withdrawn.'), { statusCode: 409, code: 'PAYOUT_ON_HOLD' });
        }
        if (!earnings) {
          const unfinishedCycleIds = await PayoutCycle.distinct('_id', {
            status: { $in: ['open', 'closing'] }
          }).session(session);
          const unfinishedEarnings = unfinishedCycleIds.length > 0
            ? await EarningsSnapshot.exists({
                user: userId,
                payoutCycle: { $in: unfinishedCycleIds },
                amount: { $gt: 0 }
              }).session(session)
            : null;
          if (unfinishedEarnings) {
            throw Object.assign(new Error('Current-cycle earnings are estimates and cannot be withdrawn until the cycle is finalized.'), {
              statusCode: 409,
              code: 'EARNINGS_CYCLE_NOT_FINALIZED'
            });
          }
          const available = finalizedSnapshots
            .filter((item) => item.held !== true)
            .reduce((sum, item) => sum + (
              Number.isSafeInteger(item.amountMinor)
                ? item.amountMinor
                : Math.max(0, Math.round(Number(item.amount || 0) * 100))
            ), 0) / 100;
          if (available > 0) {
            throw Object.assign(new Error(`Finalized earnings are below the payout threshold and will carry forward. Available: ₹${available.toFixed(2)}.`), {
              statusCode: 422,
              code: 'MINIMUM_WITHDRAWAL_NOT_MET'
            });
          }
          throw Object.assign(new Error('No finalized, unreserved earnings are available for withdrawal.'), {
            statusCode: 409,
            code: 'NO_FINALIZED_EARNINGS'
          });
        }
        const cycle = cycleById.get(String(earnings.payoutCycle));
        if (!cycle) {
          throw Object.assign(new Error('The earnings payout cycle is not finalized.'), { statusCode: 409, code: 'EARNINGS_CYCLE_NOT_FINALIZED' });
        }
        const amountMinor = Number.isSafeInteger(earnings.amountMinor)
          ? earnings.amountMinor
          : Math.max(0, Math.round(Number(earnings.amount || 0) * 100));
        const amount = amountMinor / 100;
        const existing = await WithdrawalRequest.exists({ user: userId, payoutCycle: cycle._id }).session(session);
        if (existing) {
          throw Object.assign(new Error('A withdrawal request for this cycle already exists.'), { statusCode: 409, code: 'DUPLICATE_WITHDRAWAL_REQUEST' });
        }
        const automaticPayout = await CreatorPayout.exists({ user: userId, payoutCycle: cycle._id }).session(session);
        if (automaticPayout) {
          throw Object.assign(new Error('A payout is already reserved for this earnings cycle.'), { statusCode: 409, code: 'DISBURSEMENT_ALREADY_RESERVED' });
        }

        request = new WithdrawalRequest({
          user: userId,
          payoutCycle: cycle._id,
          amount,
          status: 'pending',
          requestedAt: new Date(),
          bankDetails: bank._id,
          bankDetailsVersion: Math.max(1, Number(bank.version || 1)),
          bankDetailsSnapshot: maskedBankSnapshot(bank)
        });
        const snapshotClaim = await EarningsSnapshot.updateOne(
          {
            _id: earnings._id,
            user: userId,
            payoutCycle: cycle._id,
            held: { $ne: true },
            disbursementReservedAt: null,
            disbursementId: null
          },
          {
            $set: {
              disbursementReservedAt: new Date(),
              disbursementSource: 'withdrawal',
              disbursementId: request._id
            }
          },
          { session }
        );
        if (snapshotClaim.matchedCount !== 1) {
          throw Object.assign(new Error('These earnings were held or reserved while the request was being submitted.'), {
            statusCode: 409,
            code: 'EARNINGS_NO_LONGER_AVAILABLE'
          });
        }
        await CreatorDisbursementReservation.create([{
          user: userId,
          payoutCycle: cycle._id,
          source: 'withdrawal',
          sourceId: request._id
        }], { session });
        await request.save({ session });
        const reserved = await CreatorBankDetails.updateOne(
          { _id: bank._id, user: userId, verificationStatus: 'verified', version: bank.version },
          { $addToSet: { activeWithdrawalLocks: request._id } },
          { session }
        );
        if (reserved.matchedCount !== 1) {
          throw Object.assign(new Error('Bank details changed while submitting the withdrawal. Refresh and try again.'), { statusCode: 409, code: 'STALE_BANK_DETAILS' });
        }
      }, FINANCIAL_TRANSACTION_OPTIONS);
    } finally {
      if (session) await session.endSession().catch(() => null);
    }

    res.status(201).json({
      success: true,
      message: 'Withdrawal request submitted successfully. It will be reviewed by the team.',
      data: {
        request: {
          _id: request._id,
          amount: request.amount,
          status: request.status,
          requestedAt: request.requestedAt
        }
      }
    });
  } catch (err) {
    if (err?.code === 11000) {
      sendPublicMonetizationError(res, 'DISBURSEMENT_ALREADY_RESERVED');
      return;
    }
    if (sendPublicMonetizationError(res, err?.code)) {
      return;
    }
    return sendInternalError({
      res,
      log,
      operation: 'Creator monetization withdrawal request submission failed',
      publicMessage: 'Failed to submit withdrawal request',
      error: err
    });
  }
}

module.exports = {
  assertPlayer,
  getEligibility,
  getApplication,
  applyForMonetization,
  withdrawApplication,
  getApplicationHistory,
  getDashboard,
  getEarnings,
  getPayoutHistory,
  getBankDetails,
  upsertBankDetails,
  deleteBankDetails,
  deleteBankTaxId,
  getMonetizationStatus,
  submitWithdrawalRequest
};
