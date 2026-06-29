const cron = require('node-cron');
const { processDueManualBoostDeliveries } = require('../services/boostService');

let boostDeliveryCronStarted = false;

function startBoostDeliveryCron() {
  if (boostDeliveryCronStarted) return;
  boostDeliveryCronStarted = true;

  cron.schedule('* * * * *', async () => {
    try {
      await processDueManualBoostDeliveries({ limit: 200 });
    } catch (error) {
      console.error('[Boost Delivery Cron] Failed to process manual boost delivery:', error.message);
    }
  });

  console.log('[Boost Delivery Cron] Scheduled manual boost delivery worker: every minute');
}

module.exports = { startBoostDeliveryCron };
