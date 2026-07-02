/**
 * Membership: current user's tier, validUntil, credits.
 * Plans catalog: Player (Free, Pro, Pro+) and Team (Free, Pro, Org) with pricing and features.
 */
const User = require('../models/User');
const log = require('../utils/logger');

// Plans catalog: credits + exploreDetails for each plan
const PLAYER_PLANS = [
  {
    id: 'free',
    name: 'Free',
    priceMonthly: 0,
    priceQuarterly: null,
    priceYearly: null,
    creditsPerMonth: 0,
    description: 'Get started with basic limits.',
    features: [
      'AI Coach – 15 messages/day',
      'Random Connect – 5–6 connections/day',
      'Normal visibility in suggestions',
      'Full access to posts, tournaments, messages'
    ],
    cta: 'Current plan',
    highlighted: false,
    exploreDetails: [
      { heading: 'Random Connect', text: 'Up to 5–6 new 1-on-1 connections per day. You get matched with one other player at a time. No gender filter on Free. Each connection counts toward your daily limit.' },
      { heading: 'Visibility', text: 'Your profile and player card appear in suggestions and discover like everyone else—no boost. Full access to post, join tournaments and use messages.' },
      { heading: 'Credits', text: 'No boost credits on Free. You can still create and join everything; only paid plans get credits to boost posts for more reach.' }
    ]
  },
  {
    id: 'player_pro',
    name: 'Pro',
    priceMonthly: 99,
    priceQuarterly: 249,
    priceYearly: 990,
    creditsPerMonth: 0,
    creditsPerWeek: 0,
    description: 'Most popular for serious players.',
    features: [
      'Unlimited Random Connect + gender filter',
      'Get discovered – more visibility',
      'Pro badge on profile',
      'Eligible for Creator monetization',
      'Higher player card visibility'
    ],
    cta: 'Upgrade to Pro',
    highlighted: true,
    exploreDetails: [
      { heading: 'Credits – value for money', text: '2 credits every week. 1 credit = 1 post boost (normal or recruitment). So for ₹99/month you get 2 boosts per week—each boost gives the same visibility that would cost ₹100 if bought alone. Unused credits don’t roll over to the next week.' },
      { heading: 'Random Connect', text: 'Unlimited 1-on-1 connections per day. You get matched with one other player at a time (not squad/duo). Use the gender filter (Pro only) to match your preference.' },
      { heading: 'Get discovered', text: 'Your profile is weighted higher in suggestions and discover so more players see you. Pro badge appears on your profile and in search.' },
      { heading: 'Creator monetization', text: 'You can apply for Creator monetization only if you have an active Pro (or higher) plan. Other eligibility rules (followers, engagement, etc.) still apply.' },
      { heading: 'Player card', text: 'Your player card can appear more often in discover and suggestions compared to Free users.' }
    ]
  },
  {
    id: 'player_pro_plus',
    name: 'Pro+',
    priceMonthly: 199,
    priceQuarterly: 499,
    priceYearly: 1990,
    creditsPerMonth: 20,
    creditsPerWeek: 0,
    description: 'Maximum value with monthly credits and exclusive features.',
    features: [
      'Everything in Pro',
      '20 credits/month to boost posts (vs 8/month in Pro)',
      'Advanced analytics & insights',
      'Priority support',
      'Early access to new features',
      'Featured in discover (top slots)',
      'Pro+ badge & exclusive profile themes'
    ],
    cta: 'Upgrade to Pro+',
    highlighted: false,
    exploreDetails: [
      { heading: 'Credits – best value', text: '5 credits every week. 1 credit = 1 post boost (same as ₹100 value per boost). So for ₹199/month you get 5 boosts per week. Unused credits don’t roll over to the next week.' },
      { heading: 'Everything in Pro', text: 'All Pro benefits included: unlimited AI Coach, unlimited Random Connect with gender filter, get discovered, Pro badge, Creator monetization eligibility, higher player card visibility.' },
      { heading: 'Priority support', text: 'Your tickets and help requests are handled before Free and Pro users so you get faster resolution. Direct line to support team.' },
      { heading: 'Early access', text: 'Get access to new features (e.g. new AI tools, advanced discovery options, new monetization features) before they roll out to other plans.' },
      { heading: 'Featured in discover', text: 'Your profile appears in top slots of discover and suggestions 3x more often than Pro users. Maximum visibility for serious creators.' },
      { heading: 'Advanced analytics', text: 'See detailed insights: player card views, connection stats, profile engagement trends, and post performance analytics. Understand what works so you can grow faster.' },
      { heading: 'Pro+ badge & themes', text: 'Exclusive Pro+ badge on your profile and access to premium profile themes to make your profile stand out.' }
    ]
  }
];

