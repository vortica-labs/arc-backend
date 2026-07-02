/**
 * Seed a single user with all premium features for testing.
 *
 * Sets: isPremium, highest membership tier, max credits, isCreator,
 *       isVerifiedHost, isVerified, and a default creatorCpm.
 *
 * Usage:
 *   node src/legacy-src/scripts/seed-premium-user.js <username>
 *
 * Example:
 *   node src/legacy-src/scripts/seed-premium-user.js john_doe
 */

const mongoose = require('mongoose');
const User = require('../models/User');
const premiumMembershipService = require('../services/premiumMembershipService');
require('dotenv').config();

const VALID_UNTIL_YEARS = 10;

const TIER_BY_USER_TYPE = {
  player: 'player_pro_plus',
  team: 'team_org',
};

const CREDITS_BY_TIER = {
  player_pro_plus: 999,
  team_org: 999,
};

const seedPremiumUser = async () => {
  const username = process.argv[2];

  if (!username) {
    console.error('Error: username is required.');
    console.error('Usage: node src/legacy-src/scripts/seed-premium-user.js <username>');
    process.exit(1);
  }

  await mongoose.connect(
    process.env.MONGODB_URI || 'mongodb://localhost:27017/gaming-social-platform',
    process.env.MONGODB_TLS === 'true'
      ? {
          tls: true,
          tlsCAFile: process.env.MONGODB_TLS_CA_FILE,
          retryWrites: false,
        }
      : {}
  );
  console.log('Connected to database');

  const user = await User.findOne({ username: username.trim() });
  if (!user) {
    console.error(`User "${username}" not found.`);
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log(`\nFound user: ${user.username} (${user.email}) — type: ${user.userType}`);

  const tier = TIER_BY_USER_TYPE[user.userType];
  if (!tier) {
    console.error(`User type "${user.userType}" is not eligible for premium seeding.`);
    await mongoose.disconnect();
    process.exit(1);
  }

  const validUntil = new Date();
  validUntil.setFullYear(validUntil.getFullYear() + VALID_UNTIL_YEARS);

  const membership = await premiumMembershipService.grantMembership({
    userId: user._id,
    planKey: tier,
    billingPeriod: 'yearly',
    startAt: new Date(),
    expiresAt: validUntil,
    reason: 'Granted by the canonical premium test seeding script',
    platform: 'admin',
    actor: premiumMembershipService.systemActor('script:seed-premium-user')
  });

  const premiumUser = await User.findById(user._id);
  if (!premiumUser) throw new Error('User disappeared after premium grant');
  premiumUser.isVerified = true;
  premiumUser.isVerifiedHost = true;
  premiumUser.isCreator = true;
  premiumUser.creatorCpm = premiumUser.creatorCpm || 5;

  premiumUser.membership.credits = CREDITS_BY_TIER[tier];

  await premiumUser.save();

  console.log('\nPremium seed complete:');
  console.log(`  username       : ${premiumUser.username}`);
  console.log(`  isPremium      : ${premiumUser.isPremium}`);
  console.log(`  isVerified     : ${premiumUser.isVerified}`);
  console.log(`  isVerifiedHost : ${premiumUser.isVerifiedHost}`);
  console.log(`  isCreator      : ${premiumUser.isCreator}`);
  console.log(`  creatorCpm     : ${premiumUser.creatorCpm}`);
  console.log(`  tier           : ${membership.planKey}`);
  console.log(`  credits        : ${premiumUser.membership.credits}`);
  console.log(`  valid until    : ${validUntil.toISOString().split('T')[0]} (+${VALID_UNTIL_YEARS}y)`);

  await mongoose.disconnect();
  process.exit(0);
};

seedPremiumUser().catch((err) => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
