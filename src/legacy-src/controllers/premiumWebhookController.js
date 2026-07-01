const crypto = require('crypto');
const RazorpayWebhookEvent = require('../models/RazorpayWebhookEvent');
const provider = require('../services/razorpayPremiumProvider');
const service = require('../services/premiumMembershipService');

const header = (req, name) => typeof req.get === 'function' ? req.get(name) : req.headers?.[name.toLowerCase()];

const handleRazorpayWebhook = async (req, res) => {
  const rawBody = req.rawBody;
  const signature = header(req, 'x-razorpay-signature');
  const eventId = String(header(req, 'x-razorpay-event-id') || '').trim().slice(0, 200);
  if (!Buffer.isBuffer(rawBody) || !eventId || !signature) {
    return res.status(400).json({ success: false, message: 'Razorpay webhook headers or raw body are missing' });
  }
  let verified = false;
  try {
    verified = provider.verifyWebhookSignature(rawBody, signature);
  } catch (error) {
    return res.status(Number(error?.statusCode) || 503).json({ success: false, code: error?.code || 'WEBHOOK_NOT_CONFIGURED', message: 'Webhook verification is unavailable' });
  }
  if (!verified) return res.status(401).json({ success: false, message: 'Invalid webhook signature' });

  let body;
  try { body = JSON.parse(rawBody.toString('utf8')); }
  catch { return res.status(400).json({ success: false, message: 'Webhook body must be valid JSON' }); }
  const eventType = typeof body.event === 'string' ? body.event.slice(0, 120) : '';
  if (!eventType) return res.status(400).json({ success: false, message: 'Webhook event type is required' });
  const rawBodyHash = crypto.createHash('sha256').update(rawBody).digest('hex');
  let inbox;
  let alreadyClaimed = false;
  let claimToken = crypto.randomUUID();
  try {
    inbox = await RazorpayWebhookEvent.create({
      eventId,
      eventType,
      rawBodyHash,
      providerCreatedAt: Number(body.created_at) > 0 ? new Date(Number(body.created_at) * 1000) : null,
      payload: provider.sanitizeProviderSnapshot(body.payload || {})
    });
  } catch (error) {
    if (error?.code !== 11000) return res.status(500).json({ success: false, message: 'Webhook could not be accepted' });
    const duplicate = await RazorpayWebhookEvent.findOne({ eventId }).lean();
    if (duplicate?.rawBodyHash !== rawBodyHash) return res.status(409).json({ success: false, message: 'Webhook event ID payload mismatch' });
    const staleAt = new Date(Date.now() - 5 * 60 * 1000);
    inbox = await RazorpayWebhookEvent.findOneAndUpdate(
      {
        eventId,
        rawBodyHash,
        attempts: { $lt: 10 },
        $or: [
          { status: 'received' },
          { status: 'failed' },
          { status: 'processing', claimedAt: { $lte: staleAt } }
        ]
      },
      {
        $set: { status: 'processing', claimToken, claimedAt: new Date(), errorCode: '', errorMessage: '' },
        $inc: { attempts: 1 }
      },
      { new: true }
    );
    if (!inbox) return res.status(200).json({ success: true, duplicate: true, status: duplicate?.status || 'received' });
    alreadyClaimed = true;
  }

  if (!alreadyClaimed) {
    inbox = await RazorpayWebhookEvent.findOneAndUpdate(
      { _id: inbox._id, status: 'received' },
      { $set: { status: 'processing', claimToken, claimedAt: new Date() }, $inc: { attempts: 1 } },
      { new: true }
    );
    if (!inbox) return res.status(200).json({ success: true, duplicate: true });
  }
  try {
    const result = await service.processWebhookPayload({
      eventId,
      eventType,
      payload: body.payload || {},
      providerCreatedAt: inbox.providerCreatedAt || new Date()
    });
    if (result.retryable) {
      const retryable = new Error(result.reason || 'Webhook dependency is not ready');
      retryable.code = 'WEBHOOK_DEPENDENCY_NOT_READY';
      throw retryable;
    }
    await RazorpayWebhookEvent.updateOne(
      { _id: inbox._id, claimToken },
      { $set: { status: result.ignored ? 'ignored' : 'processed', processedAt: new Date(), membership: result.membership?._id || null, result: { ignored: Boolean(result.ignored), reason: result.reason || '' } }, $unset: { claimToken: 1, claimedAt: 1 } }
    );
    return res.status(200).json({ success: true, duplicate: false });
  } catch (error) {
    await RazorpayWebhookEvent.updateOne(
      { _id: inbox._id, claimToken },
      { $set: { status: 'failed', errorCode: String(error?.code || 'WEBHOOK_PROCESSING_FAILED').slice(0, 100), errorMessage: 'Webhook processing failed' }, $unset: { claimToken: 1, claimedAt: 1 } }
    ).catch(() => null);
    return res.status(500).json({ success: false, message: 'Webhook processing failed' });
  }
};

module.exports = { handleRazorpayWebhook };
