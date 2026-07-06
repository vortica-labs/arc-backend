# Push notification backend

## Delivery architecture

Expo is the configured gateway. Expo routes Android messages to FCM and iOS
messages to APNs using the credentials attached to the EAS project. The
backend stores the Expo token plus explicit native FCM/APNs token ownership on
`PushDevice`. iOS installations may additionally register a PushKit VoIP
token. Every raw token is excluded from queries by default. APIs,
application logs, and delivery ledgers expose only bounded previews and
SHA-256 hashes.

`PushDevice` is the canonical installation owner. `installationId`, Expo token
hash, FCM token hash, APNs token hash, and PushKit token hash are globally
unique, so an installation/token can belong to one account at a time.
Registration updates the canonical device and the legacy
`User.pushTokens` targeting cache in one MongoDB transaction when transactions
are available. A unique-index fallback supports local standalone MongoDB.
Delivery dual-reads existing `User.pushTokens` and self-heals missing canonical
rows during the rollout, so already registered clients are not stranded.

Generic, diagnostic, bulk, and administrative pushes persist one aggregate
`PushDeliveryRequest` even when the recipient has no active device, plus one
`PushDeliveryAttempt` per request key and device token hash before provider
submission. The unique `(requestKey, tokenHash)` index is the idempotency
boundary. Provider tickets are not delivery: accepted tickets are reconciled
later by BullMQ receipt jobs. MongoDB recovery scans recreate lost send/receipt
jobs. Transient ticket/request failures and provider timeouts use bounded
exponential retries. Retries reuse the same request key, notification ID, and
collapse identifier so provider/client deduplication can constrain duplicates.
`DeviceNotRegistered` permanently removes the canonical device and its legacy
token cache entry.

Every push-producing notification is first written to the `Notification`
outbox. Push-only preferences use a hidden row, so disabling the notification
inbox does not make delivery ephemeral. A lease prevents the immediate sender
and recovery scanner from submitting the same logical revision concurrently;
the fixed notification creation time or explicit producer `pushRequestId`
keeps the provider request key stable across crashes. Repeat-message rows set a
new message-specific request ID and refresh title/body before they are claimed.

Broadcasts retain their specialized `BroadcastPushReceipt` state machine.

Incoming iOS calls have a second, time-bounded path. The backend persists a
`CallSession`, submits a silent VoIP payload directly to APNs, and records one
`CallVoipPushAttempt` per PushKit token. Temporary APNs failures are retried
only while the durable call is still ringing; only APNs `Unregistered` removes
a PushKit token. A terminal PushKit failure durably invokes the scoped Expo
fallback, while an accepted Expo fallback does not cancel remaining PushKit
retries.
The initial PushKit handoff and later standard-channel call-state reconciliation
have separate lease-backed markers on `CallSession`. Recovery therefore covers
a process exit after the call state commits but before any APNs request or
token attempt is created; zero-attempt APNs request rows are reconstructed by
the VoIP sweeper.
Android receives the standard call path as a high-priority FCM data-only
message so `FirebaseMessagingService` runs while the app is backgrounded or
killed and can publish native CallStyle/full-screen UI. Standard Expo alerts
remain the fallback for iOS installations without a working PushKit path. All
call transports share the same stable call deduplication key.
Accept/decline/end/timeout state is also pushed to other installations so stale
CallKit and Android Telecom UI is dismissed without opening the app. Accepted
sessions retain their participant lease until end or the bounded maximum call
duration, preventing overlapping calls and indefinitely reusable media-token
sessions.
PushKit is used only for real incoming calls that are immediately reported to
CallKit. iOS state cleanup uses a normal-priority, content-available standard
APNs notification and the JS-to-native cleanup bridge; this avoids violating
the iOS requirement to report every VoIP push as an incoming CallKit call.

## Client APIs

- `POST /api/notifications/push-token` registers or rotates one installation.
  Required: `token`, `installationId` (or `deviceId`), and `platform` (`ios` or
  `android`). Optional metadata: `deviceName`, `projectId`, `appVersion`,
  `buildVersion`, `deviceModel`, `deviceBrand`, `manufacturer`, `deviceType`,
  `osName`, `osVersion`, and `{ nativeToken: { type, data } }`.
- `DELETE /api/notifications/push-token` removes only the authenticated
  account's matching `installationId`/`deviceId` and/or Expo `token`.
- `POST /api/notifications/voip-token` registers an iOS PushKit token after the
  standard installation exists; `DELETE /api/notifications/voip-token`
  removes it on logout, account switch, or PushKit invalidation.
- `POST /api/notifications/client-context` and
  `DELETE /api/notifications/client-context` own the corresponding Web/mobile
  client context by stable `clientId`.
- `GET /api/notifications/push-status` returns redacted device and latest
  attempt diagnostics.
- `GET /api/notifications/push-deliveries` returns the authenticated user's
  paginated, redacted provider history.
- `POST /api/notifications/push-test` is rate-limited and returns `202` only
  when at least one provider ticket is accepted.
- `POST /api/notifications/:id/delivered|open|click` advances generic
  `PushDeliveryAttempt` client timestamps atomically and continues to update
  broadcast analytics when the notification belongs to a broadcast.
- `POST /api/auth/logout` is authenticated and may receive `pushToken`/`token`,
  `installationId`/`deviceId`, and `clientId`. Cleanup is installation-scoped;
  it never signs out or unregisters another device.

## Administrative APIs

All routes below use the hardcoded-admin JWT middleware, `users:manage` RBAC,
audit logging, bounded input, and rate limiting:

- `GET /api/admin/push/devices?search=&platform=&status=&page=&limit=`
- `GET /api/admin/push/requests?recipient=&status=&source=&requestKey=`
- `GET /api/admin/push/deliveries?recipient=&status=&source=&platform=&requestKey=`
- `GET /api/admin/push/voip-deliveries?recipient=&status=&callId=&requestKey=`
- `POST /api/admin/push/test` with `userId` or `username`, optional
  `installationId`/`platform`, `title`, `body`, bounded `data`, and an
  `Idempotency-Key` header (or `idempotencyKey` body field).

## Provider payloads

Payloads are rejected before submission if they exceed
`EXPO_MAX_PAYLOAD_BYTES`. Incoming-call pushes use high priority, a 30-second
default TTL, and a stable collapse identifier. Visible fallback alerts use the
`calls` Android channel/Expo `incoming_call` category; Android native-call
delivery is intentionally data-only. Only bounded call fields are copied to
provider data (`eventType`, `callId`, `nativeCallId`, `roomId`,
`randomRoomId`, `callType`, `callerId`, `callerName`, `title`, `deadlineAt`,
and `expiresAt`). Arbitrary native-token or credential data is never copied.

Authenticated clients reconcile native call actions through:

- `GET /api/calls/sessions/pending`
- `GET /api/calls/sessions/:callId`
- `POST /api/calls/sessions/:callId/accept|decline|end`

These routes are participant-scoped, idempotent for replayed native actions,
and never expose media credentials.

## Configuration

- `PUSH_NOTIFICATION_PROVIDER=expo`
- `EXPO_ACCESS_TOKEN` (required by the release gate unless push security is
  explicitly disabled)
- `EXPO_PUSH_SECURITY_MODE=enabled|disabled` (default `enabled`)
- `EXPO_PUSH_REQUEST_TIMEOUT_MS` (default 15000)
- `EXPO_MAX_PAYLOAD_BYTES` (default 4096)
- `EXPO_PUSH_TOKEN_MAX_LENGTH` (default 512)
- `EXPO_GENERIC_PUSH_SEND_MAX_ATTEMPTS` (default 5)
- `EXPO_GENERIC_PUSH_INLINE_SEND_ATTEMPTS` (default 1)
- `EXPO_GENERIC_PUSH_RETRY_BASE_MS` (default 10000; 429 `Retry-After` wins)
- `EXPO_GENERIC_PUSH_RECEIPT_DELAY_MS` (default 15 minutes)
- `EXPO_GENERIC_PUSH_RECEIPT_MAX_ATTEMPTS` (default 8)
- `EXPO_GENERIC_PUSH_RECEIPT_JOB_ATTEMPTS` (default 6)
- `PUSH_WORKER_CONCURRENCY` (default 2)
- `PUSH_DELIVERY_LOG_RETENTION_DAYS` (default 90)
- `PUSH_DEVICE_TOMBSTONE_DAYS` (default 90; prevents logged-out or invalid
  installations from being resurrected by stale provider callbacks)
- `PUSH_REQUEST_RECOVERY_MAX_ATTEMPTS` (default 5)
- `NOTIFICATION_PUSH_OUTBOX_MAX_ATTEMPTS` (default 12)
- `CALL_RING_TTL_SECONDS` (default 30)
- `CALL_DISCONNECT_GRACE_MS` (default 30000; reconnect window before an accepted call is released)
- `MAX_CALL_DURATION_SECONDS` (default 14400 / four hours)
- `CALL_STATE_PUSH_MAX_ATTEMPTS` (default 12)
- `INITIAL_VOIP_OUTBOX_MAX_ATTEMPTS` (default 5)
- `APNS_TEAM_ID`, `APNS_KEY_ID`, and one of `APNS_PRIVATE_KEY` or
  `APNS_PRIVATE_KEY_BASE64`
- `APNS_BUNDLE_ID` and `APNS_VOIP_TOPIC` (`<bundle-id>.voip`)
- `APNS_ENVIRONMENT=production|sandbox`
- `APNS_VOIP_MAX_ATTEMPTS` (default 5)
- `APNS_VOIP_REQUEST_TIMEOUT_MS` (default 10000)
- `APNS_VOIP_CONCURRENCY` (default 10, bounded to 1–50)

Never log `EXPO_ACCESS_TOKEN`, APNs private keys, or raw Expo/FCM/APNs/PushKit
tokens.

## Deployment and verification

Production disables automatic index creation. Run the additive, duplicate-safe
legacy backfill before enabling the new worker path:

```sh
npm run migrate:push-indexes
npm run verify:push-indexes
npm run verify:push-provider-config
npm run test:push
```

The migration backfills `PushDevice` from `User.pushTokens`, resolves duplicate
installation ownership by newest activity, creates unique/TTL indexes, and
verifies that every valid legacy Expo token has a canonical device. Keep the
legacy token cache until all deploys have run the migration and the dual-read
period has been observed successfully.

The strict provider check intentionally fails a production release when APNs
VoIP credentials are absent or malformed, the topic does not exactly match the
bundle ID, the APNs environment is not production, or Expo push security is
enabled without `EXPO_ACCESS_TOKEN`. EAS/FCM/APNs project credentials are also
verified by the mobile release gate; neither check sends a real push.

Monitor request rows with `NO_ACTIVE_INSTALLATION`, queued/retryable attempts
older than five minutes, receipt jobs beyond their retry budget,
`DeviceNotRegistered` cleanup rate, provider 429/5xx rate, APNs VoIP rejection
reasons, and attempts stuck in `provider_accepted` without a terminal receipt.