const TEAM_PLANS = [
  {
    id: 'free',
    name: 'Free',
    priceMonthly: 0,
    priceQuarterly: null,
    priceYearly: null,
    creditsPerMonth: 0,
    description: 'Run your team with core features.',
    features: [
      'Unlimited recruitment posts',
      'Unlimited tournaments & scrims',
      'Full roster & staff management',
      'Basic visibility'
    ],
    cta: 'Current plan',
    highlighted: false,
    exploreDetails: [
      { heading: 'Recruitment', text: 'Create as many recruitment posts as you need for roster and staff. No limit on open posts. Players can apply; you manage applications from your dashboard.' },
      { heading: 'Tournaments & scrims', text: 'Host unlimited tournaments and scrims. Set dates, formats, prize pool and rules. No cap on how many you create.' },
      { heading: 'Roster & staff', text: 'Add and manage full rosters per game and staff (coach, manager, etc.). All core management features are included.' },
      { heading: 'Visibility', text: 'Your team profile and recruitment posts get normal visibility. No boost credits on Free.' },
      { heading: 'Credits', text: 'No boost credits on Free. Paid plans get monthly credits to boost normal posts and recruitment posts for more reach.' }
    ]
  },
  {
    id: 'team_pro',
    name: 'Pro',
    priceMonthly: 249,
    priceQuarterly: 699,
    priceYearly: 2490,
    creditsPerMonth: 0,
    description: 'For growing teams.',
    features: [
      'Support for recruitment – better reach',
      'Management assistance – tools & insights',
      'Financial modeling assistance',
      'Better visibility for recruitment posts'
    ],
    cta: 'Upgrade to Pro',
    highlighted: true,
    exploreDetails: [
      { heading: 'Recruitment support', text: 'Your recruitment posts get better placement so more players see your openings. Reach a wider pool of candidates faster.' },
      { heading: 'Management assistance', text: 'Access tools to help manage your roster, staff, and team operations more efficiently. Streamline your team management workflow.' },
      { heading: 'Financial modeling assistance', text: 'Get guidance and tools to help model your team finances, budget planning, and sponsorship projections.' },
      { heading: 'Visibility', text: 'Boosted recruitment posts get better placement so more players see your openings.' }
    ]
  },
  {
    id: 'team_org',
    name: 'Org',
    priceMonthly: 499,
    priceQuarterly: 1299,
    priceYearly: 4990,
    creditsPerMonth: 0,
    description: 'For orgs and academies.',
    features: [
      'Everything in Pro',
      'Custom branding & verified badge',
      'Priority support',
      'Advanced analytics & export',
      'Featured in discover (top slots)'
    ],
    cta: 'Upgrade to Org',
    highlighted: false,
    exploreDetails: [
      { heading: 'Credits – best value', text: '60 credits every month. 1 credit = 1 post boost (₹100 value each). So for ₹499 you get 60 boosts—₹6000 value. Ideal for orgs that post and recruit frequently.' },
      { heading: 'Everything in Pro', text: 'All Pro benefits: recruitment support, management assistance, analytics, and better visibility.' },
      { heading: 'Custom branding & verified badge', text: 'Org badge and verified status on your team profile. Optional custom branding so your org stands out.' },
      { heading: 'Priority support', text: 'Your support requests are prioritised so you get faster help for billing, features and issues.' },
      { heading: 'Advanced analytics & export', text: 'Deeper analytics and ability to export data (e.g. recruitment reports, tournament stats) for internal use or sponsors.' }
    ]
  }
];

/**
 * GET /api/membership/plans
 * Returns all plans (player + team) with pricing and features. No auth required for listing.
 */
async function getPlans(req, res) {
  try {
    res.status(200).json({
      success: true,
      data: {
        player: PLAYER_PLANS,
        team: TEAM_PLANS
      }
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: 'Failed to get plans',
      error: err.message
    });
  }
}

/**
 * GET /api/membership
 * Returns current user's membership info: tier, validUntil, credits + plans for display.
 */
async function getMembership(req, res) {
  try {
    const user = await User.findById(req.user._id)
      .select('userType membership isPremium')
      .lean();

    if (!user) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const projectedMembership = user.membership || {
      tier: 'free',
      validUntil: null,
      credits: 0
    };
    const premiumService = require('../services/premiumMembershipService');
    const { resolvePremiumEntitlement } = require('../services/entitlementService');
    const canonical = await premiumService.currentForUser(req.user._id).lean();
    const premiumEntitlement = await resolvePremiumEntitlement({
      userId: req.user._id,
      requestSource: 'membership_api'
    });

    // PremiumMembership is authoritative once present. The User membership
    // fields are retained only as a compatibility projection for accounts that
    // have not yet been backfilled.
    const isActivePro = premiumEntitlement.isPremium;
    const tier = premiumEntitlement.plan;
    const validUntil = premiumEntitlement.validUntil;
    const credits = isActivePro ? Math.max(0, Number(projectedMembership.credits) || 0) : 0;
    const isExpired = Boolean(validUntil && new Date(validUntil) <= new Date());
    const currentPlanId = tier;
    const plans = user.userType === 'team' ? TEAM_PLANS : PLAYER_PLANS;
    const benefits = (plans.find(p => p.id === currentPlanId) || plans[0]).features;

    res.set('Cache-Control', 'private, no-store');

    res.status(200).json({
      success: true,
      data: {
        tier,
        validUntil,
        credits,
        isPremium: isActivePro,
        isActivePro,
        isExpired,
        userType: user.userType,
        currentPlanId,
        benefits,
        membershipId: canonical?._id || null,
        source: premiumEntitlement.source,
        billingPeriod: premiumEntitlement.subscriptionType === 'legacy' ? null : premiumEntitlement.subscriptionType,
        membershipStatus: premiumEntitlement.membershipStatus,
        subscriptionStatus: premiumEntitlement.subscriptionStatus,
        autoRenew: canonical?.autoRenew === true,
        cancelAtCycleEnd: canonical?.cancelAtCycleEnd === true,
        currentPeriodStart: canonical?.currentPeriodStart || null,
        currentPeriodEnd: canonical?.currentPeriodEnd || validUntil,
        providerSubscriptionId: canonical?.razorpay?.subscriptionId || null,
        providerControlsAvailable: Boolean(canonical?.razorpay?.subscriptionId),
        plans: {
          player: PLAYER_PLANS,
          team: TEAM_PLANS
        }
      }
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: 'Failed to get membership',
      error: err.message
    });
  }
}

module.exports = {
  getMembership,
  getPlans,
  PLAYER_PLANS,
  TEAM_PLANS
};
