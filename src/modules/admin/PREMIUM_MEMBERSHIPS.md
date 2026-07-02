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
- Individual plan variables are also supported as
  `RAZORPAY_PLAN_<PLAN_KEY>_<PERIOD>`. Configure monthly, quarterly, and yearly
  IDs for `PLAYER_PRO`, `PLAYER_PRO_PLUS`, `TEAM_PRO`, and `TEAM_ORG` as needed.
- `PREMIUM_SUBSCRIPTION_YEARS`: recurring duration, clamped to 1–10 years.
- `PREMIUM_LIFECYCLE_JOB_ENABLED=false`: disables the lifecycle worker.
- `PREMIUM_LIFECYCLE_CRON`: cron expression, default `*/5 * * * *`.
- `PREMIUM_LIFECYCLE_BATCH_SIZE`: 1–1000, default 200.
- `PREMIUM_PROVIDER_RECONCILIATION_ENABLED=true`: enables provider refreshes.

Missing credentials or plan mappings return a clear `503` and never mutate a
membership into a recurring state. Provider methods are guarded by real IDs.

## Razorpay webhook configuration

Configure Razorpay to send these events to
`POST /api/payments/razorpay/webhook`:

- `payment.captured` and `payment.failed`
- `subscription.authenticated`, `subscription.activated`,
  `subscription.charged`, `subscription.pending`, `subscription.halted`,
  `subscription.paused`, `subscription.resumed`, `subscription.cancelled`,
  `subscription.completed`, `subscription.expired`, and
  `subscription.updated`
- `refund.processed` and `refund.failed`

The webhook secret must be different from `RAZORPAY_KEY_SECRET`. Delivery uses
the exact raw request bytes, `x-razorpay-signature`, and
`x-razorpay-event-id`; do not place a JSON parser before the raw-body capture
for this route. Webhook inbox claims are idempotent and retry stale or failed
deliveries up to their configured attempt ceiling.

## Rollout

1. Run `npm run migrate:premium-indexes`, then
   `npm run verify:premium-indexes`. Resolve duplicate provider/idempotency keys
   before continuing if index creation fails.
2. Run bounded dry-run batches and retain each reported `nextCursor`:
   `npm run backfill:premium -- --limit=500 --after=<ObjectId>`. Omit `--after`
   for the first batch. After reviewing the dry-run, execute the same batch
   with `npm run backfill:premium:apply -- --limit=500 --after=<ObjectId>`,
   using the same input cursor—not the newly reported cursor. Once apply
   succeeds, use its `nextCursor` as the input to both runs of the next batch.
   Continue while `hasMore` is true. The cursor only advances after a user is
   processed successfully, so a failed user is retried on the next run.
3. Configure the webhook secret and subscription/refund lifecycle events.
4. Enable the lifecycle worker and monitor failed webhook inbox rows,
   reconciliation errors, expired access, and provider/local divergence codes.

The backfill never treats pending or failed payments as purchase evidence. It
selects the newest completed/refunded subscription transaction, derives a
finite period for ambiguous legacy state, and only preserves lifetime access
when a successful transaction explicitly and unambiguously identifies it.
Every successful legacy transaction is linked to the canonical membership and
normalizes proven Razorpay IDs, capture amount, and paid timestamp. Dry-run
mode connects with automatic index/collection creation disabled and performs
no writes. Synchronization events are deduplicated, so apply batches are safe
to rerun.

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

`GET /api/admin/premium-memberships/:id/login-history` returns paginated,
allowlisted successful sign-in events for the member. Password, OTP, Google,
and Apple sign-ins are recorded fail-open after authentication succeeds. These
append-only records retain only bounded device, platform, IP, and user-agent
metadata and expire after 180 days. Run the explicit premium index migration
to create and verify the retention index before enabling this view.

Refund state transitions use a versioned, classic-update compare-and-swap flow
so processed events dominate delayed failure events without relying on MongoDB
update pipelines. Historical provider generations may update their own payment
ledger, but cannot revoke a newer manual or differently bound entitlement.
