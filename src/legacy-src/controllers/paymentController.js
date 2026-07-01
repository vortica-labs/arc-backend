/**
 * Payment controller: create orders, verify payments, activate subscriptions, tournament payments
 */
const User = require('../models/User');
const Tournament = require('../models/Tournament');
const Post = require('../models/Post');
const PaymentTransaction = require('../models/PaymentTransaction');
const BoostCampaign = require('../models/BoostCampaign');
const { PLAYER_PLANS, TEAM_PLANS } = require('./membershipController');
const {
  calculateBoostPrice,
  createPendingBoostCampaign,
  activateBoostCampaign,
  normalizeFrequency
} = require('../services/boostService');

// Lazily initialise Razorpay so a missing key doesn't crash module load
const Razorpay = require('razorpay');
let _razorpay = null;
const getRazorpay = () => {
  if (!_razorpay) {
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
      throw new Error('RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET must be set in environment');
    }
    _razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });
  }
  return _razorpay;
};

/**
 * Helper: Get plan by ID and user type
 */
function getPlanById(planId, userType) {
  const plans = userType === 'team' ? TEAM_PLANS : PLAYER_PLANS;
  return plans.find(p => p.id === planId);
}

/**
 * Helper: Calculate validUntil date based on billing period
 */
function calculateValidUntil(billingPeriod) {
  const now = new Date();
  switch (billingPeriod) {
    case 'monthly':
      return new Date(now.setMonth(now.getMonth() + 1));
    case 'quarterly':
      return new Date(now.setMonth(now.getMonth() + 3));
    case 'yearly':
      return new Date(now.setFullYear(now.getFullYear() + 1));
    default:
      return new Date(now.setMonth(now.getMonth() + 1));
  }
}

/**
 * Helper: Get price for billing period
 */
function getPriceForPeriod(plan, billingPeriod) {
  switch (billingPeriod) {
    case 'monthly':
      return plan.priceMonthly || 0;
    case 'quarterly':
      return plan.priceQuarterly || plan.priceMonthly * 3;
    case 'yearly':
      return plan.priceYearly || plan.priceMonthly * 12;
    default:
      return plan.priceMonthly || 0;
  }
}

function amountFromRazorpayPayment(payment, fallbackAmount) {
  if (payment && typeof payment.amount === 'number') {
    return payment.amount / 100;
  }
  return typeof fallbackAmount === 'number' ? fallbackAmount : 0;
}

async function recordPaymentTransaction(transaction) {
  try {
    const paymentId = transaction.paymentId;
    if (paymentId) {
      return await PaymentTransaction.findOneAndUpdate(
        { paymentId },
        { $setOnInsert: transaction },
        { new: true, upsert: true, setDefaultsOnInsert: true }
      );
    }

    return await PaymentTransaction.create(transaction);
  } catch (error) {
    console.error('Failed to record payment transaction:', error);
    return null;
  }
}

/**
 * POST /api/membership/payment/create-order
 * Create a Razorpay order for subscription
 */
async function createOrder(req, res) {
  try {
    const { planId, billingPeriod } = req.body;
    const platform = ['web', 'android', 'ios'].includes(req.body?.platform) ? req.body.platform : 'unknown';
    const userId = req.user._id;

    if (!planId || !billingPeriod) {
      return res.status(400).json({
        success: false,
        message: 'Plan ID and billing period are required'
      });
    }

    if (!['monthly', 'quarterly', 'yearly'].includes(billingPeriod)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid billing period. Must be monthly, quarterly, or yearly'
      });
    }

    const user = await User.findById(userId).select('userType');
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const plan = getPlanById(planId, user.userType);
    if (!plan) {
      return res.status(404).json({ success: false, message: 'Plan not found' });
    }

    if (plan.id === 'free') {
      return res.status(400).json({ success: false, message: 'Cannot purchase free plan' });
    }

    const priceINR = getPriceForPeriod(plan, billingPeriod);
    if (priceINR <= 0) {
      return res.status(400).json({ success: false, message: 'Invalid plan price' });
    }

    const amountPaise = Math.round(priceINR * 100);
    if (amountPaise < 100) {
      return res.status(400).json({ success: false, message: 'Amount must be at least ₹1' });
    }

    const order = await getRazorpay().orders.create({
      amount: amountPaise,
      currency: 'INR',
      payment_capture: 1,
      receipt: `sub_${userId.toString().slice(-8)}_${Date.now().toString().slice(-8)}`,
      notes: { purpose: 'premium_membership', planId, planKey: planId, billingPeriod, userId: userId.toString(), platform }
    });

    res.status(200).json({
      success: true,
      data: {
        orderId: order.id,
        planId: plan.id,
        planName: plan.name,
        billingPeriod,
        platform,
        amount: order.amount,
        currency: order.currency
      }
    });
  } catch (err) {
    console.error('Error creating subscription order:', err);
    res.status(500).json({
      success: false,
      message: 'Failed to create order'
    });
  }
}

