# API Inventory

Generated from the mounted Express routers on 2026-07-10T11:11:11.648Z.

- HTTP endpoints: **484**
- Socket event handlers/emissions: **185**
- Access classes: `admin`: 146, `authenticated`: 283, `authenticated-onboarding`: 4, `public`: 23, `public-optional-auth`: 15, `user-or-guest`: 13

> This is a static registration inventory. Runtime health and behavioral coverage are reported separately; inclusion here does not imply an endpoint has a live-database integration test.

## HTTP endpoints

| Method | Path | Access | Source |
|---|---|---|---|
| GET | `/` | public | `src/app.ts:64` |
| GET | `/api/admin/activities` | admin | `src/modules/admin/admin.routes.ts:85` |
| GET | `/api/admin/analytics/users` | admin | `src/modules/admin/admin.routes.ts:83` |
| GET | `/api/admin/audit-logs` | admin | `src/modules/admin/admin.routes.ts:86` |
| POST | `/api/admin/auth/login` | public | `src/modules/admin/admin-login.routes.ts:33` |
| GET | `/api/admin/boost-campaigns` | admin | `src/modules/admin/admin.routes.ts:103` |
| PATCH | `/api/admin/boost-campaigns/:campaignId/delivery/adjust` | admin | `src/modules/admin/admin.routes.ts:108` |
| POST | `/api/admin/boost-campaigns/:campaignId/delivery/configure` | admin | `src/modules/admin/admin.routes.ts:106` |
| POST | `/api/admin/boost-campaigns/:campaignId/delivery/control` | admin | `src/modules/admin/admin.routes.ts:107` |
| POST | `/api/admin/boost-campaigns/:campaignId/manual-delivery` | admin | `src/modules/admin/admin.routes.ts:105` |
| PUT | `/api/admin/boost-campaigns/:campaignId/status` | admin | `src/modules/admin/admin.routes.ts:109` |
| GET | `/api/admin/boost-delivery` | admin | `src/modules/admin/admin.routes.ts:104` |
| GET | `/api/admin/broadcast-templates` | admin | `src/modules/admin/broadcast-template.routes.ts:25` |
| POST | `/api/admin/broadcast-templates` | admin | `src/modules/admin/broadcast-template.routes.ts:26` |
| DELETE | `/api/admin/broadcast-templates/:id` | admin | `src/modules/admin/broadcast-template.routes.ts:28` |
| PATCH | `/api/admin/broadcast-templates/:id` | admin | `src/modules/admin/broadcast-template.routes.ts:27` |
| GET | `/api/admin/broadcasts` | admin | `src/modules/admin/broadcast.routes.ts:37` |
| POST | `/api/admin/broadcasts` | admin | `src/modules/admin/broadcast.routes.ts:38` |
| DELETE | `/api/admin/broadcasts/:id` | admin | `src/modules/admin/broadcast.routes.ts:41` |
| GET | `/api/admin/broadcasts/:id` | admin | `src/modules/admin/broadcast.routes.ts:39` |
| PATCH | `/api/admin/broadcasts/:id` | admin | `src/modules/admin/broadcast.routes.ts:40` |
| GET | `/api/admin/broadcasts/:id/analytics` | admin | `src/modules/admin/broadcast.routes.ts:47` |
| POST | `/api/admin/broadcasts/:id/cancel` | admin | `src/modules/admin/broadcast.routes.ts:46` |
| POST | `/api/admin/broadcasts/:id/duplicate` | admin | `src/modules/admin/broadcast.routes.ts:42` |
| POST | `/api/admin/broadcasts/:id/preview` | admin | `src/modules/admin/broadcast.routes.ts:43` |
| GET | `/api/admin/broadcasts/:id/recipients` | admin | `src/modules/admin/broadcast.routes.ts:48` |
| POST | `/api/admin/broadcasts/:id/retry-failed` | admin | `src/modules/admin/broadcast.routes.ts:45` |
| POST | `/api/admin/broadcasts/:id/send` | admin | `src/modules/admin/broadcast.routes.ts:44` |
| GET | `/api/admin/broadcasts/dashboard` | admin | `src/modules/admin/broadcast.routes.ts:34` |
| GET | `/api/admin/broadcasts/delivery-logs` | admin | `src/modules/admin/broadcast.routes.ts:35` |
| POST | `/api/admin/broadcasts/preview` | admin | `src/modules/admin/broadcast.routes.ts:36` |
| GET | `/api/admin/dashboard` | admin | `src/modules/admin/admin.routes.ts:81` |
| GET | `/api/admin/health` | admin | `src/modules/admin/admin.routes.ts:84` |
| GET | `/api/admin/host-verification/applications` | admin | `src/modules/admin/admin.routes.ts:166` |
| POST | `/api/admin/host-verification/applications/:id/approve` | admin | `src/modules/admin/admin.routes.ts:167` |
| POST | `/api/admin/host-verification/applications/:id/reject` | admin | `src/modules/admin/admin.routes.ts:173` |
| POST | `/api/admin/host-verification/revoke/:userId` | admin | `src/modules/admin/admin.routes.ts:180` |
| GET | `/api/admin/host-verification/verified-hosts` | admin | `src/modules/admin/admin.routes.ts:179` |
| GET | `/api/admin/monetization/applications` | admin | `src/modules/admin/admin.routes.ts:127` |
| POST | `/api/admin/monetization/applications/:applicationId/approve` | admin | `src/modules/admin/admin.routes.ts:128` |
| POST | `/api/admin/monetization/applications/:applicationId/reject` | admin | `src/modules/admin/admin.routes.ts:129` |
| GET | `/api/admin/monetization/audit-logs` | admin | `src/modules/admin/admin.routes.ts:117` |
| GET | `/api/admin/monetization/bank-details` | admin | `src/modules/admin/admin.routes.ts:120` |
| GET | `/api/admin/monetization/bank-details/:id` | admin | `src/modules/admin/admin.routes.ts:122` |
| GET | `/api/admin/monetization/bank-details/:id/history` | admin | `src/modules/admin/admin.routes.ts:121` |
| PATCH | `/api/admin/monetization/bank-details/:id/notes` | admin | `src/modules/admin/admin.routes.ts:125` |
| POST | `/api/admin/monetization/bank-details/:id/request-update` | admin | `src/modules/admin/admin.routes.ts:124` |
| POST | `/api/admin/monetization/bank-details/:id/reveal` | admin | `src/modules/admin/admin.routes.ts:126` |
| PATCH | `/api/admin/monetization/bank-details/:id/verification` | admin | `src/modules/admin/admin.routes.ts:123` |
| GET | `/api/admin/monetization/bank-details/export.csv` | admin | `src/modules/admin/admin.routes.ts:118` |
| GET | `/api/admin/monetization/bank-details/export.xls` | admin | `src/modules/admin/admin.routes.ts:119` |
| GET | `/api/admin/monetization/charts` | admin | `src/modules/admin/admin.routes.ts:112` |
| GET | `/api/admin/monetization/cpm/:userId` | admin | `src/modules/admin/admin.routes.ts:143` |
| PUT | `/api/admin/monetization/cpm/:userId` | admin | `src/modules/admin/admin.routes.ts:142` |
| GET | `/api/admin/monetization/creators` | admin | `src/modules/admin/admin.routes.ts:136` |
| GET | `/api/admin/monetization/creators/:userId/analytics` | admin | `src/modules/admin/admin.routes.ts:134` |
| GET | `/api/admin/monetization/creators/:userId/bank-details` | admin | `src/modules/admin/admin.routes.ts:133` |
| GET | `/api/admin/monetization/creators/:userId/overview` | admin | `src/modules/admin/admin.routes.ts:135` |
| GET | `/api/admin/monetization/creators/export.csv` | admin | `src/modules/admin/admin.routes.ts:132` |
| GET | `/api/admin/monetization/dashboard` | admin | `src/modules/admin/admin.routes.ts:111` |
| POST | `/api/admin/monetization/disable/:userId` | admin | `src/modules/admin/admin.routes.ts:141` |
| POST | `/api/admin/monetization/grant/:userId` | admin | `src/modules/admin/admin.routes.ts:138` |
| GET | `/api/admin/monetization/leaderboards` | admin | `src/modules/admin/admin.routes.ts:113` |
| POST | `/api/admin/monetization/payout-hold/:userId` | admin | `src/modules/admin/admin.routes.ts:130` |
| POST | `/api/admin/monetization/payout-hold/:userId/release` | admin | `src/modules/admin/admin.routes.ts:131` |
| GET | `/api/admin/monetization/payouts` | admin | `src/modules/admin/admin.routes.ts:157` |
| GET | `/api/admin/monetization/payouts/:id` | admin | `src/modules/admin/admin.routes.ts:156` |
| POST | `/api/admin/monetization/payouts/:id/approve` | admin | `src/modules/admin/admin.routes.ts:158` |
| POST | `/api/admin/monetization/payouts/:id/cancel` | admin | `src/modules/admin/admin.routes.ts:165` |
| POST | `/api/admin/monetization/payouts/:id/failed` | admin | `src/modules/admin/admin.routes.ts:161` |
| GET | `/api/admin/monetization/payouts/:id/history` | admin | `src/modules/admin/admin.routes.ts:153` |
| POST | `/api/admin/monetization/payouts/:id/hold` | admin | `src/modules/admin/admin.routes.ts:162` |
| POST | `/api/admin/monetization/payouts/:id/paid` | admin | `src/modules/admin/admin.routes.ts:160` |
| POST | `/api/admin/monetization/payouts/:id/processing` | admin | `src/modules/admin/admin.routes.ts:159` |
| POST | `/api/admin/monetization/payouts/:id/reject` | admin | `src/modules/admin/admin.routes.ts:164` |
| POST | `/api/admin/monetization/payouts/:id/resume` | admin | `src/modules/admin/admin.routes.ts:163` |
| GET | `/api/admin/monetization/payouts/:id/statement` | admin | `src/modules/admin/admin.routes.ts:155` |
| POST | `/api/admin/monetization/payouts/:id/statement` | admin | `src/modules/admin/admin.routes.ts:154` |
| POST | `/api/admin/monetization/payouts/bulk/:action` | admin | `src/modules/admin/admin.routes.ts:152` |
| GET | `/api/admin/monetization/payouts/export.csv` | admin | `src/modules/admin/admin.routes.ts:150` |
| POST | `/api/admin/monetization/payouts/generate` | admin | `src/modules/admin/admin.routes.ts:151` |
| GET | `/api/admin/monetization/reports` | admin | `src/modules/admin/admin.routes.ts:116` |
| GET | `/api/admin/monetization/reports/export` | admin | `src/modules/admin/admin.routes.ts:114` |
| POST | `/api/admin/monetization/reports/export` | admin | `src/modules/admin/admin.routes.ts:115` |
| POST | `/api/admin/monetization/resume/:userId` | admin | `src/modules/admin/admin.routes.ts:140` |
| POST | `/api/admin/monetization/revoke/:userId` | admin | `src/modules/admin/admin.routes.ts:137` |
| GET | `/api/admin/monetization/summary` | admin | `src/modules/admin/admin.routes.ts:110` |
| POST | `/api/admin/monetization/suspend/:userId` | admin | `src/modules/admin/admin.routes.ts:139` |
| GET | `/api/admin/monetization/withdrawal-requests` | admin | `src/modules/admin/admin.routes.ts:144` |
| POST | `/api/admin/monetization/withdrawal-requests/:id/approve` | admin | `src/modules/admin/admin.routes.ts:145` |
| POST | `/api/admin/monetization/withdrawal-requests/:id/cancel` | admin | `src/modules/admin/admin.routes.ts:149` |
| POST | `/api/admin/monetization/withdrawal-requests/:id/failed` | admin | `src/modules/admin/admin.routes.ts:148` |
| POST | `/api/admin/monetization/withdrawal-requests/:id/paid` | admin | `src/modules/admin/admin.routes.ts:147` |
| POST | `/api/admin/monetization/withdrawal-requests/:id/reject` | admin | `src/modules/admin/admin.routes.ts:146` |
| GET | `/api/admin/posts` | admin | `src/modules/admin/admin.routes.ts:95` |
| DELETE | `/api/admin/posts/:postId` | admin | `src/modules/admin/admin.routes.ts:96` |
| GET | `/api/admin/premium-memberships` | admin | `src/modules/admin/premium-membership.routes.ts:23` |
| GET | `/api/admin/premium-memberships/:id` | admin | `src/modules/admin/premium-membership.routes.ts:28` |
| POST | `/api/admin/premium-memberships/:id/auto-renew` | admin | `src/modules/admin/premium-membership.routes.ts:34` |
| POST | `/api/admin/premium-memberships/:id/cancel` | admin | `src/modules/admin/premium-membership.routes.ts:31` |
| POST | `/api/admin/premium-memberships/:id/change-plan` | admin | `src/modules/admin/premium-membership.routes.ts:30` |
| POST | `/api/admin/premium-memberships/:id/extend` | admin | `src/modules/admin/premium-membership.routes.ts:29` |
| GET | `/api/admin/premium-memberships/:id/login-history` | admin | `src/modules/admin/premium-membership.routes.ts:27` |
| GET | `/api/admin/premium-memberships/:id/payments` | admin | `src/modules/admin/premium-membership.routes.ts:25` |
| POST | `/api/admin/premium-memberships/:id/reconcile` | admin | `src/modules/admin/premium-membership.routes.ts:36` |
| POST | `/api/admin/premium-memberships/:id/refund` | admin | `src/modules/admin/premium-membership.routes.ts:35` |
| POST | `/api/admin/premium-memberships/:id/remove` | admin | `src/modules/admin/premium-membership.routes.ts:32` |
| POST | `/api/admin/premium-memberships/:id/resume` | admin | `src/modules/admin/premium-membership.routes.ts:33` |
| GET | `/api/admin/premium-memberships/:id/timeline` | admin | `src/modules/admin/premium-membership.routes.ts:26` |
| GET | `/api/admin/premium-memberships/dashboard` | admin | `src/modules/admin/premium-membership.routes.ts:21` |
| GET | `/api/admin/premium-memberships/eligible-users` | admin | `src/modules/admin/premium-membership.routes.ts:22` |
| POST | `/api/admin/premium-memberships/grant` | admin | `src/modules/admin/premium-membership.routes.ts:24` |
| GET | `/api/admin/push/deliveries` | admin | `src/modules/admin/push.routes.ts:287` |
| GET | `/api/admin/push/devices` | admin | `src/modules/admin/push.routes.ts:191` |
| GET | `/api/admin/push/requests` | admin | `src/modules/admin/push.routes.ts:147` |
| POST | `/api/admin/push/test` | admin | `src/modules/admin/push.routes.ts:378` |
| GET | `/api/admin/push/voip-deliveries` | admin | `src/modules/admin/push.routes.ts:335` |
| GET | `/api/admin/reports` | admin | `src/modules/admin/admin.routes.ts:101` |
| PUT | `/api/admin/reports/:reportId` | admin | `src/modules/admin/admin.routes.ts:102` |
| GET | `/api/admin/scrims` | admin | `src/modules/admin/admin.routes.ts:99` |
| DELETE | `/api/admin/scrims/:scrimId` | admin | `src/modules/admin/admin.routes.ts:100` |
| GET | `/api/admin/search` | admin | `src/modules/admin/admin.routes.ts:82` |
| GET | `/api/admin/tournaments` | admin | `src/modules/admin/admin.routes.ts:97` |
| DELETE | `/api/admin/tournaments/:tournamentId` | admin | `src/modules/admin/admin.routes.ts:98` |
| GET | `/api/admin/users` | admin | `src/modules/admin/admin.routes.ts:87` |
| DELETE | `/api/admin/users/:userId` | admin | `src/modules/admin/admin.routes.ts:94` |
| PUT | `/api/admin/users/:userId/controls` | admin | `src/modules/admin/admin.routes.ts:90` |
| GET | `/api/admin/users/:userId/inspection` | admin | `src/modules/admin/admin.routes.ts:88` |
| POST | `/api/admin/users/:userId/premium/grant` | admin | `src/modules/admin/admin.routes.ts:91` |
| POST | `/api/admin/users/:userId/premium/remove` | admin | `src/modules/admin/admin.routes.ts:92` |
| PUT | `/api/admin/users/:userId/reset-password` | admin | `src/modules/admin/admin.routes.ts:93` |
| PUT | `/api/admin/users/:userId/status` | admin | `src/modules/admin/admin.routes.ts:89` |
| GET | `/api/ai-coach/analytics` | authenticated | `src/modules/ai-coach/ai-coach.routes.ts:39` |
| POST | `/api/ai-coach/analyze` | authenticated | `src/modules/ai-coach/ai-coach.routes.ts:60` |
| GET | `/api/ai-coach/cache/stats` | authenticated | `src/modules/ai-coach/ai-coach.routes.ts:57` |
| POST | `/api/ai-coach/chat` | authenticated | `src/modules/ai-coach/ai-coach.routes.ts:8` |
| DELETE | `/api/ai-coach/conversation/:conversationId` | authenticated | `src/modules/ai-coach/ai-coach.routes.ts:54` |
| GET | `/api/ai-coach/conversation/:conversationId` | authenticated | `src/modules/ai-coach/ai-coach.routes.ts:45` |
| PUT | `/api/ai-coach/conversation/:conversationId/rename` | authenticated | `src/modules/ai-coach/ai-coach.routes.ts:46` |
| POST | `/api/ai-coach/multiple` | authenticated | `src/modules/ai-coach/ai-coach.routes.ts:11` |
| POST | `/api/ai-coach/rate` | authenticated | `src/modules/ai-coach/ai-coach.routes.ts:28` |
| GET | `/api/ai-coach/status` | authenticated | `src/modules/ai-coach/ai-coach.routes.ts:22` |
| GET | `/api/ai-coach/suggestions` | authenticated | `src/modules/ai-coach/ai-coach.routes.ts:25` |
| POST | `/api/ai-recruitment/analyze-application` | authenticated | `src/modules/ai-recruitment/ai-recruitment.routes.ts:44` |
| POST | `/api/ai-recruitment/generate-post` | authenticated | `src/modules/ai-recruitment/ai-recruitment.routes.ts:53` |
| POST | `/api/ai-recruitment/generate-questions` | authenticated | `src/modules/ai-recruitment/ai-recruitment.routes.ts:56` |
| POST | `/api/ai-recruitment/match-players` | authenticated | `src/modules/ai-recruitment/ai-recruitment.routes.ts:41` |
| POST | `/api/ai-recruitment/rank-candidates` | authenticated | `src/modules/ai-recruitment/ai-recruitment.routes.ts:67` |
| POST | `/api/ai-recruitment/smart-search` | authenticated | `src/modules/ai-recruitment/ai-recruitment.routes.ts:28` |
| DELETE | `/api/auth/account` | authenticated | `src/modules/auth/auth.routes.ts:177` |
| POST | `/api/auth/apple/mobile` | public | `src/modules/auth/auth.routes.ts:183` |
| PUT | `/api/auth/change-password` | authenticated | `src/modules/auth/auth.routes.ts:176` |
| GET | `/api/auth/check-email` | public | `src/modules/auth/auth.routes.ts:156` |
| POST | `/api/auth/check-password-same` | authenticated | `src/modules/auth/auth.routes.ts:161` |
| GET | `/api/auth/check-username` | public | `src/modules/auth/auth.routes.ts:155` |
| POST | `/api/auth/complete-google-profile` | authenticated-onboarding | `src/modules/auth/auth.routes.ts:180` |
| POST | `/api/auth/complete-profile` | authenticated-onboarding | `src/modules/auth/auth.routes.ts:179` |
| GET | `/api/auth/google` | public | `src/modules/auth/auth.routes.ts:185` |
| GET | `/api/auth/google/callback` | public | `src/modules/auth/auth.routes.ts:188` |
| GET | `/api/auth/google/mobile` | public | `src/modules/auth/auth.routes.ts:187` |
| POST | `/api/auth/google/token` | public | `src/modules/auth/auth.routes.ts:182` |
| POST | `/api/auth/guest-token` | public | `src/modules/auth/auth.routes.ts:171` |
| POST | `/api/auth/login` | public | `src/modules/auth/auth.routes.ts:170` |
| POST | `/api/auth/logout` | authenticated-onboarding | `src/modules/auth/auth.routes.ts:178` |
| GET | `/api/auth/me` | authenticated-onboarding | `src/modules/auth/auth.routes.ts:172` |
| PUT | `/api/auth/profile` | authenticated | `src/modules/auth/auth.routes.ts:173` |
| POST | `/api/auth/register` | public | `src/modules/auth/auth.routes.ts:169` |
| POST | `/api/auth/reset-password-otp` | public | `src/modules/auth/auth.routes.ts:160` |
| POST | `/api/auth/send-otp` | public | `src/modules/auth/auth.routes.ts:157` |
| POST | `/api/auth/upload-banner` | authenticated | `src/modules/auth/auth.routes.ts:175` |
| POST | `/api/auth/upload-profile-picture` | authenticated | `src/modules/auth/auth.routes.ts:174` |
| POST | `/api/auth/verify-otp-login` | public | `src/modules/auth/auth.routes.ts:159` |
| POST | `/api/auth/verify-otp-register` | public | `src/modules/auth/auth.routes.ts:158` |
| POST | `/api/calls/accept` | authenticated | `src/legacy-src/routes/calls.js:53` |
| POST | `/api/calls/end` | authenticated | `src/legacy-src/routes/calls.js:69` |
| POST | `/api/calls/group-token` | authenticated | `src/legacy-src/routes/calls.js:90` |
| POST | `/api/calls/initiate` | authenticated | `src/legacy-src/routes/calls.js:44` |
| POST | `/api/calls/reject` | authenticated | `src/legacy-src/routes/calls.js:61` |
| GET | `/api/calls/sessions/:callId` | authenticated | `src/legacy-src/routes/calls.js:84` |
| POST | `/api/calls/sessions/:callId/accept` | authenticated | `src/legacy-src/routes/calls.js:85` |
| POST | `/api/calls/sessions/:callId/decline` | authenticated | `src/legacy-src/routes/calls.js:86` |
| POST | `/api/calls/sessions/:callId/end` | authenticated | `src/legacy-src/routes/calls.js:87` |
| GET | `/api/calls/sessions/pending` | authenticated | `src/legacy-src/routes/calls.js:83` |
| POST | `/api/calls/token` | authenticated | `src/legacy-src/routes/calls.js:41` |
| GET | `/api/challenges` | public-optional-auth | `src/modules/challenges/challenges.routes.ts:59` |
| POST | `/api/challenges` | authenticated | `src/modules/challenges/challenges.routes.ts:63` |
| DELETE | `/api/challenges/:id` | authenticated | `src/modules/challenges/challenges.routes.ts:67` |
| GET | `/api/challenges/:id` | public-optional-auth | `src/modules/challenges/challenges.routes.ts:62` |
| PUT | `/api/challenges/:id` | authenticated | `src/modules/challenges/challenges.routes.ts:66` |
| POST | `/api/challenges/:id/distribute-rewards` | authenticated | `src/modules/challenges/challenges.routes.ts:68` |
| POST | `/api/challenges/:id/join` | authenticated | `src/modules/challenges/challenges.routes.ts:64` |
| PUT | `/api/challenges/:id/progress` | authenticated | `src/modules/challenges/challenges.routes.ts:65` |
| GET | `/api/challenges/my/challenges` | authenticated | `src/modules/challenges/challenges.routes.ts:60` |
| GET | `/api/challenges/my/participations` | authenticated | `src/modules/challenges/challenges.routes.ts:61` |
| GET | `/api/chat/:chatId/messages` | authenticated | `src/modules/chat/chat.routes.ts:7` |
| POST | `/api/chat/messages` | authenticated | `src/modules/chat/chat.routes.ts:8` |
| GET | `/api/feedback` | admin | `src/modules/feedback/feedback.routes.ts:41` |
| POST | `/api/feedback` | public | `src/modules/feedback/feedback.routes.ts:30` |
| DELETE | `/api/feedback/:id` | admin | `src/modules/feedback/feedback.routes.ts:53` |
| PUT | `/api/feedback/:id/status` | admin | `src/modules/feedback/feedback.routes.ts:43` |
| GET | `/api/feedback/stats` | admin | `src/modules/feedback/feedback.routes.ts:42` |
| GET | `/api/health` | public | `src/modules/health/health.routes.ts:5` |
| POST | `/api/host-verification/apply` | authenticated | `src/modules/host-verification/host-verification.routes.ts:8` |
| GET | `/api/host-verification/status` | authenticated | `src/modules/host-verification/host-verification.routes.ts:21` |
| GET | `/api/knowledge` | admin | `src/modules/knowledge/knowledge.routes.ts:16` |
| DELETE | `/api/knowledge/:id` | admin | `src/modules/knowledge/knowledge.routes.ts:19` |
| GET | `/api/knowledge/:id` | admin | `src/modules/knowledge/knowledge.routes.ts:17` |
| PUT | `/api/knowledge/:id` | admin | `src/modules/knowledge/knowledge.routes.ts:18` |
| POST | `/api/knowledge/add` | admin | `src/modules/knowledge/knowledge.routes.ts:14` |
| POST | `/api/knowledge/bulk-add` | admin | `src/modules/knowledge/knowledge.routes.ts:15` |
| GET | `/api/knowledge/stats` | admin | `src/modules/knowledge/knowledge.routes.ts:11` |
| POST | `/api/knowledge/test-retrieval` | admin | `src/modules/knowledge/knowledge.routes.ts:10` |
| POST | `/api/leave-requests/team/:teamId/leave-request` | authenticated | `src/modules/leave-requests/leave-requests.routes.ts:8` |
| DELETE | `/api/leave-requests/team/:teamId/leave-request/:requestId` | authenticated | `src/modules/leave-requests/leave-requests.routes.ts:42` |
| PATCH | `/api/leave-requests/team/:teamId/leave-request/:requestId` | authenticated | `src/modules/leave-requests/leave-requests.routes.ts:30` |
| GET | `/api/leave-requests/team/:teamId/leave-requests` | authenticated | `src/modules/leave-requests/leave-requests.routes.ts:18` |
| GET | `/api/leave-requests/user/leave-requests` | authenticated | `src/modules/leave-requests/leave-requests.routes.ts:27` |
| GET | `/api/membership` | authenticated | `src/modules/membership/membership.routes.ts:24` |
| POST | `/api/membership/cancel` | authenticated | `src/modules/membership/membership.routes.ts:29` |
| POST | `/api/membership/payment/create-order` | authenticated | `src/modules/membership/membership.routes.ts:25` |
| POST | `/api/membership/payment/verify` | authenticated | `src/modules/membership/membership.routes.ts:26` |
| GET | `/api/membership/plans` | public | `src/modules/membership/membership.routes.ts:23` |
| POST | `/api/membership/subscription/create` | authenticated | `src/modules/membership/membership.routes.ts:27` |
| POST | `/api/membership/subscription/verify` | authenticated | `src/modules/membership/membership.routes.ts:28` |
| POST | `/api/messages/:messageId/invite-response` | authenticated | `src/modules/messages/messages.routes.ts:125` |
| POST | `/api/messages/:messageId/reaction` | authenticated | `src/modules/messages/messages.routes.ts:124` |
| POST | `/api/messages/call-summary` | authenticated | `src/modules/messages/messages.routes.ts:121` |
| POST | `/api/messages/chat/:userId/mute` | authenticated | `src/modules/messages/messages.routes.ts:127` |
| POST | `/api/messages/chat/:userId/pin` | authenticated | `src/modules/messages/messages.routes.ts:131` |
| POST | `/api/messages/direct` | authenticated | `src/modules/messages/messages.routes.ts:88` |
| DELETE | `/api/messages/direct/:userId` | authenticated | `src/modules/messages/messages.routes.ts:122` |
| GET | `/api/messages/direct/:userId` | authenticated | `src/modules/messages/messages.routes.ts:89` |
| POST | `/api/messages/direct/:userId/mute` | authenticated | `src/modules/messages/messages.routes.ts:129` |
| POST | `/api/messages/group` | authenticated | `src/modules/messages/messages.routes.ts:118` |
| POST | `/api/messages/group/:chatRoomId/pin` | authenticated | `src/modules/messages/messages.routes.ts:132` |
| POST | `/api/messages/join/:inviteToken` | authenticated | `src/modules/messages/messages.routes.ts:105` |
| GET | `/api/messages/join/:inviteToken/preview` | public | `src/modules/messages/messages.routes.ts:98` |
| POST | `/api/messages/mark-read` | authenticated | `src/modules/messages/messages.routes.ts:120` |
| POST | `/api/messages/pin` | authenticated | `src/modules/messages/messages.routes.ts:136` |
| GET | `/api/messages/preferences` | authenticated | `src/modules/messages/messages.routes.ts:126` |
| GET | `/api/messages/recent` | authenticated | `src/modules/messages/messages.routes.ts:90` |
| POST | `/api/messages/report` | authenticated | `src/modules/messages/messages.routes.ts:134` |
| GET | `/api/messages/rooms` | authenticated | `src/modules/messages/messages.routes.ts:92` |
| POST | `/api/messages/rooms` | authenticated | `src/modules/messages/messages.routes.ts:91` |
| DELETE | `/api/messages/rooms/:chatRoomId` | authenticated | `src/modules/messages/messages.routes.ts:123` |
| GET | `/api/messages/rooms/:chatRoomId` | authenticated | `src/modules/messages/messages.routes.ts:119` |
| PUT | `/api/messages/rooms/:chatRoomId` | authenticated | `src/modules/messages/messages.routes.ts:106` |
| POST | `/api/messages/rooms/:chatRoomId/invite-dm` | authenticated | `src/modules/messages/messages.routes.ts:96` |
| GET | `/api/messages/rooms/:chatRoomId/invite-link` | authenticated | `src/modules/messages/messages.routes.ts:94` |
| POST | `/api/messages/rooms/:chatRoomId/leave` | authenticated | `src/modules/messages/messages.routes.ts:93` |
| POST | `/api/messages/rooms/:chatRoomId/members` | authenticated | `src/modules/messages/messages.routes.ts:115` |
| DELETE | `/api/messages/rooms/:chatRoomId/members/:memberId` | authenticated | `src/modules/messages/messages.routes.ts:117` |
| PUT | `/api/messages/rooms/:chatRoomId/members/:memberId/role` | authenticated | `src/modules/messages/messages.routes.ts:116` |
| POST | `/api/messages/rooms/:chatRoomId/mute` | authenticated | `src/modules/messages/messages.routes.ts:130` |
| PUT | `/api/messages/rooms/:chatRoomId/permissions` | authenticated | `src/modules/messages/messages.routes.ts:97` |
| POST | `/api/messages/rooms/:chatRoomId/reset-invite-link` | authenticated | `src/modules/messages/messages.routes.ts:95` |
| GET | `/api/monetization/application` | authenticated | `src/modules/monetization/monetization.routes.ts:10` |
| GET | `/api/monetization/application/history` | authenticated | `src/modules/monetization/monetization.routes.ts:11` |
| POST | `/api/monetization/application/withdraw` | authenticated | `src/modules/monetization/monetization.routes.ts:13` |
| POST | `/api/monetization/apply` | authenticated | `src/modules/monetization/monetization.routes.ts:12` |
| DELETE | `/api/monetization/bank-details` | authenticated | `src/modules/monetization/monetization.routes.ts:20` |
| GET | `/api/monetization/bank-details` | authenticated | `src/modules/monetization/monetization.routes.ts:17` |
| PUT | `/api/monetization/bank-details` | authenticated | `src/modules/monetization/monetization.routes.ts:18` |
| DELETE | `/api/monetization/bank-details/tax-id` | authenticated | `src/modules/monetization/monetization.routes.ts:19` |
| GET | `/api/monetization/dashboard` | authenticated | `src/modules/monetization/monetization.routes.ts:14` |
| GET | `/api/monetization/earnings` | authenticated | `src/modules/monetization/monetization.routes.ts:15` |
| GET | `/api/monetization/eligibility` | authenticated | `src/modules/monetization/monetization.routes.ts:9` |
| GET | `/api/monetization/payout-history` | authenticated | `src/modules/monetization/monetization.routes.ts:16` |
| GET | `/api/monetization/status` | authenticated | `src/modules/monetization/monetization.routes.ts:21` |
| POST | `/api/monetization/withdrawal-request` | authenticated | `src/modules/monetization/monetization.routes.ts:22` |
| GET | `/api/music/search` | user-or-guest | `src/modules/music/music.routes.ts:128` |
| GET | `/api/notifications` | authenticated | `src/modules/notifications/notifications.routes.ts:922` |
| DELETE | `/api/notifications/:id` | authenticated | `src/modules/notifications/notifications.routes.ts:1100` |
| PUT | `/api/notifications/:id/archive` | authenticated | `src/modules/notifications/notifications.routes.ts:1062` |
| POST | `/api/notifications/:id/click` | authenticated | `src/modules/notifications/notifications.routes.ts:877` |
| POST | `/api/notifications/:id/delivered` | authenticated | `src/modules/notifications/notifications.routes.ts:812` |
| POST | `/api/notifications/:id/open` | authenticated | `src/modules/notifications/notifications.routes.ts:841` |
| PUT | `/api/notifications/:id/read` | authenticated | `src/modules/notifications/notifications.routes.ts:1007` |
| PUT | `/api/notifications/:id/unarchive` | authenticated | `src/modules/notifications/notifications.routes.ts:1081` |
| DELETE | `/api/notifications/client-context` | authenticated | `src/modules/notifications/notifications.routes.ts:537` |
| POST | `/api/notifications/client-context` | authenticated | `src/modules/notifications/notifications.routes.ts:427` |
| GET | `/api/notifications/push-deliveries` | authenticated | `src/modules/notifications/notifications.routes.ts:618` |
| GET | `/api/notifications/push-status` | authenticated | `src/modules/notifications/notifications.routes.ts:560` |
| POST | `/api/notifications/push-test` | authenticated | `src/modules/notifications/notifications.routes.ts:646` |
| DELETE | `/api/notifications/push-token` | authenticated | `src/modules/notifications/notifications.routes.ts:493` |
| POST | `/api/notifications/push-token` | authenticated | `src/modules/notifications/notifications.routes.ts:248` |
| PUT | `/api/notifications/read-all` | authenticated | `src/modules/notifications/notifications.routes.ts:1038` |
| DELETE | `/api/notifications/voip-token` | authenticated | `src/modules/notifications/notifications.routes.ts:395` |
| POST | `/api/notifications/voip-token` | authenticated | `src/modules/notifications/notifications.routes.ts:355` |
| GET | `/api/payments/boost/campaigns` | authenticated | `src/modules/payments/payments.routes.ts:109` |
| POST | `/api/payments/boost/create-order` | authenticated | `src/modules/payments/payments.routes.ts:110` |
| POST | `/api/payments/boost/verify` | authenticated | `src/modules/payments/payments.routes.ts:111` |
| GET | `/api/payments/history` | authenticated | `src/modules/payments/payments.routes.ts:96` |
| POST | `/api/payments/razorpay/webhook` | public | `src/modules/payments/payments.routes.ts:94` |
| POST | `/api/payments/subscription/create` | authenticated | `src/modules/payments/payments.routes.ts:101` |
| POST | `/api/payments/subscription/create-order` | authenticated | `src/modules/payments/payments.routes.ts:99` |
| POST | `/api/payments/subscription/verify` | authenticated | `src/modules/payments/payments.routes.ts:100` |
| POST | `/api/payments/subscription/verify-recurring` | authenticated | `src/modules/payments/payments.routes.ts:102` |
| POST | `/api/payments/tournament/create-order` | authenticated | `src/modules/payments/payments.routes.ts:105` |
| POST | `/api/payments/tournament/verify` | authenticated | `src/modules/payments/payments.routes.ts:106` |
| GET | `/api/posts` | user-or-guest | `src/modules/posts/posts.routes.ts:54` |
| POST | `/api/posts` | authenticated | `src/modules/posts/posts.routes.ts:53` |
| DELETE | `/api/posts/:id` | authenticated | `src/modules/posts/posts.routes.ts:66` |
| GET | `/api/posts/:id` | user-or-guest | `src/modules/posts/posts.routes.ts:58` |
| PUT | `/api/posts/:id` | authenticated | `src/modules/posts/posts.routes.ts:65` |
| POST | `/api/posts/:id/boost` | authenticated | `src/modules/posts/posts.routes.ts:68` |
| POST | `/api/posts/:id/comment` | authenticated | `src/modules/posts/posts.routes.ts:61` |
| POST | `/api/posts/:id/like` | authenticated | `src/modules/posts/posts.routes.ts:60` |
| POST | `/api/posts/:id/report` | authenticated | `src/modules/posts/posts.routes.ts:67` |
| POST | `/api/posts/:id/save` | authenticated | `src/modules/posts/posts.routes.ts:63` |
| POST | `/api/posts/:id/share` | authenticated | `src/modules/posts/posts.routes.ts:62` |
| POST | `/api/posts/:id/view` | authenticated | `src/modules/posts/posts.routes.ts:59` |
| GET | `/api/posts/clips` | user-or-guest | `src/modules/posts/posts.routes.ts:55` |
| POST | `/api/posts/interaction` | authenticated | `src/modules/posts/posts.routes.ts:64` |
| GET | `/api/posts/liked` | authenticated | `src/modules/posts/posts.routes.ts:57` |
| GET | `/api/posts/saved` | authenticated | `src/modules/posts/posts.routes.ts:56` |
| GET | `/api/random-connections/active-sessions` | authenticated | `src/modules/random-connections/random-connections.routes.ts:103` |
| POST | `/api/random-connections/cleanup-current` | authenticated | `src/modules/random-connections/random-connections.routes.ts:107` |
| GET | `/api/random-connections/current-connection` | authenticated | `src/modules/random-connections/random-connections.routes.ts:102` |
| GET | `/api/random-connections/daily-gender-matches-remaining` | authenticated | `src/modules/random-connections/random-connections.routes.ts:41` |
| POST | `/api/random-connections/disconnect` | authenticated | `src/modules/random-connections/random-connections.routes.ts:104` |
| GET | `/api/random-connections/entitlements` | authenticated | `src/modules/random-connections/random-connections.routes.ts:40` |
| POST | `/api/random-connections/join-queue` | authenticated | `src/modules/random-connections/random-connections.routes.ts:100` |
| DELETE | `/api/random-connections/leave-queue` | authenticated | `src/modules/random-connections/random-connections.routes.ts:101` |
| POST | `/api/random-connections/next` | authenticated | `src/modules/random-connections/random-connections.routes.ts:105` |
| GET | `/api/random-connections/queue-status` | authenticated | `src/modules/random-connections/random-connections.routes.ts:16` |
| POST | `/api/random-connections/send-message` | authenticated | `src/modules/random-connections/random-connections.routes.ts:106` |
| POST | `/api/random-connections/v2/cleanup-current` | authenticated | `src/modules/random-connections/random-connections.routes.ts:115` |
| GET | `/api/random-connections/v2/current-connection` | authenticated | `src/modules/random-connections/random-connections.routes.ts:113` |
| POST | `/api/random-connections/v2/disconnect` | authenticated | `src/modules/random-connections/random-connections.routes.ts:114` |
| POST | `/api/random-connections/v2/join-queue` | authenticated | `src/modules/random-connections/random-connections.routes.ts:111` |
| DELETE | `/api/random-connections/v2/leave-queue` | authenticated | `src/modules/random-connections/random-connections.routes.ts:112` |
| PUT | `/api/recruitment/applications/:applicationId/status` | authenticated | `src/modules/recruitment/recruitment.routes.ts:49` |
| GET | `/api/recruitment/applications/my` | authenticated | `src/modules/recruitment/recruitment.routes.ts:46` |
| GET | `/api/recruitment/applications/team` | authenticated | `src/modules/recruitment/recruitment.routes.ts:47` |
| GET | `/api/recruitment/player-profiles` | authenticated | `src/modules/recruitment/recruitment.routes.ts:32` |
| POST | `/api/recruitment/player-profiles` | authenticated | `src/modules/recruitment/recruitment.routes.ts:30` |
| DELETE | `/api/recruitment/player-profiles/:id` | authenticated | `src/modules/recruitment/recruitment.routes.ts:37` |
| GET | `/api/recruitment/player-profiles/:id` | public-optional-auth | `src/modules/recruitment/recruitment.routes.ts:34` |
| PUT | `/api/recruitment/player-profiles/:id` | authenticated | `src/modules/recruitment/recruitment.routes.ts:36` |
| POST | `/api/recruitment/player-profiles/:profileId/interest` | authenticated | `src/modules/recruitment/recruitment.routes.ts:44` |
| GET | `/api/recruitment/player-profiles/daily-limit` | authenticated | `src/modules/recruitment/recruitment.routes.ts:31` |
| GET | `/api/recruitment/profile/:code` | public-optional-auth | `src/modules/recruitment/recruitment.routes.ts:35` |
| GET | `/api/recruitment/profile/:code/preview` | public-optional-auth | `src/modules/recruitment/recruitment.routes.ts:33` |
| POST | `/api/recruitment/profile/:profileId/interest` | authenticated | `src/modules/recruitment/recruitment.routes.ts:45` |
| GET | `/api/recruitment/recruitment/:code` | public-optional-auth | `src/modules/recruitment/recruitment.routes.ts:23` |
| GET | `/api/recruitment/recruitment/:code/preview` | public-optional-auth | `src/modules/recruitment/recruitment.routes.ts:22` |
| POST | `/api/recruitment/recruitment/:recruitmentId/apply` | authenticated | `src/modules/recruitment/recruitment.routes.ts:42` |
| POST | `/api/recruitment/recruitment/:recruitmentId/withdraw` | authenticated | `src/modules/recruitment/recruitment.routes.ts:43` |
| GET | `/api/recruitment/team-applications` | authenticated | `src/modules/recruitment/recruitment.routes.ts:48` |
| GET | `/api/recruitment/team-recruitments` | authenticated | `src/modules/recruitment/recruitment.routes.ts:21` |
| POST | `/api/recruitment/team-recruitments` | authenticated | `src/modules/recruitment/recruitment.routes.ts:20` |
| DELETE | `/api/recruitment/team-recruitments/:id` | authenticated | `src/modules/recruitment/recruitment.routes.ts:28` |
| GET | `/api/recruitment/team-recruitments/:id` | public-optional-auth | `src/modules/recruitment/recruitment.routes.ts:24` |
| PUT | `/api/recruitment/team-recruitments/:id` | authenticated | `src/modules/recruitment/recruitment.routes.ts:25` |
| POST | `/api/recruitment/team-recruitments/:id/close` | authenticated | `src/modules/recruitment/recruitment.routes.ts:26` |
| POST | `/api/recruitment/team-recruitments/:id/reopen` | authenticated | `src/modules/recruitment/recruitment.routes.ts:27` |
| DELETE | `/api/recruitment/team-recruitments/:recruitmentId/apply` | authenticated | `src/modules/recruitment/recruitment.routes.ts:40` |
| POST | `/api/recruitment/team-recruitments/:recruitmentId/apply` | authenticated | `src/modules/recruitment/recruitment.routes.ts:39` |
| POST | `/api/recruitment/team-recruitments/:recruitmentId/withdraw` | authenticated | `src/modules/recruitment/recruitment.routes.ts:41` |
| POST | `/api/reports` | authenticated | `src/modules/reports/reports.routes.ts:7` |
| GET | `/api/rtc/credentials` | admin | `src/legacy-src/routes/rtc.js:100` |
| DELETE | `/api/rtc/credentials/:username` | admin | `src/legacy-src/routes/rtc.js:109` |
| GET | `/api/rtc/ice` | authenticated | `src/legacy-src/routes/rtc.js:72` |
| GET | `/api/rtc/usage` | admin | `src/legacy-src/routes/rtc.js:91` |
| GET | `/api/rtc/usage/:username` | admin | `src/legacy-src/routes/rtc.js:83` |
| GET | `/api/scrims` | public-optional-auth | `src/modules/scrims/scrims.routes.ts:12` |
| POST | `/api/scrims` | authenticated | `src/modules/scrims/scrims.routes.ts:13` |
| DELETE | `/api/scrims/:id` | authenticated | `src/modules/scrims/scrims.routes.ts:20` |
| GET | `/api/scrims/:id` | public-optional-auth | `src/modules/scrims/scrims.routes.ts:18` |
| PUT | `/api/scrims/:id` | authenticated | `src/modules/scrims/scrims.routes.ts:19` |
| POST | `/api/scrims/:id/assign-special-prize` | authenticated | `src/modules/scrims/scrims.routes.ts:28` |
| POST | `/api/scrims/:id/broadcast` | authenticated | `src/modules/scrims/scrims.routes.ts:29` |
| PUT | `/api/scrims/:id/cancel` | authenticated | `src/modules/scrims/scrims.routes.ts:25` |
| POST | `/api/scrims/:id/generate-final-result` | authenticated | `src/modules/scrims/scrims.routes.ts:27` |
| POST | `/api/scrims/:id/join` | authenticated | `src/modules/scrims/scrims.routes.ts:22` |
| POST | `/api/scrims/:id/leave` | authenticated | `src/modules/scrims/scrims.routes.ts:23` |
| POST | `/api/scrims/:id/matches/:matchNumber/results` | authenticated | `src/modules/scrims/scrims.routes.ts:24` |
| POST | `/api/scrims/:id/prize-distribution` | authenticated | `src/modules/scrims/scrims.routes.ts:26` |
| GET | `/api/scrims/code/:code` | public-optional-auth | `src/modules/scrims/scrims.routes.ts:15` |
| POST | `/api/stories` | authenticated | `src/modules/stories/stories.routes.ts:11` |
| DELETE | `/api/stories/:storyId` | authenticated | `src/modules/stories/stories.routes.ts:15` |
| GET | `/api/stories/:storyId` | authenticated | `src/modules/stories/stories.routes.ts:12` |
| POST | `/api/stories/:storyId/view` | authenticated | `src/modules/stories/stories.routes.ts:13` |
| GET | `/api/stories/:storyId/views` | authenticated | `src/modules/stories/stories.routes.ts:14` |
| GET | `/api/stories/feed` | authenticated | `src/modules/stories/stories.routes.ts:9` |
| GET | `/api/stories/user/:userId` | authenticated | `src/modules/stories/stories.routes.ts:10` |
| GET | `/api/tournaments` | public-optional-auth | `src/modules/tournaments/tournaments.routes.ts:29` |
| POST | `/api/tournaments` | authenticated | `src/modules/tournaments/tournaments.routes.ts:30` |
| DELETE | `/api/tournaments/:id` | authenticated | `src/modules/tournaments/tournaments.routes.ts:38` |
| GET | `/api/tournaments/:id` | public-optional-auth | `src/modules/tournaments/tournaments.routes.ts:36` |
| PUT | `/api/tournaments/:id` | authenticated | `src/modules/tournaments/tournaments.routes.ts:37` |
| POST | `/api/tournaments/:id/assign-groups` | authenticated | `src/modules/tournaments/tournaments.routes.ts:44` |
| POST | `/api/tournaments/:id/assign-participant` | authenticated | `src/modules/tournaments/tournaments.routes.ts:58` |
| POST | `/api/tournaments/:id/assign-special-prize` | authenticated | `src/modules/tournaments/tournaments.routes.ts:79` |
| POST | `/api/tournaments/:id/auto-assign-round-2` | authenticated | `src/modules/tournaments/tournaments.routes.ts:76` |
| POST | `/api/tournaments/:id/broadcast-schedule` | authenticated | `src/modules/tournaments/tournaments.routes.ts:67` |
| PUT | `/api/tournaments/:id/cancel` | authenticated | `src/modules/tournaments/tournaments.routes.ts:47` |
| POST | `/api/tournaments/:id/create-round-2` | authenticated | `src/modules/tournaments/tournaments.routes.ts:75` |
| POST | `/api/tournaments/:id/generate-final-result` | authenticated | `src/modules/tournaments/tournaments.routes.ts:78` |
| POST | `/api/tournaments/:id/group-message` | authenticated | `src/modules/tournaments/tournaments.routes.ts:49` |
| DELETE | `/api/tournaments/:id/group-message/:groupId/:round/:messageIndex` | authenticated | `src/modules/tournaments/tournaments.routes.ts:53` |
| GET | `/api/tournaments/:id/group-messages` | authenticated | `src/modules/tournaments/tournaments.routes.ts:51` |
| POST | `/api/tournaments/:id/join` | authenticated | `src/modules/tournaments/tournaments.routes.ts:40` |
| POST | `/api/tournaments/:id/join-duo` | authenticated | `src/modules/tournaments/tournaments.routes.ts:41` |
| POST | `/api/tournaments/:id/leave` | authenticated | `src/modules/tournaments/tournaments.routes.ts:42` |
| POST | `/api/tournaments/:id/leave-team` | authenticated | `src/modules/tournaments/tournaments.routes.ts:43` |
| POST | `/api/tournaments/:id/next-round` | authenticated | `src/modules/tournaments/tournaments.routes.ts:71` |
| POST | `/api/tournaments/:id/open-registration` | authenticated | `src/modules/tournaments/tournaments.routes.ts:80` |
| GET | `/api/tournaments/:id/participants` | authenticated | `src/modules/tournaments/tournaments.routes.ts:56` |
| POST | `/api/tournaments/:id/prize-distribution` | authenticated | `src/modules/tournaments/tournaments.routes.ts:77` |
| GET | `/api/tournaments/:id/qualification-settings` | authenticated | `src/modules/tournaments/tournaments.routes.ts:74` |
| POST | `/api/tournaments/:id/qualification-settings` | authenticated | `src/modules/tournaments/tournaments.routes.ts:73` |
| GET | `/api/tournaments/:id/qualification-status` | authenticated | `src/modules/tournaments/tournaments.routes.ts:72` |
| POST | `/api/tournaments/:id/qualify` | authenticated | `src/modules/tournaments/tournaments.routes.ts:70` |
| POST | `/api/tournaments/:id/recreate-groups` | authenticated | `src/modules/tournaments/tournaments.routes.ts:60` |
| POST | `/api/tournaments/:id/remove-participant` | authenticated | `src/modules/tournaments/tournaments.routes.ts:57` |
| POST | `/api/tournaments/:id/results` | authenticated | `src/modules/tournaments/tournaments.routes.ts:68` |
| GET | `/api/tournaments/:id/results/:round` | authenticated | `src/modules/tournaments/tournaments.routes.ts:69` |
| PUT | `/api/tournaments/:id/round-settings` | authenticated | `src/modules/tournaments/tournaments.routes.ts:59` |
| GET | `/api/tournaments/:id/schedule` | authenticated | `src/modules/tournaments/tournaments.routes.ts:62` |
| POST | `/api/tournaments/:id/schedule` | authenticated | `src/modules/tournaments/tournaments.routes.ts:61` |
| PUT | `/api/tournaments/:id/schedule-config` | authenticated | `src/modules/tournaments/tournaments.routes.ts:66` |
| POST | `/api/tournaments/:id/schedule-matches` | authenticated | `src/modules/tournaments/tournaments.routes.ts:46` |
| DELETE | `/api/tournaments/:id/schedule/:matchId` | authenticated | `src/modules/tournaments/tournaments.routes.ts:64` |
| PUT | `/api/tournaments/:id/schedule/:matchId` | authenticated | `src/modules/tournaments/tournaments.routes.ts:63` |
| DELETE | `/api/tournaments/:id/schedule/round/:round` | authenticated | `src/modules/tournaments/tournaments.routes.ts:65` |
| POST | `/api/tournaments/:id/start` | authenticated | `src/modules/tournaments/tournaments.routes.ts:45` |
| POST | `/api/tournaments/:id/start-match` | authenticated | `src/modules/tournaments/tournaments.routes.ts:54` |
| POST | `/api/tournaments/:id/tournament-message` | authenticated | `src/modules/tournaments/tournaments.routes.ts:48` |
| DELETE | `/api/tournaments/:id/tournament-message/:messageIndex` | authenticated | `src/modules/tournaments/tournaments.routes.ts:52` |
| GET | `/api/tournaments/:id/tournament-messages` | authenticated | `src/modules/tournaments/tournaments.routes.ts:50` |
| POST | `/api/tournaments/:id/update-match-result` | authenticated | `src/modules/tournaments/tournaments.routes.ts:55` |
| GET | `/api/tournaments/by-name/:tournamentName/:hostUsername` | public-optional-auth | `src/modules/tournaments/tournaments.routes.ts:33` |
| GET | `/api/tournaments/code/:code` | public-optional-auth | `src/modules/tournaments/tournaments.routes.ts:32` |
| GET | `/api/tournaments/hosting-limits` | authenticated | `src/modules/tournaments/tournaments.routes.ts:26` |
| GET | `/api/users` | user-or-guest | `src/modules/users/users.routes.ts:72` |
| GET | `/api/users/:id/clips` | user-or-guest | `src/modules/users/users.routes.ts:107` |
| DELETE | `/api/users/:id/follow` | authenticated | `src/modules/users/users.routes.ts:103` |
| POST | `/api/users/:id/follow` | authenticated | `src/modules/users/users.routes.ts:102` |
| GET | `/api/users/:id/followers` | user-or-guest | `src/modules/users/users.routes.ts:104` |
| GET | `/api/users/:id/following` | user-or-guest | `src/modules/users/users.routes.ts:105` |
| GET | `/api/users/:id/posts` | user-or-guest | `src/modules/users/users.routes.ts:106` |
| GET | `/api/users/:identifier` | user-or-guest | `src/modules/users/users.routes.ts:101` |
| GET | `/api/users/:identifier/tournaments` | user-or-guest | `src/modules/users/users.routes.ts:91` |
| POST | `/api/users/:teamId/leave-request` | authenticated | `src/modules/users/users.routes.ts:116` |
| GET | `/api/users/:teamId/leave-requests` | authenticated | `src/modules/users/users.routes.ts:117` |
| GET | `/api/users/:teamId/pending-invites` | authenticated | `src/modules/users/users.routes.ts:115` |
| DELETE | `/api/users/:teamId/roster/:game/:playerId` | authenticated | `src/modules/users/users.routes.ts:110` |
| DELETE | `/api/users/:teamId/roster/:game/leave` | authenticated | `src/modules/users/users.routes.ts:109` |
| POST | `/api/users/:teamId/roster/add` | authenticated | `src/modules/users/users.routes.ts:108` |
| DELETE | `/api/users/:teamId/staff/:playerId` | authenticated | `src/modules/users/users.routes.ts:114` |
| POST | `/api/users/:teamId/staff/add` | authenticated | `src/modules/users/users.routes.ts:111` |
| POST | `/api/users/:teamId/staff/add-by-username` | authenticated | `src/modules/users/users.routes.ts:112` |
| DELETE | `/api/users/:teamId/staff/cancel-by-username` | authenticated | `src/modules/users/users.routes.ts:113` |
| GET | `/api/users/:userId/dm-privacy` | authenticated | `src/modules/users/users.routes.ts:97` |
| GET | `/api/users/:username/tournament-history` | user-or-guest | `src/modules/users/users.routes.ts:92` |
| GET | `/api/users/avatar/:userId` | public | `src/modules/users/users.routes.ts:75` |
| DELETE | `/api/users/block/:username` | authenticated | `src/modules/users/users.routes.ts:78` |
| POST | `/api/users/block/:username` | authenticated | `src/modules/users/users.routes.ts:77` |
| GET | `/api/users/blocked` | authenticated | `src/modules/users/users.routes.ts:76` |
| POST | `/api/users/create-team` | authenticated | `src/modules/users/users.routes.ts:74` |
| POST | `/api/users/follow-requests/:requestId/accept` | authenticated | `src/modules/users/users.routes.ts:99` |
| POST | `/api/users/follow-requests/:requestId/reject` | authenticated | `src/modules/users/users.routes.ts:100` |
| GET | `/api/users/follow-requests/incoming` | authenticated | `src/modules/users/users.routes.ts:98` |
| GET | `/api/users/gaming-stats` | authenticated | `src/modules/users/users.routes.ts:85` |
| POST | `/api/users/gaming-stats` | authenticated | `src/modules/users/users.routes.ts:86` |
| DELETE | `/api/users/gaming-stats/:statId` | authenticated | `src/modules/users/users.routes.ts:88` |
| PUT | `/api/users/gaming-stats/:statId` | authenticated | `src/modules/users/users.routes.ts:87` |
| POST | `/api/users/gaming-stats/sync-coc` | authenticated | `src/modules/users/users.routes.ts:89` |
| POST | `/api/users/gaming-stats/sync-cr` | authenticated | `src/modules/users/users.routes.ts:90` |
| POST | `/api/users/leave-requests/:requestId/approve` | authenticated | `src/modules/users/users.routes.ts:118` |
| POST | `/api/users/leave-requests/:requestId/reject` | authenticated | `src/modules/users/users.routes.ts:119` |
| GET | `/api/users/notification-settings` | authenticated | `src/modules/users/users.routes.ts:95` |
| PUT | `/api/users/notification-settings` | authenticated | `src/modules/users/users.routes.ts:96` |
| GET | `/api/users/privacy-settings` | authenticated | `src/modules/users/users.routes.ts:93` |
| PUT | `/api/users/privacy-settings` | authenticated | `src/modules/users/users.routes.ts:94` |
| DELETE | `/api/users/roster-invite/:inviteId` | authenticated | `src/modules/users/users.routes.ts:79` |
| GET | `/api/users/roster-invites` | authenticated | `src/modules/users/users.routes.ts:81` |
| POST | `/api/users/roster-invites/:inviteId/accept` | authenticated | `src/modules/users/users.routes.ts:82` |
| POST | `/api/users/roster-invites/:inviteId/decline` | authenticated | `src/modules/users/users.routes.ts:83` |
| GET | `/api/users/search` | user-or-guest | `src/modules/users/users.routes.ts:73` |
| DELETE | `/api/users/staff-invite/:inviteId` | authenticated | `src/modules/users/users.routes.ts:84` |
| GET | `/health` | public | `src/app.ts:65` |

