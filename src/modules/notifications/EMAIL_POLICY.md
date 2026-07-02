# Notification email policy

Email delivery is fail-closed. Creating an in-app notification never implies
email delivery. Every email must carry one of the allowlisted intents exported
by `legacy-src/utils/notificationChannelPolicy.js`.

## Channel contract

| Event family | In-app | Push | Email |
| --- | --- | --- | --- |
| Likes, comments, replies, follows, follow requests/acceptances, shares, mentions, tags, saves, reactions, profile visits and achievement engagement | Existing user preference | Existing user preference | Never |
| Messages, calls and ordinary tournament/recruitment activity | Existing user preference | Existing user preference | Never |
| OTP/email verification/password reset request | N/A | N/A | `security` |
| Password changed/reset confirmation | Where implemented | Where implemented | `security` |
| Premium lifecycle | Existing system-alert preference | Existing system-alert preference | `premium_lifecycle` |
| Creator/host/account/payment administration outcomes | Existing system-alert preference | Existing system-alert preference | Matching typed intent |
| Recruitment application decisions | Existing recruitment preference | Existing recruitment preference | `recruitment_status` |

Routine engagement remains blocked even if a caller accidentally supplies an
otherwise valid transactional intent. The policy recognizes base event names
and common post/clip/story/comment/follow variants with dot, slash, colon,
space, or hyphen separators.

## Enforcement boundaries

The same policy is enforced at all email boundaries:

1. notification emitter;
2. legacy queue bridge and synchronous fallback;
3. BullMQ email worker;
4. direct Nodemailer transport wrapper.

Untyped jobs already waiting in Redis are treated as policy-suppressed success.
They are logged and acknowledged without SMTP delivery or retries. Transport
errors for valid typed jobs still use the configured BullMQ retry policy.

The generic notification-shaped email template escapes title/message HTML and
only permits HTTP(S) links. Engagement-specific email templates are deprecated;
social notification copy is used only for inbox and push delivery.

## Operational notes

- Configure `SMTP_USER`, `SMTP_PASS`, and optionally `SMTP_HOST`, `SMTP_PORT`,
  `SMTP_SECURE`, and `SMTP_FROM` for transactional delivery.
- Monitor `Email suppressed by channel policy` and
  `Email job suppressed by channel policy` logs. A spike in blocked jobs means a
  producer is missing an intent or is attempting an invalid social email.
- Run `npm run test:notification-policy` after changing any notification or
  email producer.
- Web and Mobile own push/in-app preferences only. They must not add an
  engagement-email toggle; email authorization is a server policy.

## Audited producer inventory

The current codebase has typed producers for OTP/email verification, password
reset/change confirmations, Premium lifecycle changes, creator monetization and
host-verification decisions, account suspension/restoration, creator payout and
withdrawal outcomes, and recruitment application decisions.

No producer currently exists for a separate post-registration welcome email,
change-email confirmation flow, suspicious-login alert, non-Premium payment
receipt/invoice, tournament registration/prize email, or legal/policy email.
Those are pre-existing product gaps rather than channels removed by this
policy. Their allowlisted intents are reserved so a future producer must still
opt in explicitly and cannot reuse the social notification path.

## Broadcast email boundary

`broadcast_explicit` is reserved for a future durable Broadcast Center email
transport. The current Broadcast Center supports push and in-app delivery only,
so it has no implicit or partially tracked email path. Before enabling this
intent, implement a durable per-recipient outbox, worker identity and
cancellation revalidation, terminal delivery reconciliation, and retry-safe
metrics. A controller flag or queue call alone is not sufficient.