/**
 * POST /api/membership/payment/verify
 * Verify Razorpay signature and activate subscription
 */
async function verifyPayment(req, res) {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
      return res.status(400).json({
        success: false,
        message: 'razorpay_order_id, razorpay_payment_id, and razorpay_signature are required'
      });
    }
    const premiumService = require('../services/premiumMembershipService');
    const result = await premiumService.verifyOneTimePurchase({
      userId: req.user._id,
      orderId: razorpay_order_id,
      paymentId: razorpay_payment_id,
      signature: razorpay_signature,
      platform: req.body?.platform
    });
    const membership = premiumService.serializeMembership(result.membership);
    const projectedUser = await User.findById(req.user._id).select('membership.credits').lean();
    const plan = premiumService.findPlan(membership.planKey, membership.accountType);
    return res.status(200).json({
      success: true,
      idempotentReplay: result.idempotentReplay,
      message: 'Payment verified and premium activated',
      data: {
        membership,
        tier: membership.planKey,
        validUntil: membership.expiresAt,
        billingPeriod: membership.billingPeriod,
        autoRenew: membership.autoRenew,
        credits: Math.max(0, Number(projectedUser?.membership?.credits) || 0),
        planName: plan.name
      }
    });
  } catch (err) {
    const status = Number(err?.statusCode) || 500;
    return res.status(status).json({
      success: false,
      code: err?.code || 'PAYMENT_VERIFICATION_FAILED',
      message: status < 500 ? err.message : 'Failed to verify payment'
    });
  }
}

/**
 * POST /api/membership/cancel
 * Downgrade user back to free tier immediately.
 */
async function cancelSubscription(req, res) {
  try {
    const premiumService = require('../services/premiumMembershipService');
    const membership = await premiumService.cancelCurrentForUser({
      userId: req.user._id,
      mode: req.body?.mode || 'immediate',
      reason: req.body?.reason || 'Cancelled by customer'
    });
    return res.status(200).json({ success: true, message: membership.cancelAtCycleEnd ? 'Cancellation scheduled for the end of the current period.' : 'Premium cancelled.', data: premiumService.serializeMembership(membership) });
  } catch (err) {
    const status = Number(err?.statusCode) || 500;
    return res.status(status).json({ success: false, code: err?.code || 'CANCELLATION_FAILED', message: status < 500 ? err.message : 'Failed to cancel subscription' });
  }
}

