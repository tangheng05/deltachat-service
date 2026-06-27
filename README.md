# Serey Chat Service

A Node.js / Express microservice that powers the chat features of the Serey
platform. It exposes a REST API and Server-Sent Events (SSE) stream on top of
[Delta Chat](https://delta.chat/) — an email-based, end-to-end encrypted
messaging protocol — bridging conventional REST clients with the Delta Chat
network via the `@deltachat/stdio-rpc-server` subprocess.

## Table of Contents

- [Overview](#overview)
- [Features](#features)
- [Architecture](#architecture)
- [Getting Started](#getting-started)
- [Configuration](#configuration)
- [API Reference](#api-reference)
- [Moderation Model](#moderation-model)
- [Deployment](#deployment)
- [Utility Scripts](#utility-scripts)
- [Project Structure](#project-structure)

## Overview

Order chats and community groups are mediated by a single bot account
(`__bot__`) that is auto-provisioned on startup through a chatmail QR code.
Direct messages do not use the bot: each Serey participant has its own dedicated
Delta Chat account, and DMs are exchanged account-to-account with securejoin
bootstrapping key exchange on first open. Clients interact with the service
exclusively over REST and SSE; the service translates those requests into Delta
Chat RPC calls and relays inbound messages back to subscribed clients in real
time.

Three chat types are supported:

- **Order chats** — buyer/seller group chats tied to a platform order or shop
  inquiry.
- **Community groups** — admin-managed community groups and user-created groups
  that may be public or private.
- **Direct messages** — 1:1 conversations between participants, including
  external contacts initiated from the Delta Chat mobile app.

## Features

- REST API covering accounts, chats, messaging, groups, direct messages, and
  moderation.
- Real-time delivery over Server-Sent Events with optimistic local echo and
  message-ID reconciliation.
- End-to-end encryption inherited from the Delta Chat protocol.
- Group moderation: roles, mutes, bans, kicks, join approvals, invite links, and
  announcement mode.
- Per-user, per-chat rate limiting and repeated-message spam detection.
- Block lists and global / per-DM mutes.
- File-backed JSON store with debounced, atomic writes.

## Architecture

### Request lifecycle

```
Client -> Express route
  -> middleware (blockCheck -> rateLimiter -> spamFilter -> groupGuard -> requireRole)
  -> store.js        (read / write metadata in store.json)
  -> dc-client.js    (Delta Chat RPC: send / receive, manage chats)
  -> SSE broadcast   (push to connected clients)
```

### Real-time events

Inbound Delta Chat messages are formatted and broadcast over SSE to the clients
subscribed to that chat. Delivery is optimistic: a message sent through the
service is echoed to subscribers immediately, then reconciled once the underlying
message ID is known. Edits and deletions are likewise relayed as their own SSE
events.

## Getting Started

### Prerequisites

- Node.js 20 or later
- A reachable chatmail server (the public `nine.testrun.org` works with zero
  setup for development)

### Installation

```bash
npm install
```

### Running

```bash
npm run dev      # Development mode with auto-reload (node --watch)
npm start        # Production start
```

The service listens on the port defined by `CHAT_SERVICE_PORT` (default `4041`).
A health check is available at `GET /health`.

> Note: there are no lint or automated test scripts configured.

## Configuration

Configuration is read from a `.env` file. Copy `.env.example` to `.env` and adjust
as needed.

| Variable               | Default              | Description                                                        |
|------------------------|----------------------|--------------------------------------------------------------------|
| `CHAT_SERVICE_PORT`    | `4041`               | Port the service listens on.                                       |
| `DC_ACCOUNTS_PATH`     | `./dc-data`          | Directory for Delta Chat SQLite databases and `store.json`.        |
| `CHATMAIL_DOMAIN`      | `nine.testrun.org`   | Chatmail server domain (production: `chat.serey.io`).              |
| `RATE_LIMIT_MAX`       | `5`                  | Messages allowed per window, per user, per chat.                   |
| `RATE_LIMIT_WINDOW_MS` | `10000`              | Rate-limit window in milliseconds.                                 |
| `MAX_MSG_LENGTH`       | `2000`               | Maximum message length in characters.                              |
| `INTERNAL_TOKEN`       | (required)           | Bearer token expected in the `X-Internal-Token` header on internal endpoints. |
| `BOT_ADDR`             | (optional)           | Pin the bot to a fixed address across restarts.                    |
| `BOT_PASSWORD`         | (optional)           | Password paired with `BOT_ADDR`.                                   |

The `DC_ACCOUNTS_PATH` directory contains all message history and should be backed
up regularly.

## API Reference

All endpoints return JSON unless otherwise noted. Internal-only endpoints require
the `X-Internal-Token` header.

### System

| Method | Path       | Description                  |
|--------|------------|------------------------------|
| `GET`  | `/health`  | Service health and domain.   |

### Accounts

| Method | Path                          | Description                                  |
|--------|-------------------------------|----------------------------------------------|
| `POST` | `/accounts`                   | Provision a Serey participant account.       |
| `GET`  | `/accounts/:username`         | Fetch account details.                       |
| `GET`  | `/accounts/:username/qr`      | Account invite QR code.                       |
| `GET`  | `/accounts/:username/key`     | Account key material (internal).             |

### Messaging

| Method | Path                                | Description                              |
|--------|-------------------------------------|------------------------------------------|
| `POST` | `/chats`                            | Create or resolve an order chat.         |
| `POST` | `/send`                             | Send a message to an order chat.         |
| `POST` | `/send-system`                      | Send a system message.                   |
| `GET`  | `/messages`                         | Fetch order-chat messages.               |
| `POST` | `/order-seen`                       | Mark an order chat as seen.              |
| `DELETE` | `/messages/:order_id/:message_id` | Delete an order-chat message.            |
| `PATCH`  | `/messages/:order_id/:message_id` | Edit an order-chat message.              |
| `GET`  | `/events`                           | SSE stream for an order chat.            |
| `GET`  | `/events/user/:username`            | Aggregated SSE stream for a user.        |

### Groups

| Method   | Path                                              | Description                          |
|----------|---------------------------------------------------|--------------------------------------|
| `POST`   | `/groups`                                         | Create a Serey community group.      |
| `GET`    | `/groups`                                         | List groups.                         |
| `GET`    | `/groups/:community_id`                           | Group details.                       |
| `PATCH`  | `/groups/:community_id`                           | Update group metadata.               |
| `PATCH`  | `/groups/:community_id/enabled`                   | Enable or disable a group.           |
| `PUT`    | `/groups/:community_id/settings`                  | Update group settings (admin).       |
| `POST`   | `/groups/:community_id/send`                      | Send a group message.                |
| `GET`    | `/groups/:community_id/messages`                  | Fetch group messages.                |
| `DELETE` | `/groups/:community_id/messages/:msg_id`          | Delete a group message.              |
| `PATCH`  | `/groups/:community_id/messages/:msg_id`          | Edit a group message.                |
| `DELETE` | `/groups/:community_id/messages`                  | Clear all group messages (owner).    |
| `GET`    | `/groups/:community_id/events`                    | SSE stream for a group.              |
| `POST`   | `/groups/:community_id/join`                      | Join a group.                        |
| `POST`   | `/groups/:community_id/rejoin`                    | Rejoin a group.                      |
| `POST`   | `/groups/:community_id/leave`                     | Leave a group.                       |
| `POST`   | `/groups/:community_id/seen`                      | Mark a group as seen.                |
| `POST`   | `/groups/:community_id/transfer-ownership`        | Transfer ownership.                  |

### Group membership and moderation

| Method   | Path                                                       | Min. role  |
|----------|------------------------------------------------------------|------------|
| `GET`    | `/groups/:community_id/members`                            | member     |
| `POST`   | `/groups/:community_id/members`                            | admin      |
| `DELETE` | `/groups/:community_id/members/:username`                  | moderator  |
| `POST`   | `/groups/:community_id/members/:username/mute`             | moderator  |
| `DELETE` | `/groups/:community_id/members/:username/mute`             | moderator  |
| `POST`   | `/groups/:community_id/members/:username/ban`              | moderator  |
| `DELETE` | `/groups/:community_id/members/:username/ban`              | moderator  |
| `POST`   | `/groups/:community_id/members/:username/role`             | admin      |
| `GET`    | `/groups/:community_id/join-requests`                      | admin      |
| `POST`   | `/groups/:community_id/join-requests/:username/approve`    | admin      |
| `DELETE` | `/groups/:community_id/join-requests/:username`            | admin      |

### Invite links

| Method   | Path                                              | Description                  |
|----------|---------------------------------------------------|------------------------------|
| `POST`   | `/groups/:community_id/invite-links`              | Create an invite link.       |
| `GET`    | `/groups/:community_id/invite-links`              | List invite links.           |
| `DELETE` | `/groups/:community_id/invite-links/:token`       | Revoke an invite link.       |
| `POST`   | `/groups/:community_id/invite/send`               | Send an invite to a user.    |
| `GET`    | `/invite/:token`                                  | Resolve an invite token.     |
| `POST`   | `/invite/:token/join`                             | Join via an invite token.    |

### User groups

| Method   | Path                          | Description                       |
|----------|-------------------------------|-----------------------------------|
| `POST`   | `/user-groups`                | Create a user group (`ug_`).      |
| `GET`    | `/user-groups/:username`      | List a user's groups.             |
| `PATCH`  | `/user-groups/:group_id`      | Update a user group.              |
| `DELETE` | `/user-groups/:group_id`      | Delete a user group.              |

### Direct messages

| Method   | Path                                     | Description                          |
|----------|------------------------------------------|--------------------------------------|
| `POST`   | `/dm`                                     | Open or resolve a 1:1 DM.            |
| `POST`   | `/dm/external`                            | Open a DM with an external contact.  |
| `GET`    | `/dm/user/:username`                      | List a user's DMs.                   |
| `POST`   | `/dm/:dm_key/send`                        | Send a DM.                           |
| `GET`    | `/dm/:dm_key/messages`                    | Fetch DM messages.                   |
| `GET`    | `/dm/:dm_key/events`                      | SSE stream for a DM.                 |
| `POST`   | `/dm/:dm_key/seen`                        | Mark a DM as seen.                   |
| `POST`   | `/dm/:dm_key/mute`                        | Mute a DM.                           |
| `DELETE` | `/dm/:dm_key/mute`                        | Unmute a DM.                         |
| `DELETE` | `/dm/:dm_key/messages/:message_id`        | Delete a DM message.                 |
| `PATCH`  | `/dm/:dm_key/messages/:message_id`        | Edit a DM message.                   |
| `DELETE` | `/dm/:dm_key`                             | Delete a DM.                         |

### Shops and moderation

| Method   | Path                              | Description                       |
|----------|-----------------------------------|-----------------------------------|
| `GET`    | `/shop-events/:shop_id`           | SSE stream for shop events.       |
| `GET`    | `/shop-chats/:shop_id`            | List shop chats.                  |
| `GET`    | `/shop-chats/buyer/:username`     | List a buyer's shop chats.        |
| `DELETE` | `/shop-chats/:order_id`           | Delete a shop chat.               |
| `POST`   | `/moderation/block`               | Block a user.                     |
| `DELETE` | `/moderation/block`               | Unblock a user.                   |
| `GET`    | `/moderation/blocks/:username`    | List a user's blocks.             |

## Moderation Model

Group roles are ranked as follows:

```
owner (4) > admin (3) > moderator (2) > member (1)
```

| Role      | Capabilities                                                                    |
|-----------|---------------------------------------------------------------------------------|
| owner     | Transfer ownership, enable / disable group, clear all messages, promote admins. |
| admin     | Approve joins, invite members, set roles, mute / ban (not the owner).           |
| moderator | Delete messages, kick, mute, ban (not owner / admin).                           |
| member    | Send messages, delete own messages.                                             |

Additional safeguards run as middleware on each request: block-list checks,
sliding-window rate limiting, repeated-message spam filtering, group membership /
ban / mute / announcement-mode guards, and minimum-role enforcement.

## Deployment

A Docker image based on Alpine Node 20 is provided. The `/data` directory is the
persistent volume for Delta Chat accounts and `store.json`; mount it to durable
storage and include it in backups.

## Utility Scripts

| Script             | Purpose                                                                            |
|--------------------|------------------------------------------------------------------------------------|
| `migrate-dms.js`   | One-time migration from the legacy bot-DM format to the per-user DM format.         |
| `check-config.js`  | Inspect the current configuration.                                                  |

Run a script with `node <script>.js`. Run `migrate-dms.js` before deploying the
per-user DM update.

## Project Structure

| File                          | Role                                                                    |
|-------------------------------|-------------------------------------------------------------------------|
| `index.js`                    | Express routes, SSE registry, IO lifecycle, event listener, formatting. |
| `dc-client.js`                | EventEmitter wrapper around the Delta Chat RPC subprocess.              |
| `store.js`                    | File-backed JSON store with debounced atomic writes.                    |
| `middleware/blockCheck.js`    | Block-list enforcement.                                                 |
| `middleware/rateLimiter.js`   | Per-user, per-chat sliding-window rate limit.                           |
| `middleware/spamFilter.js`    | Repeated-message spam detection.                                        |
| `middleware/groupGuard.js`    | Membership, ban, mute, and announcement-mode checks.                    |
| `middleware/requireRole.js`   | Minimum-role rank enforcement.                                          |
| `middleware/internalAuth.js`  | Bearer-token guard for internal endpoints.                             |

## License

Proprietary. Part of the Serey platform.
