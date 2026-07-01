# Premium Memberships backend

`PremiumMembership` is the canonical lifecycle record. `User.isPremium` and
`User.membership` are compatibility projections and must only be changed by
`premiumMembershipService`.

## Configuration

- `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`: checkout/provider credentials.
- `RAZORPAY_WEBHOOK_SECRET`: dedicated secret for
  `POST /api/payments/razorpay/webhook`.
- `RAZORPAY_PREMIUM_PLAN_IDS`: JSON mapping. Both forms are supported:
  `{"player_pro:monthly":"plan_x"}` or
  `{"player_pro":{"monthly":"plan_x"}}`.
- Individual plan variables are also supported, for example
  `RAZORPAY_PLAN_PLAYER_PRO_MONTHLY=plan_x`.
- `PREMIUM_SUBSCRIPTION_YEARS`: recurring duration, clamped to 1–10 years.
- `PREMIUM_LIFECYCLE_JOB_ENABLED=false`: disables the lifecycle worker.
- `PREMIUM_LIFECYCLE_CRON`: cron expression, default `*/5 * * * *`.
- `PREMIUM_LIFECYCLE_BATCH_SIZE`: 1–1000, default 200.
- `PREMIUM_PROVIDER_RECONCILIATION_ENABLED=true`: enables provider refreshes.

Missing credentials or plan mappings return a clear `503` and never mutate a
membership into a recurring state. Provider methods are guarded by real IDs.

## Rollout

1. Run `npm run migrate:premium-indexes`, then
   `npm run verify:premium-indexes`. Resolve duplicate provider/idempotency keys
   before continuing if index creation fails.
2. Run `npm run backfill:premium` (dry-run), inspect counts, then run
   `npm run backfill:premium:apply`. The script is rerunnable.
3. Configure the webhook secret and subscription/refund lifecycle events.
4. Enable the lifecycle worker and monitor failed webhook inbox rows,
   reconciliation errors, expired access, and provider/local divergence codes.

## Customer APIs

- Existing one-time contracts remain at both
  `/api/membership/payment/*` and `/api/payments/subscription/*`.
- Recurring: `POST /api/membership/subscription/create` (requires
  `Idempotency-Key`) and `/verify`; aliases exist under `/api/payments` as
  `/subscription/create` and `/subscription/verify-recurring`.
- `GET /api/membership` includes canonical lifecycle and subscription fields.
- `POST /api/membership/cancel` delegates to the canonical service.

One-time verification derives user, plan, term, amount, and currency from the
fetched Razorpay order/payment. Recurring verification uses the documented
`payment_id|subscription_id` signature and server-stored subscription binding.

## Admin APIs

The base path is `/api/admin/premium-memberships`. Reads require `premium:read`;
mutations require `premium:manage`, `premium:cancel`, or `premium:refund` and an
`Idempotency-Key`. Durable admin audit intent/outcome rows and immutable premium
events are written for lifecycle changes. Hardcoded admins use a deterministic
`hardcoded:<username>` actor key because they do not have a MongoDB ObjectId.