async function createRecurringPremiumSubscription(req, res) {
  let claim;
  try {
    const premiumService = require('../services/premiumMembershipService');
    const actorKey = `user:${String(req.user._id)}`;
    const claimed = await premiumService.claimMutation({
      actorKey,
      operation: 'customer-create-subscription',
      idempotencyKey: req.get('Idempotency-Key'),
      payload: { planKey: req.body?.planKey || req.body?.planId, billingPeriod: req.body?.billingPeriod, platform: req.body?.platform }
    });
    if (claimed.replay) return res.status(200).json({ success: true, idempotentReplay: true, data: claimed.result });
    claim = claimed.claim;
    const result = await premiumService.createRecurringSubscription({ userId: req.user._id, planKey: req.body?.planKey || req.body?.planId, billingPeriod: req.body?.billingPeriod, platform: req.body?.platform, correlationId: String(claim._id) });
    const data = { membership: premiumService.serializeMembership(result.membership), checkout: result.checkout };
    await premiumService.completeMutation(claim, result.membership, data);
    return res.status(201).json({ success: true, idempotentReplay: false, data });
  } catch (err) {
    const premiumService = require('../services/premiumMembershipService');
    await premiumService.failMutation(claim, err).catch(() => null);
    const status = Number(err?.statusCode) || 500;
    return res.status(status).json({ success: false, code: err?.code || 'SUBSCRIPTION_CREATE_FAILED', message: status < 500 ? err.message : 'Failed to create recurring subscription' });
  }
}

async function verifyRecurringPremiumSubscription(req, res) {
  try {
    const { razorpay_subscription_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    if (!razorpay_subscription_id || !razorpay_payment_id || !razorpay_signature) return res.status(400).json({ success: false, message: 'razorpay_subscription_id, razorpay_payment_id, and razorpay_signature are required' });
    const premiumService = require('../services/premiumMembershipService');
    const result = await premiumService.verifyRecurringSubscription({ userId: req.user._id, subscriptionId: razorpay_subscription_id, paymentId: razorpay_payment_id, signature: razorpay_signature, platform: req.body?.platform });
    return res.status(200).json({ success: true, idempotentReplay: result.idempotentReplay, data: { membership: premiumService.serializeMembership(result.membership) } });
  } catch (err) {
    const status = Number(err?.statusCode) || 500;
    return res.status(status).json({ success: false, code: err?.code || 'SUBSCRIPTION_VERIFICATION_FAILED', message: status < 500 ? err.message : 'Failed to verify recurring subscription' });
  }
}

/**
 * POST /api/payments/create-order
 * Deprecated tournament payment order endpoint.
 */
async function createTournamentOrder(req, res) {
  return res.status(410).json({
    success: false,
    message: 'Tournament payments are no longer supported. Join tournaments from the tournament page.'
  });
}

/**
 * POST /api/payments/verify
 * Verify tournament payment and register user
 */
async function verifyTournamentPayment(req, res) {
  return res.status(410).json({
    success: false,
    message: 'Tournament payment verification is no longer supported.'
  });
}

/**
 * POST /api/payments/boost/create-order
 * Create Razorpay order for post boost payment
 */
async function createBoostOrder(req, res) {
  try {
    const { postId, amount, frequency, targetReach, targetPlayers, targetTeams } = req.body;
    if (!postId || !frequency) {
      return res.status(400).json({ success: false, message: 'postId and frequency are required' });
    }

    const post = await Post.findById(postId).select('author isActive hiddenByAdmin');
    if (!post || post.isActive === false || post.hiddenByAdmin === true) {
      return res.status(404).json({ success: false, message: 'Post not found' });
    }
    if (post.author.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'You can only boost your own posts' });
    }
    if (targetPlayers === false && targetTeams === false) {
      return res.status(400).json({ success: false, message: 'Select at least one target audience' });
    }

    const normalizedFrequency = normalizeFrequency(frequency);
    const requiredAmount = calculateBoostPrice({
      targetReach,
      frequency: normalizedFrequency,
      targetPlayers,
      targetTeams
    });
    const requestedAmount = Number(amount) || 0;
    if (requestedAmount > 0 && requestedAmount < requiredAmount) {
      return res.status(400).json({
        success: false,
        message: 'Boost amount is below the required budget',
        data: { requiredAmount }
      });
    }

    const finalAmount = Math.max(requiredAmount, requestedAmount);
    const amountPaise = Math.round(finalAmount * 100);
    const order = await getRazorpay().orders.create({
      amount: amountPaise,
      currency: 'INR',
      payment_capture: 1,
      receipt: `bst_${postId.toString().slice(-8)}_${Date.now().toString().slice(-8)}`,
      notes: { postId, frequency: normalizedFrequency, targetReach, targetPlayers, targetTeams, userId: req.user._id.toString() }
    });

    const campaign = await createPendingBoostCampaign({
      userId: req.user._id,
      postId,
      amount: finalAmount,
      frequency: normalizedFrequency,
      targetReach,
      targetPlayers,
      targetTeams,
      razorpayOrderId: order.id,
      currency: order.currency
    });

    res.status(200).json({
      success: true,
      data: {
        orderId: order.id,
        keyId: process.env.RAZORPAY_KEY_ID,
        campaignId: campaign._id,
        amount: order.amount,
        currency: order.currency,
        requiredAmount: finalAmount,
        estimatedReach: campaign.estimatedReach,
        purchasedReach: campaign.purchasedReach
      }
    });
  } catch (error) {
    console.error('Error creating boost order:', {
      message: error?.message || String(error),
      postId: req.body?.postId,
      userId: req.user?._id
    });

    if (String(error?.message || '').includes('RAZORPAY_KEY_ID')) {
      return res.status(503).json({
        success: false,
        code: 'PAYMENT_GATEWAY_NOT_CONFIGURED',
        message: 'Payment gateway is not configured. Please contact support.'
      });
    }

    res.status(500).json({ success: false, code: 'BOOST_ORDER_CREATE_FAILED', message: 'Failed to create payment order' });
  }
}

