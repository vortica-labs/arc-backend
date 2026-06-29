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
      notes: { planId, billingPeriod, userId: userId.toString() }
    });

    res.status(200).json({
      success: true,
      data: {
        orderId: order.id,
        planId: plan.id,
        planName: plan.name,
        billingPeriod,
        amount: order.amount,
        currency: order.currency
      }
    });
  } catch (err) {
    console.error('Error creating subscription order:', err);
    res.status(500).json({
      success: false,
      message: 'Failed to create order',
      error: err.message
    });
  }
}

/**
 * POST /api/membership/payment/verify
 * Verify Razorpay signature and activate subscription
 */
async function verifyPayment(req, res) {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, planId, billingPeriod } = req.body;
    const userId = req.user._id;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !planId || !billingPeriod) {
      return res.status(400).json({
        success: false,
        message: 'razorpay_order_id, razorpay_payment_id, razorpay_signature, planId, and billingPeriod are required'
      });
    }

    const crypto = require('crypto');
    const body = razorpay_order_id + '|' + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body)
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({ success: false, message: 'Invalid payment signature' });
    }

    const payment = await getRazorpay().payments.fetch(razorpay_payment_id);
    if (!payment || !['authorized', 'captured'].includes(payment.status)) {
      return res.status(400).json({ success: false, message: 'Payment not confirmed by Razorpay' });
    }

    const user = await User.findById(userId);
    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const plan = getPlanById(planId, user.userType);
    if (!plan) {
      return res.status(404).json({ success: false, message: 'Plan not found' });
    }

    const validUntil = calculateValidUntil(billingPeriod);
    const tier = plan.id;

    user.isPremium = true;
    user.membership = {
      tier,
      validUntil,
      credits: plan.creditsPerMonth || (plan.creditsPerWeek ? plan.creditsPerWeek * 4 : 0)
    };

    await user.save();

    await recordPaymentTransaction({
      user: userId,
      type: 'subscription',
      amount: amountFromRazorpayPayment(payment, getPriceForPeriod(plan, billingPeriod)),
      currency: payment.currency || 'INR',
      status: 'completed',
      description: `${plan.name} subscription (${billingPeriod})`,
      orderId: razorpay_order_id,
      paymentId: razorpay_payment_id,
      referenceId: userId,
      referenceType: 'membership',
      metadata: {
        planId,
        billingPeriod,
        tier,
        validUntil,
        razorpayStatus: payment.status
      }
    });

    res.status(200).json({
      success: true,
      message: 'Payment verified and subscription activated',
      data: {
        tier,
        validUntil,
        credits: user.membership.credits,
        planName: plan.name
      }
    });
  } catch (err) {
    console.error('Error verifying subscription payment:', err);
    res.status(500).json({
      success: false,
      message: 'Failed to verify payment',
      error: err.message
    });
  }
}

/**
 * POST /api/membership/cancel
 * Downgrade user back to free tier immediately.
 */
async function cancelSubscription(req, res) {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ success: false, message: 'User not found' });

    if (!user.isPremium || !user.membership || user.membership.tier === 'free') {
      return res.status(400).json({ success: false, message: 'No active subscription to cancel' });
    }

    user.isPremium = false;
    user.membership = { tier: 'free', validUntil: null, credits: 0 };
    await user.save();

    res.status(200).json({ success: true, message: 'Subscription cancelled. You are now on the Free plan.' });
  } catch (err) {
    console.error('Error cancelling subscription:', err);
    res.status(500).json({ success: false, message: 'Failed to cancel subscription' });
  }
}

/**
 * POST /api/payments/create-order
 * Create a payment order for tournament entry fee
 */
