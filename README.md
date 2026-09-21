# Chat Service

A Node.js service that gives an application private, end to end encrypted direct messaging. It speaks a plain REST API and a Server Sent Events stream to your clients, and [Delta Chat](https://delta.chat/) underneath. Delta Chat is an email based messaging protocol, so every conversation is encrypted, carried over ordinary mail infrastructure, and reachable from the Delta Chat mobile apps. Your clients never see any of that. They call REST endpoints and listen for events.

## Direct messages

Direct messages are the heart of the service. Every user gets their own Delta Chat account, created on demand, so a conversation runs account to account between the two people in it rather than through a shared relay. Nothing in the middle can read it.

Opening a conversation is a single call to `POST /dm`. The service provisions whatever accounts are missing, runs the securejoin handshake that exchanges keys the first time two people talk, and returns a conversation key you use for everything after that: sending, fetching history, subscribing to live events, marking as seen, muting, editing and deleting.

Because each user is a real Delta Chat account, conversations are not limited to your own users. Someone running the Delta Chat app can message a user directly, and that conversation shows up through the same endpoints as any other, marked as an outside contact.

Recent messages for each conversation are cached in the store, so history loads without waiting on the mail layer.

## Other conversation types

The same service also carries two group shaped chat types, both run through a single bot account that is created on first start.

| Type | Description |
|------|-------------|
| Groups | Community groups managed by an administrator, plus groups that any user can create. Groups can be open or require approval, and user groups can be public or private. |
| Order chats | A private chat tied to a transaction, opened between the two people involved. Used by the commerce side of the application. |

## What else it handles

1. Live delivery over Server Sent Events. A message you send is echoed back to subscribers right away, then reconciled once the real message ID is known. Edits and deletions are pushed as their own events.
2. Group moderation with roles, mutes, bans, kicks, join approvals, invite links and an announcement only mode.
3. Rate limiting per user and per chat, and detection of repeated spam messages.
4. Block lists, global mutes and per conversation mutes.
5. A simple JSON store on disk with debounced, atomic writes.

## How it works

Every request follows the same path.

```
Client
  -> Express route
  -> middleware (block check, rate limit, spam filter, group guard, role check)
  -> store.js      reads and writes chat metadata in store.json
  -> dc-client.js  talks to the Delta Chat RPC process
  -> SSE broadcast pushes the result to connected clients
```

Incoming messages arrive through the Delta Chat event stream, are parsed into a clean shape with the sender and text, and are broadcast to whoever is subscribed to that chat.

## Getting started

You need Node.js 20 or newer and a reachable chatmail server. The public server at `nine.testrun.org` works for development with no setup at all.

```bash
npm install
cp .env.example .env
npm run dev
```

`npm run dev` restarts the service automatically when a file changes. Use `npm start` in production.

Once it is running, `GET /health` returns the service status and the chatmail domain in use.

There are no test or lint scripts in this project.

## Configuration

All settings are read from a `.env` file in the project root.

| Variable | Default | Purpose |
|----------|---------|---------|
| `CHAT_SERVICE_PORT` | `4040` | Port the HTTP server listens on. |
| `DC_ACCOUNTS_PATH` | `./dc-data` | Folder for the Delta Chat databases and `store.json`. |
| `CHATMAIL_DOMAIN` | `nine.testrun.org` | Chatmail server used for all accounts. Point this at your own server in production. |
| `RATE_LIMIT_MAX` | `5` | Messages a user may send per chat within one window. |
| `RATE_LIMIT_WINDOW_MS` | `10000` | Length of the rate limit window in milliseconds. |
| `MAX_MSG_LENGTH` | `2000` | Maximum message length in characters. |
| `INTERNAL_TOKEN` | required | Bearer token expected in the `X-Internal-Token` header on internal endpoints. |
| `BOT_ADDR` | optional | Pin the bot account to a fixed address across restarts. |
| `BOT_PASSWORD` | optional | Password that goes with `BOT_ADDR`. |

The `DC_ACCOUNTS_PATH` folder holds every account and the full message history. Back it up regularly.

## API

All endpoints accept and return JSON. Endpoints marked internal require the `X-Internal-Token` header.

### System and accounts

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Service health and chatmail domain. |
| `POST` | `/accounts` | Create a messaging account for a user. |
| `GET` | `/accounts/:username` | Account details. |
| `GET` | `/accounts/:username/qr` | Invite QR code for the account. |
| `GET` | `/accounts/:username/key` | Account key material (internal). |

### Direct messages

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/dm` | Open or look up a conversation between two users. |
| `POST` | `/dm/external` | Open a conversation with an outside contact. |
| `GET` | `/dm/user/:username` | Conversations a user is part of. |
| `POST` | `/dm/:dm_key/send` | Send a message. |
| `GET` | `/dm/:dm_key/messages` | Fetch messages. |
| `PATCH` | `/dm/:dm_key/messages/:message_id` | Edit a message. |
| `DELETE` | `/dm/:dm_key/messages/:message_id` | Delete a message. |
| `GET` | `/dm/:dm_key/events` | Live event stream for the conversation. |
| `POST` | `/dm/:dm_key/seen` | Mark the conversation as seen. |
| `POST` | `/dm/:dm_key/mute` | Mute the conversation. |
| `DELETE` | `/dm/:dm_key/mute` | Unmute the conversation. |
| `DELETE` | `/dm/:dm_key` | Delete the conversation. |

### Order chats

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/chats` | Create or look up an order chat. |
| `POST` | `/send` | Send a message to an order chat. |
| `POST` | `/send-system` | Send a system message. |
| `GET` | `/messages` | Fetch messages for an order chat. |
| `PATCH` | `/messages/:order_id/:message_id` | Edit a message. |
| `DELETE` | `/messages/:order_id/:message_id` | Delete a message. |
| `POST` | `/order-seen` | Mark an order chat as seen. |
| `GET` | `/events` | Live event stream for an order chat. |
| `GET` | `/events/user/:username` | Combined live event stream for everything a user is part of. |

### Shop chats

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/shop-chats/:shop_id` | Chats belonging to a shop. |
| `GET` | `/shop-chats/buyer/:username` | Shop chats a buyer has opened. |
| `DELETE` | `/shop-chats/:order_id` | Delete a shop chat. |
| `GET` | `/shop-events/:shop_id` | Live event stream for a shop. |

### Groups

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/groups` | Create a community group. |
| `GET` | `/groups` | List groups. |
| `GET` | `/groups/:community_id` | Group details. |
| `PATCH` | `/groups/:community_id` | Update group details. |
| `PATCH` | `/groups/:community_id/enabled` | Enable or disable a group. |
| `PUT` | `/groups/:community_id/settings` | Update group settings. |
| `POST` | `/groups/:community_id/send` | Send a message. |
| `GET` | `/groups/:community_id/messages` | Fetch messages. |
| `PATCH` | `/groups/:community_id/messages/:msg_id` | Edit a message. |
| `DELETE` | `/groups/:community_id/messages/:msg_id` | Delete a message. |
| `DELETE` | `/groups/:community_id/messages` | Clear every message in the group. |
| `GET` | `/groups/:community_id/events` | Live event stream for the group. |
| `POST` | `/groups/:community_id/join` | Join a group. |
| `POST` | `/groups/:community_id/rejoin` | Rejoin a group after leaving. |
| `POST` | `/groups/:community_id/leave` | Leave a group. |
| `POST` | `/groups/:community_id/seen` | Mark a group as seen. |
| `POST` | `/groups/:community_id/transfer-ownership` | Hand ownership to another member. |

### Members and moderation

| Method | Path | Minimum role |
|--------|------|--------------|
| `GET` | `/groups/:community_id/members` | member |
| `POST` | `/groups/:community_id/members` | admin |
| `DELETE` | `/groups/:community_id/members/:username` | moderator |
| `POST` | `/groups/:community_id/members/:username/mute` | moderator |
| `DELETE` | `/groups/:community_id/members/:username/mute` | moderator |
| `POST` | `/groups/:community_id/members/:username/ban` | moderator |
| `DELETE` | `/groups/:community_id/members/:username/ban` | moderator |
| `POST` | `/groups/:community_id/members/:username/role` | admin |
| `GET` | `/groups/:community_id/join-requests` | admin |
| `POST` | `/groups/:community_id/join-requests/:username/approve` | admin |
| `DELETE` | `/groups/:community_id/join-requests/:username` | admin |

### Invite links

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/groups/:community_id/invite-links` | Create an invite link. |
| `GET` | `/groups/:community_id/invite-links` | List invite links. |
| `DELETE` | `/groups/:community_id/invite-links/:token` | Revoke an invite link. |
| `POST` | `/groups/:community_id/invite/send` | Send an invite to a user. |
| `GET` | `/invite/:token` | Look up an invite token. |
| `POST` | `/invite/:token/join` | Join a group using an invite token. |

### User groups

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/user-groups` | Create a user group. IDs start with `ug_`. |
| `GET` | `/user-groups/:username` | Groups a user belongs to. |
| `PATCH` | `/user-groups/:group_id` | Update a user group. |
| `DELETE` | `/user-groups/:group_id` | Delete a user group. |

### Blocking

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/moderation/block` | Block a user. |
| `DELETE` | `/moderation/block` | Unblock a user. |
| `GET` | `/moderation/blocks/:username` | Users someone has blocked. |

## Roles

Group members hold one of four roles, ranked from highest to lowest.

| Role | What it allows |
|------|----------------|
| owner | Transfer ownership, enable or disable the group, clear all messages, promote admins. Everything below as well. |
| admin | Approve join requests, invite members, assign roles, mute and ban anyone except the owner. |
| moderator | Delete messages, kick, mute and ban regular members. |
| member | Send messages and delete their own. |

Each request also passes through the block list, the rate limiter, the spam filter and the group guard, which checks membership, bans, mutes and announcement mode before a message is accepted.

## Deployment

A Dockerfile is included, based on the Alpine Node 20 image. The container stores accounts and `store.json` under `/data`, so mount that path to persistent storage and include it in your backups. The image exposes port `4040` and ships with a health check against `/health`.

## Utility scripts

| Script | Purpose |
|--------|---------|
| `migrate-dms.js` | One time migration from the old bot based direct message format to the per user format. Run it before deploying the per user update. |
| `check-config.js` | Print the configuration the service will start with. |

Run any of them with `node <script>.js`.

## Project layout

| File | Role |
|------|------|
| `index.js` | Express routes, the SSE registry, startup and shutdown, and the Delta Chat event listener. |
| `dc-client.js` | Thin wrapper around the Delta Chat RPC subprocess. |
| `store.js` | JSON store on disk with debounced atomic writes. |
| `middleware/blockCheck.js` | Rejects requests between users who have blocked each other. |
| `middleware/rateLimiter.js` | Sliding window rate limit per user and per chat. |
| `middleware/spamFilter.js` | Repeated message detection and length limit. |
| `middleware/groupGuard.js` | Membership, ban, mute and announcement mode checks for group routes. |
| `middleware/requireRole.js` | Minimum role check for moderation actions. |
| `middleware/internalAuth.js` | Bearer token guard for internal endpoints. |

## License

Proprietary. All rights reserved. The source code is confidential and may not be
copied, modified, distributed or used without prior written permission from the
copyright holder. Having access to the code does not grant a license to use it
beyond the purpose that access was given for. See [LICENSE](LICENSE) for the full
terms.