/**
 * POST /api/payments/boost/verify
 * Verify Razorpay payment and activate boost
 */
async function verifyBoostPayment(req, res) {
  try {
    const crypto = require('crypto');
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, postId, frequency, targetReach, targetPlayers, targetTeams } = req.body;

    const body = razorpay_order_id + '|' + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ success: false, message: 'Payment verification failed' });
    }

    const payment = await getRazorpay().payments.fetch(razorpay_payment_id);
    if (!payment || !['authorized', 'captured'].includes(payment.status)) {
      return res.status(400).json({ success: false, message: 'Payment not confirmed by Razorpay' });
    }

    let campaign = await BoostCampaign.findOne({ razorpayOrderId: razorpay_order_id });
    if (!campaign && postId) {
      campaign = await BoostCampaign.findOne({
        post: postId,
        user: req.user._id,
        status: 'pending'
      }).sort({ createdAt: -1 });
    }

    if (!campaign) {
      return res.status(404).json({ success: false, message: 'Boost campaign not found for this payment order' });
    }
    if (campaign.user.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'You cannot verify another user boost payment' });
    }

    const paidAmount = amountFromRazorpayPayment(payment);
    if (paidAmount + 0.001 < campaign.budget) {
      campaign.status = 'rejected';
      campaign.metadata = {
        ...(campaign.metadata || {}),
        rejectionReason: 'Paid amount below campaign budget',
        paidAmount
      };
      await campaign.save();
      return res.status(400).json({ success: false, message: 'Payment amount does not match boost budget' });
    }

    if (campaign.status === 'running' && campaign.razorpayPaymentId === razorpay_payment_id) {
      return res.status(200).json({
        success: true,
        message: 'Boost already active',
        data: {
          campaignId: campaign._id,
          boostExpiresAt: campaign.endTime,
          remainingReach: campaign.remainingReach
        },
        boostExpiresAt: campaign.endTime
      });
    }

    campaign.frequency = normalizeFrequency(frequency || campaign.frequency);
    if (targetReach) campaign.metadata = { ...(campaign.metadata || {}), targetReach };
    if (targetPlayers !== undefined || targetTeams !== undefined) {
      campaign.targetAudience = {
        ...(campaign.targetAudience || {}),
        players: targetPlayers !== false,
        teams: targetTeams !== false
      };
    }

    const activatedCampaign = await activateBoostCampaign({
      campaign,
      paymentId: razorpay_payment_id,
      paymentAmount: paidAmount
    });

    await recordPaymentTransaction({
      user: req.user._id,
      type: 'boost',
      amount: paidAmount,
      currency: payment.currency || 'INR',
      status: 'completed',
      description: `Post boost (${activatedCampaign.frequency})`,
      orderId: razorpay_order_id,
      paymentId: razorpay_payment_id,
      referenceId: activatedCampaign.post,
      referenceType: 'post',
      metadata: {
        campaignId: activatedCampaign._id,
        frequency: activatedCampaign.frequency,
        targetReach: activatedCampaign.metadata?.requestedReach || targetReach,
        targetPlayers: activatedCampaign.targetAudience?.players,
        targetTeams: activatedCampaign.targetAudience?.teams,
        boostExpiresAt: activatedCampaign.endTime,
        purchasedReach: activatedCampaign.purchasedReach,
        razorpayStatus: payment.status
      }
    });

    res.status(200).json({
      success: true,
      message: 'Boost activated successfully',
      data: {
        campaignId: activatedCampaign._id,
        boostExpiresAt: activatedCampaign.endTime,
        purchasedReach: activatedCampaign.purchasedReach,
        remainingReach: activatedCampaign.remainingReach,
        status: activatedCampaign.status
      },
      boostExpiresAt: activatedCampaign.endTime
    });
  } catch (error) {
    console.error('Error verifying boost payment:', error);
    res.status(500).json({ success: false, message: 'Payment verification failed' });
  }
}

