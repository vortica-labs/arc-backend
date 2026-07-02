# Notification channel and email policy

Notification delivery is channel-based. Creating an in-app notification or
requesting push delivery never authorizes email delivery. Email is fail-closed:
the producer must provide an exact `(intent, eventType)` pair registered in
`src/legacy-src/utils/notificationChannelPolicy.js`. A valid intent by itself
is insufficient.

## Channel contract and social-email deny matrix

"User preference" means the existing category preference and global channel
toggle are applied independently. `Never` is a server policy and cannot be
overridden by a client preference, request payload, broad transactional intent,
or admin-supplied notification text.

| Event family | Examples | In-app | Push | Email |
| --- | --- | --- | --- | --- |
| Social engagement | Post/clip/story/achievement likes, comments, replies, follows, follow requests/acceptances, mentions, tags, shares, saves, reactions, profile visits | User preference | User preference | Never |
| Messages and calls | Text, voice, image, video, shared content, group messages, incoming voice/video calls | User preference | User preference | Never |
| Stories and clips | Views, likes, reactions, replies, comments and shares | User preference | User preference | Never |
| Tournament and scrim activity | Registration, match updates, results and general activity | User preference | User preference | Never |
| Recruitment activity | Applications, invitations, accept/reject decisions and profile interest | User preference | User preference | Never |
| Random Connect | Match found and session updates | User preference | User preference | Never |
| Discovery activity | Presence, feed activity, recommendations and friend suggestions | User preference | User preference | Never |
| Creator/host status and routine moderation | Monetization/host updates and content warnings that do not change account access | User preference | User preference | Never |
| Marketing and general broadcasts | Promotions, campaigns and non-critical announcements | User preference | User preference | Never |
| Security | OTP, email verification, password/account recovery and security alerts | Where implemented | Where implemented | Exact `security` event only |
| Account access | Welcome, account deletion/reactivation, suspension and ban notices | Where implemented | Where implemented | Exact `account_lifecycle` event only |
| Premium lifecycle | Purchase, renewal, billing failure, cancellation and expiry | System-alert preference | System-alert preference | Exact `premium_lifecycle` event only |
| Financial transactions | Receipts, invoices, refunds, withdrawals and payouts | System-alert preference | System-alert preference | Exact `payment_transactional` event only |
| Legal | Privacy, terms and compliance notices | Where implemented | Where implemented | Exact `legal_policy` event only |
| Critical platform operations | Critical maintenance, outage and emergency announcements | System-alert preference | System-alert preference | Exact `platform_critical` event only |

Routine activity wins over every email intent. For example, `story_reply`,
`recruitment_application_accepted`, and `new_message` remain email-blocked even
when incorrectly labelled `platform_critical`.

## Exact email allowlist

Only a pair from the following table is accepted. Event names are normalized
for case and separators before comparison. A missing event, an unknown event,
or an event registered under a different intent is rejected.

| Intent | Allowed event types |
| --- | --- |
| `security` | `otp_login`, `otp_register`, `otp_forgot_password`, `email_verification`, `verify_email`, `password_reset`, `password_changed`, `email_changed`, `change_email_confirmation`, `suspicious_login`, `new_device_login`, `security_alert`, `account_recovery`, `admin_password_reset` |
| `account_lifecycle` | `welcome`, `welcome_email`, `account_created`, `account_deletion`, `account_deleted`, `account_reactivation`, `account_restored`, `account_suspended`, `report_account_suspended`, `account_banned` |
| `premium_lifecycle` | `purchase`, `activation`, `renewal`, `plan_change`, `cancellation`, `access_removal`, `resume`, `auto_renew_change`, `refund`, `expiration`, `activated`, `charged`, `cancelled`, `paused`, `resumed`, `pending`, `halted`, `completed`, `expired`, `payment_failed`, `subscription_failed`, `expiry_reminder` |
| `payment_transactional` | `payment_success`, `payment_failed`, `payment_receipt`, `invoice`, `refund`, `refund_processed`, `refund_failed`, `payout_held`, `withdrawal_approved`, `withdrawal_rejected`, `creator_payout_approved`, `creator_payout_processing`, `creator_payout_paid`, `creator_payout_completed`, `creator_payout_failed`, `creator_payout_held`, `creator_payout_cancelled`, `creator_payout_rejected` |
| `platform_critical` | `critical_platform_announcement`, `critical_maintenance`, `critical_service_disruption`, `service_incident`, `service_outage`, `emergency_announcement` |
| `legal_policy` | `privacy_policy_update`, `terms_update`, `terms_of_service_update`, `compliance_notice` |

The serialized legacy intents `creator_status`, `host_status`,
`tournament_registration_prize`, `recruitment_status`, and
`broadcast_explicit` are explicitly disabled. This rule applies to new
submissions and jobs already waiting in Redis.

Policy evaluation order is:

1. reject a recognized routine-engagement event;
2. reject an explicitly disabled legacy intent;
3. reject a missing or unknown intent;
4. reject a missing event type;
5. reject an event not registered under the supplied intent;
6. allow the exact registered pair.

Registration is authorization, not proof that a producer or template exists.
New event types must be added with their dedicated producer, template, and
positive and negative policy tests. A generic `transactional` intent is not
supported.

The Nodemailer transporter and raw `sendMail`/`sendTransactionalEmail` helpers
are private to `email.js`. Runtime callers can only use the policy-aware OTP or
notification-shaped dispatchers; the source-wide capability test fails if a
new file acquires email transport access without explicit review.

## Independent delivery and user preferences

`notificationEmitter` evaluates in-app and push independently before email:

1. in-app delivery uses `inAppEnabled` and the event category;
2. push delivery uses `pushEnabled` and the event category;
3. email requires an exact allowlisted pair and passes all enforcement
   boundaries below.

