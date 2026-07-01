const cron = require('node-cron');
const { processLifecycleBatch } = require('../services/premiumMembershipService');

let task = null;

function startPremiumMembershipCron() {
  if (task || process.env.PREMIUM_LIFECYCLE_JOB_ENABLED === 'false') return;
  const schedule = process.env.PREMIUM_LIFECYCLE_CRON || '*/5 * * * *';
  task = cron.schedule(schedule, async () => {
    try {
      const result = await processLifecycleBatch({
        limit: Math.max(1, Math.min(1000, Number(process.env.PREMIUM_LIFECYCLE_BATCH_SIZE || 200))),
        refreshProvider: process.env.PREMIUM_PROVIDER_RECONCILIATION_ENABLED === 'true'
      });
      if (result.expired || result.repaired || result.providerRefreshed || result.refundLocksReconciled || result.pendingRefundsReconciled) {
        console.log('[Premium Lifecycle]', result);
      }
    } catch (error) {
      console.error('[Premium Lifecycle] Batch failed', { code: error?.code || 'UNKNOWN', message: error?.message || String(error) });
    }
  });
  console.log(`[Premium Lifecycle] Scheduled ${schedule}`);
}

function stopPremiumMembershipCron() {
  if (task) task.stop();
  task = null;
}

module.exports = { startPremiumMembershipCron, stopPremiumMembershipCron };