async function createTournamentOrder(req, res) {
  try {
    const { amount, tournamentId, currency = 'INR' } = req.body;

    if (!amount || !tournamentId) {
      return res.status(400).json({
        success: false,
        message: 'Amount and tournament ID are required'
      });
    }

    const tournament = await Tournament.findById(tournamentId);
    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found'
      });
    }

    const expectedAmount = tournament.entryFee * 100;
    if (amount !== expectedAmount) {
      return res.status(400).json({
        success: false,
        message: 'Invalid payment amount'
      });
    }

    const options = {
      amount: amount,
      currency: currency,
      payment_capture: 1,
      receipt: `trn_${tournamentId.toString().slice(-8)}_${Date.now().toString().slice(-8)}`,
      notes: {
        tournamentId: tournamentId,
        userId: req.user._id
      }
    };

    const order = await getRazorpay().orders.create(options);

    res.status(200).json({
      success: true,
      data: order
    });

  } catch (error) {
    console.error('Error creating tournament payment order:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create payment order'
    });
  }
}

/**
 * POST /api/payments/verify
 * Verify tournament payment and register user
 */
async function verifyTournamentPayment(req, res) {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      tournamentId
    } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !tournamentId) {
      return res.status(400).json({
        success: false,
        message: 'Missing required payment details'
      });
    }

    const crypto = require('crypto');
    const body = razorpay_order_id + '|' + razorpay_payment_id;
    const expectedSignature = crypto
      .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
      .update(body.toString())
      .digest('hex');

    if (expectedSignature !== razorpay_signature) {
      return res.status(400).json({
        success: false,
        message: 'Invalid payment signature'
      });
    }

    const payment = await getRazorpay().payments.fetch(razorpay_payment_id);
    if (!payment || !['authorized', 'captured'].includes(payment.status)) {
      return res.status(400).json({ success: false, message: 'Payment not confirmed by Razorpay' });
    }

    const tournament = await Tournament.findById(tournamentId);
    if (!tournament) {
      return res.status(404).json({
        success: false,
        message: 'Tournament not found'
      });
    }

    const user = await User.findById(req.user._id);
    const isAlreadyRegistered = tournament.participants.some(p => p._id.toString() === req.user._id) ||
                              tournament.teams.some(t => t._id.toString() === req.user._id);

    if (isAlreadyRegistered) {
      return res.status(400).json({
        success: false,
        message: 'Already registered for this tournament'
      });
    }

    const totalParticipants = tournament.participants.length + tournament.teams.length;
    if (totalParticipants >= tournament.totalSlots) {
      return res.status(400).json({
        success: false,
        message: 'Tournament is full'
      });
    }

    if (user.userType === 'team') {
      tournament.teams.push(req.user._id);
    } else {
      tournament.participants.push(req.user._id);
    }

    await tournament.save();

    await recordPaymentTransaction({
      user: req.user._id,
      type: 'tournament',
      amount: amountFromRazorpayPayment(payment, tournament.entryFee),
      currency: payment.currency || 'INR',
      status: 'completed',
      description: `Tournament registration: ${tournament.name}`,
      orderId: razorpay_order_id,
      paymentId: razorpay_payment_id,
      referenceId: tournament._id,
      referenceType: 'tournament',
      metadata: {
        tournamentId,
        razorpayStatus: payment.status
      }
    });

    res.status(200).json({
      success: true,
      message: 'Payment verified and tournament registration successful',
      data: {
        tournamentId,
        userId: req.user._id
      }
    });

  } catch (error) {
    console.error('Error verifying tournament payment:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to verify payment'
    });
  }
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
        campaignId: campaign._id,
        amount: order.amount,
        currency: order.currency,
        requiredAmount: finalAmount,
        estimatedReach: campaign.estimatedReach,
        purchasedReach: campaign.purchasedReach
      }
    });
  } catch (error) {
    console.error('Error creating boost order:', error);
    res.status(500).json({ success: false, message: 'Failed to create payment order' });
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
  createTournamentOrder,
  verifyTournamentPayment,
  createBoostOrder,
  verifyBoostPayment,
  getBoostCampaigns,
  getPaymentHistory
};
