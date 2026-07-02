# Notification channel policy

Notification delivery is channel-based and email is fail-closed. Creating an
in-app notification or requesting a push never implies email delivery. A
producer must opt into email with one of the allowlisted intents exported by
`legacy-src/utils/notificationChannelPolicy.js`, and the event must not belong
to a routine activity family.

## Channel contract

| Event family | In-app | Push | Email |
| --- | --- | --- | --- |
| Likes, comments, replies, mentions, follows, follow requests, shares, saves, reactions and feed activity | User preference | User preference | Never |
| Messages, voice/media/group messages | User preference | User preference | Never |
| Story views/likes/reactions/replies and clip views/likes/comments/shares | User preference | User preference | Never |
| Tournament registration/match/general activity | User preference | User preference | Never |
| Recruitment applications/invitations/accept/reject activity | User preference | User preference | Never |
| Random Connect matches/session activity, presence, suggestions and recommendations | User preference | User preference | Never |
| OTP, email verification, password/account recovery and security alerts | Where implemented | Where implemented | `security` |
| Welcome, account deletion/reactivation and other critical account lifecycle events | Where implemented | Where implemented | `account_lifecycle` |
| Premium purchase/renewal/failure/cancellation/expiry | System-alert preference | System-alert preference | `premium_lifecycle` |
| Receipts, invoices, refunds and other financial transactions | System-alert preference | System-alert preference | `payment_transactional` |
| Privacy, terms and compliance notices | Where implemented | Where implemented | `legal_policy` |
| Important announcements, critical maintenance and service disruptions | System-alert preference | System-alert preference | `platform_critical` |

The only email intents accepted by the transport are:

- `security`
- `account_lifecycle`
- `premium_lifecycle`
- `payment_transactional`
- `legal_policy`
- `platform_critical`

Legacy `creator_status`, `host_status`, `recruitment_status`,
`tournament_registration_prize`, and `broadcast_explicit` jobs are explicitly
disabled. This also protects deployments that still have older jobs waiting in
Redis.

Routine activity wins over intent. For example, a `story_reply` or
`recruitment_application_accepted` event remains email-blocked even if a bug
mistakenly labels it `platform_critical`. Event names are normalized across
case and separators, aliases are recognized, and complete tokens are checked
so new variants such as `post_comment_created` fail closed.

## Independent delivery and user preferences

`notificationEmitter` evaluates the three channels independently:

1. in-app delivery is controlled by `inAppEnabled` and the event category;
2. push delivery is controlled by `pushEnabled` and the event category;
3. email requires an explicit allowlisted intent and the central policy gate.

Disabling push does not disable in-app delivery. Disabling in-app delivery does
not disable push; a hidden durable row is retained for push retry ownership.
No engagement-email preference is exposed because routine engagement email is
a server-enforced prohibition, not a user preference.

## Enforcement boundaries

The same policy is enforced at every email boundary:

1. notification emitter before queue submission;
2. legacy queue bridge and synchronous fallback;
3. BullMQ email worker before SMTP delivery;
4. direct Nodemailer transport wrapper.

Untyped or disabled jobs already waiting in Redis are treated as suppressed
success. They are logged and acknowledged without SMTP delivery or retries.
Transport errors for valid typed jobs retain the configured BullMQ retry
policy. There are no engagement-specific email templates; the remaining
templates are transactional and the generic notification template escapes HTML
and accepts only HTTP(S) links.

## Audited producer inventory

The repository-wide audit found one SMTP implementation and five approved
producer families:

- auth OTP/email verification uses `security`;
- password reset/change confirmations use `security` through the queue;
- Premium lifecycle changes use `premium_lifecycle`;
- account suspension/restoration uses `account_lifecycle`;
- payout and withdrawal outcomes use `payment_transactional`.

The previous recruitment acceptance/rejection queue producer was removed.
Creator monetization, host verification, moderation warnings, tournament,
social, message, story, clip and Random Connect notifications now remain
in-app/push only. Their existing notification creation and push paths were not
removed.

No separate producer currently exists for every policy-approved product event
(for example welcome mail, suspicious-login mail, generic invoice/refund mail,
legal-policy mail, or critical maintenance mail). Those are pre-existing
product gaps, not implicit email paths. When added, they must use the matching
allowlisted intent; a generic `transactional` intent is deliberately rejected.

## Operations and regression checks

- Configure `SMTP_USER`, `SMTP_PASS`, and optionally `SMTP_HOST`, `SMTP_PORT`,
  `SMTP_SECURE`, and `SMTP_FROM` for transactional delivery.
- Monitor `Email suppressed by channel policy` and
  `Email job suppressed by channel policy`. A spike identifies a stale or
  mistyped producer without risking unwanted delivery.
- Run `npm run test:notification-policy` after changing a notification, email
  producer, worker, or template.
- The suite validates social/message/story/clip/tournament/recruitment/Random
  Connect in-app and push delivery, zero email enqueue, preference isolation,
  typed transactional delivery, queued legacy-job suppression and the absence
  of direct recruitment/admin activity email call sites.
