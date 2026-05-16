# Vidrom Signaling Server

This package runs the real-time call backend for Vidrom.

It owns:

- the WebSocket signaling contract used by the mobile apps
- push-triggered call fanout and accept reconciliation
- runtime TURN credential generation via `/api/rtc-config`
- resident/intercom/watch state transitions

This repo is deployed in two contexts:

- locally with `npm start`
- in production on the signaling EC2 instance via [run.sh](run.sh)

## Local Development

Install dependencies:

```sh
npm install
```

Run the service:

```sh
npm start
```

The server listens on port `8080`.

Run tests:

```sh
npm test
```

## Runtime Config Contract

`src/startupConfig.js` is the source of truth for required runtime configuration.

Always required:

- `JWT_SECRET`

Required in production:

- `DB_HOST`
- `DB_PORT`
- `DB_NAME`
- `DB_USER`
- `DB_PASSWORD`
- one of `FIREBASE_SERVICE_ACCOUNT_JSON`, `FIREBASE_SERVICE_ACCOUNT_PATH`, or `GOOGLE_APPLICATION_CREDENTIALS`
- `APN_KEY_PATH`
- `APN_KEY_ID`
- `APN_TEAM_ID`
- `APN_BUNDLE_ID`
- `TURN_SHARED_SECRET`

Optional runtime tuning:

- `NODE_ENV`
- `APN_PRODUCTION`
- `TURN_HOST`
- `TURN_PUBLIC_IP`
- `TURN_PORT`
- `TURN_REALM`
- `TURN_TTL_SECONDS`
- `STUN_SERVERS`

In local development, the server can fall back to checked-out files when `NODE_ENV` is not `production`:

- `service-account.json`
- `apns-key.p8`

Production should not rely on those fallback files.

## Production Secret Flow

The EC2 service entrypoint is [run.sh](run.sh).

It resolves secrets from AWS Secrets Manager and exports the env vars expected by `src/startupConfig.js`:

- `DB_SECRET_ARN` is read for database credentials
- `RUNTIME_SECRET_ARN` is read for JWT, TURN, and APNs runtime settings
- `FIREBASE_SERVICE_ACCOUNT_SECRET_ARN` is materialized to `service-account.json`
- `APN_AUTH_KEY_SECRET_ARN` is materialized to `apns-key.p8`

## Public Endpoints

- WebSocket: `wss://signaling.vidrom.com`
- Runtime ICE config: `GET https://signaling.vidrom.com/api/rtc-config`

The RTC config response is deliberately served with `Cache-Control: no-store` because TURN credentials are short-lived.

## Canonical Signaling Messages

The current live contract is:

- `ring`
- `offer`
- `answer`
- `candidate`
- `accept`
- `decline`
- `hangup`
- `watch`
- `watch-end`

The design docs in `vidrom-ai-design` were aligned to these names in step 12-B2. Treat the server handlers as the implementation source of truth when validating message behavior.

## Deployment

Infra and DNS changes are deployed from `vidrom-cdk`.

Code-only updates to the EC2 signaling service are deployed with:

```sh
cd ../vidrom-cdk
./deploy-server-ssm.sh
```