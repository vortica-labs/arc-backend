# Mobile Broadcast Notification API

All endpoints require the normal user bearer token and a completed, active account. The base paths are `/api/notifications` and `/api/users/notification-settings`.

## Notification center

### List and unread count

`GET /api/notifications`

Supported query parameters:

- `page` (default `1`) and `limit` (`1..100`, default `20`)
- `isRead=true|false`
- `category=all|announcement|update|maintenance|feature_release|tournament|recruitment|promotion|creator|premium|system|custom`
- `search` (title/message, escaped case-insensitive match, maximum 100 characters)
- `archived=true|false` (default `false`)
- `platform=ios|android|web|unknown` and `appVersion`

Mobile should always send its current `platform` and `appVersion`. These values prevent an installation-targeted broadcast from appearing or contributing to the badge on an unmatched installation.

```json
{
  "success": true,
  "data": {
    "notifications": [],
    "unreadCount": 0,
    "pagination": {
      "current": 1,
      "total": 0,
      "count": 0,
      "totalNotifications": 0,
      "page": 1,
      "pages": 0,
      "limit": 20,
      "totalItems": 0
    }
  }
}
```

`unreadCount` is the canonical, non-archived unread count for the supplied client context; it is intentionally independent of search/category/read filters.

### Mutations

- `PUT /api/notifications/:id/read` — idempotently marks an owned row read; accepts `platform`/`appVersion` in query or body.
- `PUT /api/notifications/read-all` — marks all visible, non-archived rows read; accepts `platform`/`appVersion`.
- `DELETE /api/notifications/:id` — soft-deletes an owned row and removes it from unread counts.
- `PUT /api/notifications/:id/archive` and `PUT /api/notifications/:id/unarchive` — optional archive lifecycle.

Malformed, missing, deleted, or another user's IDs return `404` without disclosing whether another user owns the resource. Replaying read is safe. Mobile may treat a `404` while replaying an offline read/delete mutation as already reconciled.

## Preferences

- `GET /api/users/notification-settings`
- `PUT /api/users/notification-settings` with a partial object

Delivery controls are `pushEnabled`, `inAppEnabled`, `marketingEnabled`, `announcementsEnabled`, `promotionsEnabled`, and `mutedBroadcastCategories`. Social/game-specific booleans remain supported. Unknown keys, non-boolean boolean settings, non-array muted categories, and unknown category values fail with `400`; duplicate valid muted categories are normalized.

Broadcast delivery intersects the channel master switch with category controls. Muted categories always opt out. `promotion` requires both marketing and promotions; `premium` requires marketing; announcement/update/feature release require announcements.

## Installation and push registration

- `POST /api/notifications/client-context`
  - body: `clientId` (stable installation ID), `platform`, `appVersion`, and optional permission capability fields
- `POST /api/notifications/push-token`
  - body: valid Expo `token`, `platform`, `deviceName`, `projectId`, `appVersion`, and optional `nativeToken`
- `DELETE /api/notifications/push-token`
  - body: the valid Expo `token`
- `GET /api/notifications/push-status` — masked diagnostics only; raw tokens are never returned
- `POST /api/notifications/push-test` — sends an authenticated test notification to the current user's registered devices

An installation ID and Expo token are reassigned to the currently authenticated account, preventing a signed-out account on the same installation from continuing to receive broadcasts.

Broadcast Expo messages retain visible title/body alerts and include `_contentAvailable: true` so iOS can run background delivery processing; generic notification messages do not opt in. Rich messages also include `richContent.image` and `mutableContent: true`. iOS builds still require the configured background-notification mode, Notification Service Extension, and valid APNs/EAS credentials. Android broadcasts use `broadcasts`, `broadcasts-high`, or `broadcasts-critical` according to `customData.priority`; generic system alerts remain on `default`.

## Delivery and engagement tracking

- `POST /api/notifications/:id/delivered`
- `POST /api/notifications/:id/open`
- `POST /api/notifications/:id/click`

Body fields are `platform` (`ios`, `android`, or `web`), `source` (`push` or `in_app`), and, for click, the resolved `url`. `:id` may be the persistent notification ID or the synthetic broadcast delivery-log ID used by push-only broadcasts.

Every endpoint resolves the ID together with the authenticated recipient. Cross-user and malformed IDs return `404`. Events have a unique `(broadcastRecipient, eventType)` key and repeated calls return a successful result with `duplicate: true`. Click also records open and marks a persistent notification read.

Native delivered callbacks create idempotent device-level analytics evidence; Expo provider receipts remain authoritative for provider retry/channel status. Web delivery acknowledgement remains authoritative because Socket.IO has no provider receipt.

## Mobile integration requirements

- Merge REST, Socket.IO, and Expo records by normalized notification/delivery ID.
- Include client context on list, read, and mark-all calls.
- Persist and replay offline read/delete operations; accept `404` as reconciled.
- Track foreground receipt as delivered and notification response as open/click.
- Treat backend unread count as canonical after pending local mutations are reconciled.
- Validate deep links client-side and allow only supported internal routes or allow-listed HTTPS hosts.
- Physical-device QA must cover foreground, background, terminated launch, token refresh/logout, preference opt-outs, iOS image attachment, Android channels, and offline mutation replay.