## Socket events

| Direction | Event | Source |
|---|---|---|
| outbound | `broadcast_message` | `src/legacy-src/controllers/tournamentController.js:879` |
| outbound | `broadcast_message` | `src/legacy-src/controllers/tournamentController.js:888` |
| outbound | `broadcast-notification` | `src/legacy-src/utils/notificationEmitter.js:31` |
| outbound | `broadcast-push-notification` | `src/legacy-src/utils/notificationEmitter.js:44` |
| inbound | `call-accept` | `src/modules/legacy/legacy.socket.ts:668` |
| outbound | `call-accept` | `src/modules/legacy/legacy.socket.ts:668` |
| outbound | `call-accept` | `src/legacy-src/controllers/callController.js:455` |
| outbound | `call-accept` | `src/legacy-src/controllers/callSessionController.js:78` |
| inbound | `call-end` | `src/modules/legacy/legacy.socket.ts:668` |
| outbound | `call-end` | `src/modules/legacy/legacy.socket.ts:668` |
| outbound | `call-end` | `src/legacy-src/controllers/callController.js:614` |
| outbound | `call-end` | `src/legacy-src/controllers/callSessionController.js:97` |
| outbound | `call-end` | `src/legacy-src/services/callSessionService.js:78` |
| outbound | `call-end` | `src/modules/legacy/legacy.socket.ts:172` |
| outbound | `call-error` | `src/modules/legacy/legacy.socket.ts:503` |
| outbound | `call-error` | `src/modules/legacy/legacy.socket.ts:518` |
| outbound | `call-error` | `src/modules/legacy/legacy.socket.ts:524` |
| outbound | `call-error` | `src/modules/legacy/legacy.socket.ts:532` |
| outbound | `call-error` | `src/modules/legacy/legacy.socket.ts:549` |
| outbound | `call-error` | `src/modules/legacy/legacy.socket.ts:562` |
| outbound | `call-error` | `src/modules/legacy/legacy.socket.ts:583` |
| outbound | `call-error` | `src/modules/legacy/legacy.socket.ts:600` |
| outbound | `call-error` | `src/modules/legacy/legacy.socket.ts:719` |
| outbound | `call-error` | `src/modules/legacy/legacy.socket.ts:784` |
| outbound | `call-error` | `src/modules/legacy/legacy.socket.ts:798` |
| outbound | `call-error` | `src/modules/legacy/legacy.socket.ts:802` |
| outbound | `call-error` | `src/modules/legacy/legacy.socket.ts:806` |
| outbound | `call-error` | `src/modules/legacy/legacy.socket.ts:811` |
| outbound | `call-error` | `src/modules/legacy/legacy.socket.ts:858` |
| outbound | `call-error` | `src/modules/legacy/legacy.socket.ts:902` |
| outbound | `call-missed` | `src/legacy-src/services/callSessionService.js:315` |
| inbound | `call-reject` | `src/modules/legacy/legacy.socket.ts:668` |
| outbound | `call-reject` | `src/modules/legacy/legacy.socket.ts:668` |
| outbound | `call-reject` | `src/legacy-src/controllers/callController.js:526` |
| outbound | `call-reject` | `src/legacy-src/controllers/callSessionController.js:90` |
| inbound | `call-request` | `src/modules/legacy/legacy.socket.ts:489` |
| outbound | `call-request` | `src/legacy-src/controllers/callController.js:296` |
| outbound | `call-request` | `src/modules/legacy/legacy.socket.ts:607` |
| outbound | `call-session-updated` | `src/legacy-src/controllers/callController.js:44` |
| outbound | `call-session-updated` | `src/legacy-src/controllers/callSessionController.js:104` |
| outbound | `call-session-updated` | `src/legacy-src/controllers/callSessionController.js:105` |
| outbound | `call-session-updated` | `src/legacy-src/services/callSessionService.js:79` |
| outbound | `call-session-updated` | `src/modules/legacy/legacy.socket.ts:710` |
| outbound | `call-session-updated` | `src/modules/legacy/legacy.socket.ts:711` |
| inbound | `call-signal` | `src/modules/legacy/legacy.socket.ts:727` |
| outbound | `call-signal` | `src/modules/legacy/legacy.socket.ts:769` |
| outbound | `call:answer` | `src/legacy-src/controllers/callController.js:447` |
| outbound | `call:ended` | `src/legacy-src/controllers/callController.js:607` |
| outbound | `call:offer` | `src/legacy-src/controllers/callController.js:295` |
| outbound | `call:rejected` | `src/legacy-src/controllers/callController.js:519` |
| outbound | `chat:error` | `src/modules/chat/chat.socket.ts:159` |
| outbound | `chat:error` | `src/modules/chat/chat.socket.ts:185` |
| outbound | `chat:error` | `src/modules/chat/chat.socket.ts:192` |
| outbound | `connection-matched` | `src/legacy-src/controllers/randomConnectController.js:1275` |
| outbound | `connection-matched` | `src/legacy-src/controllers/randomConnectController.js:1276` |
| outbound | `connection-matched` | `src/legacy-src/controllers/randomConnectionController.js:186` |
| outbound | `connection-matched` | `src/legacy-src/controllers/randomConnectionController.js:187` |
| outbound | `connection-matched` | `src/legacy-src/controllers/randomConnectionController.js:191` |
| outbound | `connection-matched` | `src/legacy-src/controllers/randomConnectionController.js:197` |
| outbound | `connection-matched` | `src/legacy-src/controllers/randomConnectionController.js:227` |
| outbound | `connection-matched` | `src/legacy-src/controllers/randomConnectionController.js:228` |
| outbound | `connection-matched` | `src/legacy-src/controllers/randomConnectionController.js:233` |
| outbound | `connection-matched` | `src/legacy-src/controllers/randomConnectionController.js:234` |
| outbound | `connection-matched` | `src/legacy-src/controllers/randomConnectionController.js:247` |
| outbound | `connection-matched` | `src/legacy-src/controllers/randomConnectionController.js:248` |
| outbound | `connection-matched` | `src/legacy-src/controllers/randomConnectionController.js:608` |
| outbound | `connection-matched` | `src/legacy-src/controllers/randomConnectionController.js:609` |
| outbound | `connection-matched` | `src/legacy-src/controllers/randomConnectionController.js:743` |
| outbound | `connection-matched` | `src/legacy-src/controllers/randomConnectionController.js:744` |
| outbound | `connection-matched` | `src/legacy-src/controllers/randomConnectionControllerNew.js:96` |
| outbound | `connection-matched` | `src/legacy-src/controllers/randomConnectionControllerNew.js:97` |
| inbound | `disconnect` | `src/infrastructure/websocket/socket.ts:133` |
| inbound | `disconnect` | `src/modules/legacy/legacy.socket.ts:918` |
| outbound | `group-call-ended` | `src/modules/legacy/legacy.socket.ts:343` |
| outbound | `group-call-incoming` | `src/modules/legacy/legacy.socket.ts:840` |
| inbound | `group-call-join` | `src/modules/legacy/legacy.socket.ts:848` |
| outbound | `group-call-joined` | `src/modules/legacy/legacy.socket.ts:834` |
| outbound | `group-call-joined` | `src/modules/legacy/legacy.socket.ts:879` |
| inbound | `group-call-leave` | `src/modules/legacy/legacy.socket.ts:912` |
| outbound | `group-call-not-found` | `src/modules/legacy/legacy.socket.ts:854` |
| outbound | `group-call-participant-joined` | `src/modules/legacy/legacy.socket.ts:885` |
| outbound | `group-call-participant-left` | `src/modules/legacy/legacy.socket.ts:333` |
| outbound | `group-call-participant-left` | `src/modules/legacy/legacy.socket.ts:339` |
| inbound | `group-call-request` | `src/modules/legacy/legacy.socket.ts:791` |
| inbound | `group-call-signal` | `src/modules/legacy/legacy.socket.ts:888` |
| outbound | `group-call-signal` | `src/modules/legacy/legacy.socket.ts:905` |
| outbound | `groupInfoUpdated` | `src/legacy-src/controllers/messageController.js:1643` |
| outbound | `groupPermissionsUpdated` | `src/legacy-src/controllers/messageController.js:2751` |
| inbound | `join-chat-room` | `src/modules/chat/chat.socket.ts:148` |
| inbound | `join-random-queue` | `src/modules/legacy/legacy.socket.ts:354` |
| inbound | `join-random-room` | `src/modules/legacy/legacy.socket.ts:370` |
| inbound | `join-user-room` | `src/infrastructure/websocket/socket.ts:110` |
| inbound | `leave-chat-room` | `src/modules/chat/chat.socket.ts:163` |
| inbound | `leave-random-queue` | `src/modules/legacy/legacy.socket.ts:363` |
| inbound | `leave-random-room` | `src/modules/legacy/legacy.socket.ts:390` |
| inbound | `media-state` | `src/modules/legacy/legacy.socket.ts:475` |
| outbound | `media-state` | `src/modules/legacy/legacy.socket.ts:482` |
| outbound | `memberLeft` | `src/legacy-src/controllers/messageController.js:2458` |
| outbound | `memberRemoved` | `src/legacy-src/controllers/messageController.js:1900` |
| outbound | `message_deleted` | `src/legacy-src/controllers/messageController.js:2266` |
| outbound | `message_deleted` | `src/legacy-src/controllers/messageController.js:2267` |
| outbound | `message_deleted` | `src/legacy-src/controllers/messageController.js:2373` |
| outbound | `message_reaction` | `src/legacy-src/controllers/messageController.js:1527` |
| outbound | `message_reaction` | `src/legacy-src/controllers/messageController.js:1529` |
| outbound | `message_reaction` | `src/legacy-src/controllers/messageController.js:1530` |
| outbound | `new-notification` | `src/legacy-src/utils/notificationEmitter.js:20` |
| outbound | `new-notification` | `src/legacy-src/utils/notificationEmitter.js:316` |
| outbound | `newMessage` | `src/legacy-src/controllers/callController.js:647` |
| outbound | `newMessage` | `src/legacy-src/controllers/messageController.js:350` |
| outbound | `newMessage` | `src/legacy-src/controllers/messageController.js:1214` |
| outbound | `newMessage` | `src/legacy-src/controllers/messageController.js:1640` |
| outbound | `newMessage` | `src/legacy-src/controllers/messageController.js:1779` |
| outbound | `newMessage` | `src/legacy-src/controllers/messageController.js:1895` |
| outbound | `newMessage` | `src/legacy-src/controllers/messageController.js:2454` |
| outbound | `newMessage` | `src/legacy-src/controllers/messageController.js:2591` |
| outbound | `newMessage` | `src/legacy-src/controllers/messageController.js:2596` |
| outbound | `newMessage` | `src/legacy-src/controllers/messageController.js:2774` |
| outbound | `newMessage` | `src/legacy-src/controllers/messageController.js:2922` |
| outbound | `newMessage` | `src/legacy-src/controllers/messageController.js:3009` |
| outbound | `newMessage` | `src/legacy-src/controllers/recruitmentController.js:175` |
| outbound | `newMessage` | `src/modules/chat/chat.socket.ts:190` |
| outbound | `partner-disconnected` | `src/legacy-src/controllers/randomConnectController.js:1314` |
| outbound | `partner-disconnected` | `src/legacy-src/controllers/randomConnectController.js:1453` |
| outbound | `partner-disconnected` | `src/legacy-src/controllers/randomConnectController.js:1518` |
| outbound | `partner-disconnected` | `src/legacy-src/controllers/randomConnectController.js:1731` |
| outbound | `partner-disconnected` | `src/legacy-src/controllers/randomConnectionController.js:333` |
| outbound | `partner-disconnected` | `src/legacy-src/controllers/randomConnectionController.js:501` |
| outbound | `partner-disconnected` | `src/legacy-src/controllers/randomConnectionController.js:922` |
| outbound | `partner-disconnected` | `src/legacy-src/controllers/randomConnectionController.js:1021` |
| outbound | `partner-disconnected` | `src/legacy-src/controllers/randomConnectionControllerNew.js:154` |
| outbound | `partner-disconnected` | `src/legacy-src/controllers/randomConnectionControllerNew.js:310` |
| outbound | `partner-disconnected` | `src/legacy-src/controllers/randomConnectionControllerNew.js:368` |
| inbound | `ping` | `src/infrastructure/websocket/socket.ts:122` |
| outbound | `pong` | `src/infrastructure/websocket/socket.ts:122` |
| outbound | `premium-entitlement-changed` | `src/legacy-src/services/premiumMembershipService.js:344` |
| outbound | `presence:snapshot` | `src/modules/presence/presence.socket.ts:89` |
| inbound | `presence:subscribe` | `src/modules/presence/presence.socket.ts:42` |
| inbound | `presence:unsubscribe` | `src/modules/presence/presence.socket.ts:98` |
| outbound | `presence:updated` | `src/legacy-src/utils/presencePrivacy.js:21` |
| outbound | `presence:updated` | `src/legacy-src/utils/presencePrivacy.js:37` |
| outbound | `presence:updated` | `src/modules/presence/presence.socket.ts:111` |
| outbound | `presence:updated` | `src/modules/presence/presence.socket.ts:131` |
| outbound | `privacy-settings-updated` | `src/legacy-src/utils/presencePrivacy.js:13` |
| outbound | `privacy-settings-updated` | `src/legacy-src/utils/presencePrivacy.js:14` |
| outbound | `profile-updated` | `src/legacy-src/controllers/userController.js:1811` |
| outbound | `profile-updated` | `src/legacy-src/controllers/userController.js:1895` |
| outbound | `profile-updated` | `src/legacy-src/controllers/userController.js:3674` |
| inbound | `random-connection-message` | `src/modules/legacy/legacy.socket.ts:408` |
| outbound | `random-connection-message` | `src/legacy-src/controllers/randomConnectController.js:1662` |
| outbound | `random-connection-message` | `src/legacy-src/controllers/randomConnectController.js:1667` |
| outbound | `random-connection-message` | `src/legacy-src/controllers/randomConnectController.js:1676` |
| outbound | `random-connection-message` | `src/legacy-src/controllers/randomConnectionController.js:829` |
| outbound | `random-connection-message` | `src/modules/legacy/legacy.socket.ts:418` |
| outbound | `random-session-ended` | `src/legacy-src/controllers/randomConnectController.js:216` |
| outbound | `random-session-ended` | `src/legacy-src/controllers/randomConnectController.js:1459` |
| outbound | `random-session-ended` | `src/legacy-src/controllers/randomConnectController.js:1526` |
| outbound | `random-session-ended` | `src/legacy-src/controllers/randomConnectController.js:1737` |
| outbound | `random-session-error` | `src/modules/legacy/legacy.socket.ts:377` |
| outbound | `random-session-error` | `src/modules/legacy/legacy.socket.ts:401` |
| outbound | `random-session-error` | `src/modules/legacy/legacy.socket.ts:415` |
| outbound | `random-session-error` | `src/modules/legacy/legacy.socket.ts:436` |
| outbound | `random-session-error` | `src/modules/legacy/legacy.socket.ts:453` |
| inbound | `random-session-ready` | `src/modules/legacy/legacy.socket.ts:396` |
| outbound | `random-session-ready` | `src/legacy-src/controllers/randomConnectController.js:298` |
| outbound | `random-session-timer-started` | `src/legacy-src/controllers/randomConnectController.js:330` |
| outbound | `random-session-timer-sync` | `src/legacy-src/controllers/randomConnectController.js:337` |
| outbound | `random-session-timer-sync` | `src/modules/legacy/legacy.socket.ts:387` |
| outbound | `random-session-timer-warning` | `src/legacy-src/controllers/randomConnectController.js:180` |
| outbound | `rejoined-queue` | `src/legacy-src/controllers/randomConnectionController.js:617` |
| outbound | `rejoined-queue` | `src/legacy-src/controllers/randomConnectionController.js:774` |
| outbound | `room-joined` | `src/modules/legacy/legacy.socket.ts:382` |
| inbound | `send-message` | `src/modules/chat/chat.socket.ts:179` |
| outbound | `tournament_updated` | `src/legacy-src/controllers/tournamentController.js:804` |
| outbound | `tournament_updated` | `src/legacy-src/controllers/tournamentController.js:841` |
| inbound | `typing-start` | `src/modules/chat/chat.socket.ts:209` |
| inbound | `typing-stop` | `src/modules/chat/chat.socket.ts:210` |
| outbound | `user-joined-room` | `src/modules/legacy/legacy.socket.ts:383` |
| outbound | `user-stopped-typing` | `src/modules/chat/chat.socket.ts:138` |
| outbound | `user-typing` | `src/modules/chat/chat.socket.ts:138` |
| inbound | `video-state-change` | `src/modules/legacy/legacy.socket.ts:462` |
| outbound | `video-state-change` | `src/modules/legacy/legacy.socket.ts:469` |
| inbound | `webrtc-request-offer` | `src/modules/legacy/legacy.socket.ts:446` |
| outbound | `webrtc-request-offer` | `src/modules/legacy/legacy.socket.ts:456` |
| inbound | `webrtc-signal` | `src/modules/legacy/legacy.socket.ts:426` |
| outbound | `webrtc-signal` | `src/modules/legacy/legacy.socket.ts:439` |
