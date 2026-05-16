#!/bin/bash

set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
AWS_REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"

fetch_secret_string() {
	aws secretsmanager get-secret-value \
		--secret-id "$1" \
		--query SecretString \
		--output text \
		--region "$AWS_REGION"
}

read_secret_field() {
	local secret_json="$1"
	local primary_key="$2"
	local fallback_key="${3:-}"

	SECRET_JSON="$secret_json" PRIMARY_KEY="$primary_key" FALLBACK_KEY="$fallback_key" node <<'NODE'
const data = JSON.parse(process.env.SECRET_JSON || '{}');
const keys = [process.env.PRIMARY_KEY, process.env.FALLBACK_KEY].filter(Boolean);

for (const key of keys) {
	const value = data[key];
	if (value !== undefined && value !== null && value !== '') {
		process.stdout.write(String(value));
		process.exit(0);
	}
}

process.exit(1);
NODE
}

read_optional_secret_field() {
	if read_secret_field "$1" "$2" "${3:-}" 2>/dev/null; then
		return 0
	fi
	return 1
}

if [[ -n "${DB_SECRET_ARN:-}" ]]; then
	DB_SECRET_JSON="$(fetch_secret_string "$DB_SECRET_ARN")"
	export DB_HOST="$(read_secret_field "$DB_SECRET_JSON" host)"
	export DB_PORT="$(read_secret_field "$DB_SECRET_JSON" port)"
	export DB_NAME="$(read_secret_field "$DB_SECRET_JSON" dbname dbName)"
	export DB_USER="$(read_secret_field "$DB_SECRET_JSON" username user)"
	export DB_PASSWORD="$(read_secret_field "$DB_SECRET_JSON" password)"
fi

if [[ -n "${RUNTIME_SECRET_ARN:-}" ]]; then
	RUNTIME_SECRET_JSON="$(fetch_secret_string "$RUNTIME_SECRET_ARN")"
	export JWT_SECRET="$(read_secret_field "$RUNTIME_SECRET_JSON" JWT_SECRET jwtSecret)"
	export TURN_SHARED_SECRET="$(read_secret_field "$RUNTIME_SECRET_JSON" TURN_SHARED_SECRET turnSharedSecret)"
	export APN_KEY_ID="$(read_secret_field "$RUNTIME_SECRET_JSON" APN_KEY_ID apnKeyId)"
	export APN_TEAM_ID="$(read_secret_field "$RUNTIME_SECRET_JSON" APN_TEAM_ID apnTeamId)"
	export APN_BUNDLE_ID="$(read_secret_field "$RUNTIME_SECRET_JSON" APN_BUNDLE_ID apnBundleId)"

	if APN_PRODUCTION_VALUE="$(read_optional_secret_field "$RUNTIME_SECRET_JSON" APN_PRODUCTION apnProduction)"; then
		export APN_PRODUCTION="$APN_PRODUCTION_VALUE"
	fi
fi

if [[ -n "${FIREBASE_SERVICE_ACCOUNT_SECRET_ARN:-}" ]]; then
	FIREBASE_SERVICE_ACCOUNT_PATH="$APP_DIR/service-account.json"
	fetch_secret_string "$FIREBASE_SERVICE_ACCOUNT_SECRET_ARN" > "$FIREBASE_SERVICE_ACCOUNT_PATH"
	chmod 600 "$FIREBASE_SERVICE_ACCOUNT_PATH"
	export FIREBASE_SERVICE_ACCOUNT_PATH
fi

if [[ -n "${APN_AUTH_KEY_SECRET_ARN:-}" ]]; then
	APN_KEY_PATH="$APP_DIR/apns-key.p8"
	fetch_secret_string "$APN_AUTH_KEY_SECRET_ARN" > "$APN_KEY_PATH"
	chmod 600 "$APN_KEY_PATH"
	export APN_KEY_PATH
fi

cd "$APP_DIR"
exec npm start