Disabling push does not disable in-app delivery. Disabling in-app delivery does
not disable push; a hidden durable notification row retains push retry
ownership. Routine engagement email is prohibited by the server and therefore
has no user preference that can re-enable it.

## Four enforcement boundaries

The exact pair is re-evaluated at every email boundary:

1. **Notification emitter** — before an email can be submitted to the queue.
2. **Legacy queue bridge** — before BullMQ submission and again on its
   synchronous fallback path.
3. **BullMQ email worker** — when consuming a job, including jobs created by an
   older application revision.
4. **SMTP transport wrapper** — immediately before calling Nodemailer.

A policy denial is a terminal suppressed result: it is logged, acknowledged,
and is not retried. A transport or temporary infrastructure failure for a valid
transactional event retains the configured retry policy. Email failure must
not roll back or suppress an in-app notification or push attempt.

Once BullMQ is injected, a queue submission error is surfaced and never falls
through to synchronous SMTP. The old fallthrough could enqueue successfully,
lose the acknowledgement, and then send the same message directly. The direct
path remains only for bootstrap/unit-test execution before a queue function is
installed.

## Sanitized dispatch audit contract

Every email decision produces a structured audit record containing the
normalized intent/event, template key, masked recipient and one-way recipient
hash, trigger source, producer call stack, decision/reason, and queue job ID at
the worker boundary. Provider message IDs are hashed and provider errors have
email addresses and URLs removed before logging. Set
`EMAIL_DISPATCH_AUDIT_STACK=false` after the temporary production trace is no
longer required to omit internal call stacks while retaining the other fields.

Never log the raw email address, subject/body, OTP, reset or verification link,
SMTP credential, provider token, arbitrary notification `customData`, raw
provider response, or raw provider message ID.

Monitor suppression counts by `intent`, `eventType`, `reason`, and deployment
version. A spike indicates a stale producer or queued job without exposing user
content.

## Canonical legacy source and generated artifacts

`src/legacy-src/` is the canonical legacy source tree. Modular routes and
controllers resolve it from `process.cwd()/src/legacy-src`; production images
copy it to `/app/src/legacy-src`. Do not edit `dist/legacy-src/` directly.

The TypeScript build also generates `dist/legacy-src/`, but the compiled BullMQ
worker now deliberately imports policy, audit, transport, notification and
broadcast modules through `backendRootPath`, which resolves to the canonical
`/app/src/legacy-src` tree. This removes the former API/worker policy split.
`npm run verify:email-policy-release` still compares the generated and
canonical allowlists, rejects social transport capability in both trees, and
verifies that the compiled producer and worker retain their policy gates.

## Audited producer inventory

The current repository has one SMTP implementation and these implemented
email producer families:

- auth OTP/email verification uses `security`;
- password reset/change confirmations use `security` through the queue;
- premium lifecycle changes use `premium_lifecycle`;
- account suspension/restoration uses `account_lifecycle`;
- payout and withdrawal outcomes use `payment_transactional`.

Recruitment, creator/host activity, moderation warnings, tournaments, social
activity, messages, stories, clips, calls and Random Connect remain in-app/push
only. Some allowlisted product events do not yet have producers. Their presence
in the registry must not be treated as proof that the product flow sends email.

## AWS ECS rollout and old-work draining

An email-policy release is complete only after all consumers of the shared
queue run the new policy. Use immutable image tags, preferably the Git commit
SHA; do not rely on a mutable `latest` tag.

Before deployment:

1. run `npm run test:notification-policy` and
   `npm run test:notification-producers`;
2. build the image from a clean context and verify the exact allowlist in both
   `/app/src/legacy-src` and generated `/app/dist/legacy-src`;
3. record the image tag and digest and register a new ECS task-definition
   revision;
4. inspect pending email jobs by intent/event type without printing recipient
   addresses or message content.

During deployment:

1. prevent old task revisions from continuing to consume email jobs; for an
   urgent leak, pause email consumption or temporarily disable SMTP until the
   old revision is drained;
2. update the ECS service to the new task-definition revision and wait for the
   deployment to become stable;
3. verify every running task uses the new task revision and expected image
   digest, then stop/drain every task from the previous revision;
4. resume email consumption only after no old worker remains.

After deployment:

1. let the new worker consume old jobs. Missing, unknown, social, and disabled
   legacy events must finish as suppressed and must not retry;
2. quarantine or remove residual jobs only after their metadata and suppression
   outcome have been audited; never replay an old job by adding a broad intent;
3. verify sanitized logs show suppression for controlled social probes and one
   successful delivery for a controlled transactional probe;
4. confirm there are no old task-definition revisions still running and retain
   the image digest, task revision, queue counts, and probe results as rollout
   evidence.

Rolling deployments briefly run old and new tasks together. That overlap is a
policy risk because both consume the same BullMQ queue; service health alone is
not sufficient evidence that the email-policy rollout is complete.

## Regression checks

Run the policy and producer suites after changing a notification producer,
event name, template, queue, worker, or transport. Coverage must include:

- every social family in the deny matrix with in-app/push preserved and zero
  email submissions;
- missing and unknown events, wrong-intent pairs, nested metadata, mixed case
  and separators, and routine events deliberately mislabeled as critical;
- emitter, queue bridge, synchronous fallback, BullMQ worker, SMTP transport,
  and jobs queued by an old revision;
- push-disabled and in-app-disabled preference isolation;
- Redis/SMTP failures that leave in-app and push delivery unaffected;
- every implemented transactional pair, plus duplicate webhook and worker
  retry scenarios proving one intended email;
- source/generated artifact parity in the production image.
