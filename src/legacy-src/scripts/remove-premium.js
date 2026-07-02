const mongoose = require('mongoose');
const User = require('../models/User');
const premiumMembershipService = require('../services/premiumMembershipService');
require('dotenv').config();

/**
 * Script to manually remove premium status from a user by username
 * 
 * Usage:
 *   node scripts/remove-premium.js <username>
 * 
 * Example:
 *   node scripts/remove-premium.js john_doe
 */

const removePremium = async () => {
  try {
    // Get username from command line arguments
    const username = process.argv[2];

    if (!username) {
      console.error('❌ Error: Username is required!');
      console.log('\nUsage: node scripts/remove-premium.js <username>');
      console.log('Example: node scripts/remove-premium.js john_doe');
      process.exit(1);
    }

    // Connect to database
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/gaming-social-platform');
    console.log('✅ Connected to database');

    // Find user by username
    const user = await User.findOne({ username: username.trim() });

    if (!user) {
      console.error(`❌ Error: User with username "${username}" not found!`);
      await mongoose.disconnect();
      process.exit(1);
    }

    // Check current premium status
    const wasPremium = user.isPremium || false;
    const currentTier = user.membership?.tier || 'free';

    console.log('\n📋 Current User Information:');
    console.log(`   Username: ${user.username}`);
    console.log(`   Email: ${user.email}`);
    console.log(`   User Type: ${user.userType}`);
    console.log(`   Current Premium Status: ${wasPremium ? '✅ Premium' : '❌ Not Premium'}`);
    console.log(`   Current Membership Tier: ${currentTier}`);

    let canonical = await premiumMembershipService.currentForUser(user._id);
    if (!canonical && !wasPremium && currentTier === 'free') {
      console.log('\n⚠️  User is already not premium. No changes needed.');
      await mongoose.disconnect();
      process.exit(0);
    }

    canonical = canonical || await premiumMembershipService.ensureCanonicalForUser(user._id);
    await premiumMembershipService.removeMembership({
      membershipId: canonical._id,
      reason: 'Removed by the canonical premium removal script',
      actor: premiumMembershipService.systemActor('script:remove-premium')
    });
    const projectedUser = await User.findById(user._id).select('isPremium membership').lean();

    console.log('\n✅ Premium status removed successfully!');
    console.log(`   Username: ${user.username}`);
    console.log(`   Premium Status: ❌ Not Premium`);
    console.log(`   Membership Tier: ${projectedUser?.membership?.tier || 'free'}`);

  } catch (error) {
    process.exitCode = 1;
    console.error('❌ Error removing premium:', error.message);
    console.error('\nFull error:', error);
  } finally {
    await mongoose.disconnect();
    console.log('\n👋 Database connection closed');
  }
};

// Run the script
removePremium();
