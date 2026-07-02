# Privacy policy contract

The backend is the source of truth. Web and Mobile use the same endpoints and
must treat `privacyAccess` as authoritative instead of recreating these rules.

## Canonical settings

`GET /api/users/privacy-settings` returns the canonical object in `data`:

- `profileVisibility`: `public | followers | private`
- `allowMessageFrom`: `everyone | followers | none`
- `showOnlineStatus`: boolean
- `allowFollowRequests`: boolean
- `showPostsToFollowers`: boolean

`PUT /api/users/privacy-settings` accepts partial canonical updates. Deprecated
Web keys remain accepted during rollout and are returned only in the
`privacySettings` compatibility object. When canonical and deprecated aliases
are both supplied, the canonical value wins. A present but malformed canonical
value fails closed (`private`, `none`, or `false`); a legacy alias is consulted
only when the corresponding canonical field is genuinely absent.

## Access response

Profile endpoints return `privacyAccess` with:

- `canViewProfile`, `canViewPosts`, `canViewClips`, `canViewStories`
- `canViewFollowers`, `canMessage`, `canFollow`, `canSeeOnlineStatus`
- `restricted`, `reason`, `followRequestPending`

Stable reasons are `allowed`, `followers_only`, `private_account`,
`posts_hidden`, `follow_requests_disabled`, `not_follower`,
`messages_disabled`, and `blocked`.

Restricted profile requests return HTTP 200 with minimal identity and no bio,
location, membership details, followers/following, posts, clips, stories,
online state, or privacy configuration. Direct protected-resource endpoints
return HTTP 403 with the same minimal identity/access metadata where useful.

## Follow requests

- `GET /api/users/follow-requests/incoming`
- `POST /api/users/follow-requests/:requestId/accept`
- `POST /api/users/follow-requests/:requestId/reject`

Following a non-public account creates a pending request. A public account is
followed immediately. `allowFollowRequests=false` rejects new follows at the
server even if a client bypasses its disabled button.

The `Follow` collection is the only accepted-relationship authority. The
legacy `User.followers[]` and `User.following[]` arrays are compatibility data
and never grant private access. The release migration backfills `Follow` only
for reciprocal legacy edges, reports one-sided edges for review, repairs exact
duplicates, and verifies the unique indexes.

## Existing conversations

`allowMessageFrom` controls who may initiate a conversation. Participants may
continue an existing direct conversation. The same initiation policy protects
REST calls, Socket.IO calls, and group-invite DMs. Authenticated Random Connect
sessions retain their separate session authorization.

## Realtime presence

Presence is opt-in per viewed user and is never broadcast globally. An
authenticated client sends `presence:subscribe` with `{ userIds: string[] }`
(maximum 100). The server applies profile visibility, approved-follow, block,
active-account, and `showOnlineStatus` rules before joining a private
`presence-<userId>` room. It responds through the acknowledgement and
`presence:snapshot`; subsequent changes use `presence:updated`.

Changing privacy settings evicts every existing subscriber so clients must
resubscribe against the new policy. Unfollow/block removes affected
subscriptions immediately. Suspension/deletion emits a hidden/offline state,
clears cached profiles and auth snapshots, and disconnects existing sockets.

Group chat membership is rechecked against the database for joins, sends,
typing, call signaling, and history reads. Removing or leaving a group evicts
all of that user's sockets from the room across Socket.IO nodes. Typing is
emitted only when the actor exposes online status and the recipient is allowed
to see it. Durable read receipts are redacted when the reader hides activity.

## Cache and durable-reference safety

Every non-health `GET`/`HEAD` API response is marked `private, no-store` and
varies on `Authorization`, preventing a browser, proxy, or CDN from replaying a
viewer-specific response after an unfollow, block, or privacy update. Profile
and authentication caches are invalidated on the same mutations.

Notification inbox reads re-authorize linked content. A stale notification
cannot retain a post excerpt, sender identity, or deep link after the linked
content becomes private, deleted, moderated, or blocked. Public tournament and
scrim DTOs omit chat archives, internal channel identifiers, team internals,
and host-only workflow metadata; authenticated message history uses separate
membership-authorized endpoints.

## Protected media on AWS

API and shared-link routes authorize profile/post access, but an already-known
raw S3 or public-CDN object URL cannot be revoked by application code. Strict
media revocation requires a private S3 origin plus CloudFront signed URLs or
signed cookies with short TTLs and an origin access control. Do not treat a
public immutable media URL as protected content. Roll that AWS change out with
URL/key backfill and client refresh handling before claiming raw-media-link
revocation in production.

## Release migration

Run these against staging first, then production during deployment:

1. `npm run audit:privacy`
2. `npm run migrate:privacy`
3. `npm run verify:privacy`

The migration backfills legacy users and reciprocal accepted follows, repairs
duplicate canonical relationship rows, and verifies the User, Follow, and
FollowRequest indexes plus canonical/legacy alias consistency. It is not
executed automatically by application startup. `audit:privacy` is read-only;
the other two commands require the production `MONGODB_URI` supplied through
the AWS deployment environment.
