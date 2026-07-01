# Broadcast backend runbook

## Architecture

MongoDB is the durable source of truth. `Broadcast` stores authoring and schedule
state, `BroadcastChunk` makes fan-out resumable, `BroadcastRecipient` is the
per-recipient delivery ledger, `BroadcastOccurrence` freezes content/audience
per recurring run, and `BroadcastEvent` deduplicates delivery/open/click events.
`BroadcastPushReceipt` stores device-level provider state without raw tokens,
while `NotificationFailure` is the durable dead-letter/operator ledger for
terminal queue and delivery failures. `Notification` is the persistent in-app
inbox; archive and delete are user-scoped soft lifecycle states.
BullMQ is an execution layer rather than the only copy of pending work: the
scheduler reconstructs queued, due scheduled, and stale processing jobs from
MongoDB after Redis or worker outages.

The lifecycle is:

1. `POST /api/admin/broadcasts` creates a draft only.
2. `POST /api/admin/broadcasts/:id/send` validates the persisted audience and
   changes the draft to queued or scheduled.
3. A dispatch job streams matching user IDs into durable chunks.
4. Chunk workers upsert recipient ledgers, create allowed in-app notifications,
   emit `new-notification`, and submit Expo messages in provider batches of 100.
   A hashed, device-level `BroadcastPushReceipt` record is persisted before
   each provider submission.
5. Delayed receipt jobs reconcile up to 300 provider tickets at once; MongoDB
   recovery scans repair the enqueue crash window and exhausted Redis jobs.
   Provider receipts update channel delivery state asynchronously. Recipient,
   open, click, and failure analytics are calculated from the ledgers.

Draft creation and sending deliberately require separate permissions. This
prevents an administrator with `broadcasts:manage` but without
`broadcasts:send` from hiding a send operation inside a create request.

## APIs

- `/api/admin/broadcasts`: dashboard, list, draft CRUD, duplicate, preview,
  send, cancel, analytics, recipients, and global delivery logs. Audience
  selectors include exact normalized email lists through `audience.emails`
  (the API also accepts `customEmails`).
- `POST /api/admin/broadcasts/:id/retry-failed`: explicitly requeues terminal
  occurrence chunks or bounded device-provider failure batches. MongoDB state
  is updated before BullMQ enqueue so the recovery scan repairs Redis outages.
- `/api/admin/broadcast-templates`: template list/create/update/archive.
- `POST /api/notifications/:id/delivered|open|click`: recipient-owned,
  idempotent delivery/engagement tracking. Browser delivery is counted only
  after a client acknowledgement, not when a Socket.IO event is emitted.
  A push-only delivery uses its recipient-ledger ID as
  the stable notification ID.
- `POST /api/notifications/client-context`: records durable platform and app
  version context for clients that do not register an Expo token (notably Web).

## Operations

Relevant tuning variables are:

- `BROADCAST_CHUNK_SIZE` (default 100, bounded 25–500)
- `BROADCAST_WORKER_CONCURRENCY` (default 5, bounded 1–20)
- `BROADCAST_JOBS_PER_SECOND` (default 3)
- `BROADCAST_DELIVERY_CONCURRENCY` (default 10, bounded 1–25)
- `BROADCAST_CLIENT_CONTEXT_MAX_AGE_DAYS` (default 90)
- `BROADCAST_WEB_PUSH_ACK_TIMEOUT_MS` (default 10 minutes)
- `BROADCAST_METRICS_LOCK_MS` (default 60 seconds)
- `BROADCAST_METRICS_MAX_ROUNDS` (default 3 authoritative aggregation rounds
  per lock holder; dirty revisions continue through scheduler recovery)
- `EXPO_MAX_PAYLOAD_BYTES` (default 4096; payloads are compacted then rejected
  before queueing if still over the byte ceiling)
- `EXPO_PUSH_TOKEN_MAX_LENGTH` (default 512; the registration API also caps
  each account at 10 deduplicated device tokens)
- `EXPO_PUSH_REQUEST_TIMEOUT_MS` (default 15000)
- `EXPO_ACCESS_TOKEN` (optional bearer token for Expo push-security projects)
- `EXPO_BROADCAST_SEND_MAX_ATTEMPTS` (default 12)
- `EXPO_PUSH_RECEIPT_DELAY_MS` (legacy direct-push receipt delay)
- `EXPO_BROADCAST_RECEIPT_DELAY_MS` (default 15 minutes)
- `EXPO_BROADCAST_RECEIPT_MAX_ATTEMPTS` (default 8)

Monitor queue failed/stalled counts, broadcasts whose processing lease is
older than 15 minutes, recipient failure rate, Expo receipt failures, and
`execution.lastError`. Do not delete recipient/chunk ledgers while a broadcast
is active. Failed broadcasts retry the same occurrence; duplicate the broadcast
when its audience or content must change.

## Provider and collection mapping

`PUSH_NOTIFICATION_PROVIDER=expo` is the supported provider boundary. The Expo
gateway routes Android messages to FCM and iOS messages to APNs using EAS/Expo
project credentials; FCM and APNs are therefore downstream transports, not
three fan-out attempts. Adding a direct provider requires implementing the
send/receipt contract in `pushNotificationService.js`, while leaving broadcast
recipient, retry, idempotency, and analytics state unchanged.

The requested logical stores map as follows: `Broadcasts` → `Broadcast`,
`BroadcastRecipients`/`NotificationAnalytics` → `BroadcastRecipient`,
`BroadcastTemplates` → `BroadcastTemplate`, `NotificationQueue` and
`ScheduledBroadcasts` → Mongo broadcast/chunk outbox state plus BullMQ,
`NotificationFailures` → `NotificationFailure`, and
`NotificationClicks`/`NotificationOpens` → typed `BroadcastEvent` rows.
Immutable administrator actions are stored in `AdminAuditLog`.
Broadcast routes persist immutable intent and outcome rows synchronously; if
the intent cannot be stored, the requested admin action does not execute.

Web browser notifications use authenticated Socket.IO sessions plus the
browser Notification API. They work while a Web client is connected (including
background tabs), but are not closed-browser Service Worker Web Push. Missing
browser acknowledgements expire to a terminal failure; horizontally scaled
deployments must keep the Socket.IO Redis adapter enabled.

## Production index migration

MongoDB runs with `autoIndex=false`, so deploy indexes before enabling the
Broadcast Center:

```sh
npm run migrate:broadcast-indexes
npm run verify:broadcast-indexes
```

The migration is additive/idempotent and covers broadcast, occurrence,
recipient, chunk, provider receipt, event, template, failure, audit,
notification, and user targeting indexes. A unique-index failure usually
means pre-existing duplicate idempotency rows and must be resolved before
workers are enabled. Run the verification command as a release gate after the
migration and after restoring any production snapshot.

## Rollback

Stop the broadcast worker first, then cancel queued/scheduled broadcasts through
the admin API. Existing in-app notifications and recipient ledgers should be
retained for auditability. Rolling back application code does not require a
destructive data migration because all new fields are additive.

## Geography migration note

Legacy users store geography in `profile.location` as free-form text. Country,
state, and city filters currently use escaped token-boundary matching against
that field. This avoids obvious substring errors but cannot provide exact
geographic semantics for every legacy value. A future profile migration should
backfill structured country/state/city fields and corresponding compound
indexes; the API audience contract can remain unchanged.
