const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const originalKeySecret = process.env.RAZORPAY_KEY_SECRET;
const originalWebhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
process.env.RAZORPAY_KEY_SECRET = 'checkout-secret-for-premium-security-test';
process.env.RAZORPAY_WEBHOOK_SECRET = 'webhook-secret-for-premium-security-test';

const provider = require('./razorpayPremiumProvider');

const hmac = (value, secret) => crypto
  .createHmac('sha256', secret)
  .update(value)
  .digest('hex');

try {
  const orderId = 'order_security123';
  const paymentId = 'pay_security123';
  const orderSignature = hmac(
    `${orderId}|${paymentId}`,
    process.env.RAZORPAY_KEY_SECRET,
  );
  assert.equal(provider.verifyOrderSignature({ orderId, paymentId, signature: orderSignature }), true);
  assert.equal(provider.verifyOrderSignature({ orderId, paymentId, signature: `${orderSignature.slice(0, -1)}0` }), false);
  assert.equal(provider.timingSafeHexEqual(orderSignature, orderSignature.slice(2)), false);
  assert.equal(provider.timingSafeHexEqual(orderSignature, 'not-hex'), false);
  assert.equal(
    provider.timingSafeHexEqual(orderSignature, `${orderSignature}0`),
    false,
    'odd-length hex signatures must be rejected rather than truncated by Buffer.from',
  );

  const subscriptionId = 'sub_security123';
  const subscriptionSignature = hmac(
    `${paymentId}|${subscriptionId}`,
    process.env.RAZORPAY_KEY_SECRET,
  );
  assert.equal(provider.verifySubscriptionSignature({
    subscriptionId,
    paymentId,
    signature: subscriptionSignature,
  }), true);

  const rawBody = Buffer.from('{"event":"subscription.charged","payload":{"a":1}}');
  const webhookSignature = hmac(rawBody, process.env.RAZORPAY_WEBHOOK_SECRET);
  assert.equal(provider.verifyWebhookSignature(rawBody, webhookSignature), true);
  assert.equal(provider.verifyWebhookSignature(
    Buffer.from('{ "event": "subscription.charged", "payload": {"a": 1} }'),
    webhookSignature,
  ), false, 'verification must use exact raw bytes, not parsed/re-serialized JSON');
  assert.equal(provider.verifyWebhookSignature(JSON.parse(rawBody.toString()), webhookSignature), false);

  const sanitized = provider.sanitizeProviderSnapshot({
    id: 'pay_security123',
    card: { last4: '1234' },
    nested: {
      email: 'member@example.com',
      contact: '+910000000000',
      signature: 'secret-signature',
      safe: 'retained',
    },
  });
  assert.equal(sanitized.id, 'pay_security123');
  assert.equal(sanitized.card, '[REDACTED]');
  assert.equal(sanitized.nested.email, '[REDACTED]');
  assert.equal(sanitized.nested.contact, '[REDACTED]');
  assert.equal(sanitized.nested.signature, '[REDACTED]');
  assert.equal(sanitized.nested.safe, 'retained');

  let deeplyNestedSensitiveData = {
    card: { number: '4111111111111111' },
    authorization: 'Bearer security-test-secret',
  };
  for (let depth = 0; depth < 6; depth += 1) {
    deeplyNestedSensitiveData = { nested: deeplyNestedSensitiveData };
  }
  const deeplySanitized = JSON.stringify(provider.sanitizeProviderSnapshot(deeplyNestedSensitiveData));
  assert.equal(deeplySanitized.includes('4111111111111111'), false, 'depth limits must not retain raw card data');
  assert.equal(deeplySanitized.includes('security-test-secret'), false, 'depth limits must not retain authorization data');

  console.log('Premium membership provider security tests passed');
} finally {
  if (originalKeySecret === undefined) delete process.env.RAZORPAY_KEY_SECRET;
  else process.env.RAZORPAY_KEY_SECRET = originalKeySecret;
  if (originalWebhookSecret === undefined) delete process.env.RAZORPAY_WEBHOOK_SECRET;
  else process.env.RAZORPAY_WEBHOOK_SECRET = originalWebhookSecret;
}