async function getBoostCampaigns(req, res) {
  try {
    const query = { user: req.user._id };
    if (req.query.postId) query.post = req.query.postId;
    if (req.query.status) query.status = req.query.status;

    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100);
    const campaigns = await BoostCampaign.find(query)
      .populate('post', 'content.text content.media boostedAt boostExpiresAt metrics')
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    res.status(200).json({
      success: true,
      data: {
        campaigns: campaigns.map((campaign) => ({
          _id: campaign._id,
          post: campaign.post,
          status: campaign.status,
          budget: campaign.budget,
          currency: campaign.currency,
          frequency: campaign.frequency,
          estimatedReach: campaign.estimatedReach,
          purchasedReach: campaign.purchasedReach,
          remainingReach: campaign.remainingReach,
          dailySpend: campaign.dailySpend,
          totalSpend: campaign.totalSpend,
          startTime: campaign.startTime,
          endTime: campaign.endTime,
          targetAudience: campaign.targetAudience,
          analytics: campaign.analytics,
          createdAt: campaign.createdAt
        }))
      }
    });
  } catch (error) {
    console.error('Error fetching boost campaigns:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch boost campaigns' });
  }
}

async function getPaymentHistory(req, res) {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 100);
    const cursor = req.query.cursor ? new Date(req.query.cursor) : null;
    const query = { user: req.user._id };

    if (cursor && !Number.isNaN(cursor.getTime())) {
      query.createdAt = { $lt: cursor };
    }

    const payments = await PaymentTransaction.find(query)
      .sort({ createdAt: -1 })
      .limit(limit + 1)
      .lean();

    const hasMore = payments.length > limit;
    const page = hasMore ? payments.slice(0, limit) : payments;
    const nextCursor = hasMore ? page[page.length - 1]?.createdAt : null;

    res.status(200).json({
      success: true,
      data: {
        payments: page.map(payment => ({
          _id: payment._id,
          type: payment.type,
          amount: payment.amount,
          currency: payment.currency,
          status: payment.status,
          description: payment.description,
          orderId: payment.orderId,
          paymentId: payment.paymentId,
          referenceId: payment.referenceId,
          referenceType: payment.referenceType,
          createdAt: payment.createdAt,
          updatedAt: payment.updatedAt
        })),
        hasMore,
        nextCursor
      }
    });
  } catch (error) {
    console.error('Error fetching payment history:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch payment history' });
  }
}

module.exports = {
  createOrder,
  verifyPayment,
  cancelSubscription,
  createRecurringPremiumSubscription,
  verifyRecurringPremiumSubscription,
  createTournamentOrder,
  verifyTournamentPayment,
  createBoostOrder,
  verifyBoostPayment,
  getBoostCampaigns,
  getPaymentHistory
};
