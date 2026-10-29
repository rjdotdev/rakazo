#!/usr/bin/env bash
# `rakazo doctor` against a fake Docker CLI: no daemon or network.
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
fail() { echo "FAIL: $*" >&2; exit 1; }

tmp="$(mktemp -d "${TMPDIR:-/tmp}/rakazo-doctor.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/install" "$tmp/elsewhere"
cp "$root/rakazo" "$root/docker-compose.images.yml" "$tmp/install/"

# Each case sets DOCTOR_* variables; the stubs answer from them.
cat >"$tmp/bin/docker" <<'STUB'
#!/usr/bin/env bash
case "$*" in
  "compose version") exit 0 ;;
  version*)
    [[ "${DOCTOR_DOCKER:-}" != denied ]] || { echo "permission denied while trying to connect to the Docker daemon socket" >&2; exit 1; }
    [[ "${DOCTOR_DOCKER:-}" != down ]] || { echo "Cannot connect to the Docker daemon" >&2; exit 1; }
    echo "${DOCTOR_API_VERSION:-1.47}"
    ;;
  info*) echo "${DOCTOR_DOCKER_ROOT:-}" ;;
  *" config --quiet")
    [[ -z "${DOCTOR_MISSING:-}" ]] && exit 0
    for service in api migrate worker; do
      echo "error while interpolating services.$service.environment.DATABASE_URL: required variable $DOCTOR_MISSING is missing a value: Set $DOCTOR_MISSING in .env" >&2
    done
    exit 1
    ;;
  *" config --environment") sed -E 's/^export //' .env ;;
  *" ps --all --quiet") [[ -z "${DOCTOR_CONTAINERS:-}" ]] || cut -d' ' -f2 <<<"$DOCTOR_CONTAINERS" ;;
  inspect*) printf '%s\n' "$DOCTOR_CONTAINERS" ;;
  *) echo "unexpected docker $*" >&2; exit 99 ;;
esac
STUB
cat >"$tmp/bin/curl" <<'STUB'
#!/usr/bin/env bash
[[ "$*" == *"http://127.0.0.1:3100/ready" ]] || exit 7
ready='{"ok":true,"degraded":false}'
echo "${DOCTOR_READY:-$ready}"
STUB
cat >"$tmp/bin/df" <<'STUB'
#!/usr/bin/env bash
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 100000000 99000000 1048576 99%% /\n'
STUB
chmod +x "$tmp/bin/docker" "$tmp/bin/curl" "$tmp/bin/df"

secret="0123456789abcdef0123456789abcdef-not-a-real-secret"
write_env() {
  printf '%s\n' "POSTGRES_PASSWORD=$secret" "BETTER_AUTH_SECRET=$secret" "$@" >"$tmp/install/.env"
  chmod 600 "$tmp/install/.env"
}

healthy="postgres /rakazo-postgres-1 running healthy 0 0
supervisor /rakazo-supervisor-1 running healthy 0 0
migrate /rakazo-migrate-1 exited none 0 0
computer /rakazo-computer-1 exited none 0 0
api /rakazo-api-1 running healthy 0 0
worker /rakazo-worker-1 running healthy 0 0
web /rakazo-web-1 running none 0 0"

out=""
status=0
doctor() {
  status=0
  out="$(cd "$tmp/elsewhere" && env "$@" PATH="$tmp/bin:$PATH" bash "$tmp/install/rakazo" doctor 2>&1)" || status=$?
  [[ "$out" != *"$secret"* ]] || fail "printed a secret: $out"
}
expect() { [[ "$out" == *"$1"* ]] || fail "missing '$1' in: $out"; }
expect_status() { [[ "$status" == "$1" ]] || fail "exit $status, wanted $1: $out"; }

write_env
doctor DOCTOR_CONTAINERS="$healthy"
expect_status 0
[[ "$out" == "No problems found." ]] || fail "healthy install: $out"

doctor DOCTOR_CONTAINERS=""
expect_status 1
expect "Error: Rakazo is not running. Start it: docker compose -f docker-compose.images.yml up -d"

doctor DOCTOR_CONTAINERS="${healthy/web \/rakazo-web-1 running none 0 0/web /rakazo-web-1 exited none 0 143}"
expect_status 1
[[ "$out" == "Error: web is not running. Start it: docker compose -f docker-compose.images.yml up -d" ]] ||
  fail "stopped service: $out"

touch "$tmp/install/docker-compose.override.yml"
doctor DOCTOR_CONTAINERS=""
expect "Start it: docker compose -f docker-compose.images.yml -f docker-compose.override.yml up -d"
rm "$tmp/install/docker-compose.override.yml"

doctor DOCTOR_DOCKER=denied
expect_status 1
expect "Error: This user cannot use Docker."
doctor DOCTOR_DOCKER=down
expect "Error: Docker is not running."
doctor DOCTOR_API_VERSION=1.43 DOCTOR_CONTAINERS="$healthy"
expect_status 1
expect "Error: Docker Engine 26 or newer is required."

# Compose reports a missing setting once per use; the doctor says it once.
doctor DOCTOR_MISSING=POSTGRES_APP_PASSWORD
expect_status 1
[[ "$out" == "Error: Set POSTGRES_APP_PASSWORD in .env." ]] || fail "missing setting: $out"

write_env "WEB_ORIGIN=https://app.example.com" "API_URL=https://app.example.com/" \
  "export BETTER_AUTH_URL=https://app.example.com" "RAKAZO_HOST=app.example.com"
doctor DOCTOR_CONTAINERS="$healthy"
[[ "$out" == "No problems found." ]] || fail "public install: $out"

write_env "WEB_ORIGIN=http://app.example.com" "SANDBOX_COMPUTER_EGRESS=open"
chmod 644 "$tmp/install/.env"
broken="postgres /rakazo-postgres-1 running healthy 0 0
supervisor /rakazo-supervisor-1 running starting 0 0
migrate /rakazo-migrate-1 exited none 0 1
api /rakazo-api-1 restarting none 4 1
worker /rakazo-worker-1 running starting 2 0
web /rakazo-web-1 created none 0 0"
doctor DOCTOR_CONTAINERS="$broken" DOCTOR_DOCKER_ROOT="$tmp"
expect_status 1
expect "Warning: Other users can read .env. Run: chmod 600 .env"
expect "Warning: Set BETTER_AUTH_URL, WEB_ORIGIN and API_URL to the same address."
expect "Error: Set RAKAZO_HOST=app.example.com in .env"
expect "Warning: WEB_ORIGIN is not https."
expect "Warning: Bot computers can reach this host"
expect "Warning: supervisor is still starting."
expect "Error: api keeps restarting. See why: docker logs --tail 50 rakazo-api-1"
expect "Error: worker keeps restarting. See why: docker logs --tail 50 rakazo-worker-1"
expect "Error: web has not started."
expect "Error: migrate failed. See why: docker logs --tail 50 rakazo-migrate-1"
expect "Warning: Docker has less than 5 GiB of free disk."
[[ "$out" != *"postgres"* ]] || fail "flagged a healthy service: $out"

# A remote computer provider leaves Docker computers' egress moot.
write_env "SANDBOX_PROVIDER=e2b" "SANDBOX_COMPUTER_EGRESS=open"
doctor DOCTOR_CONTAINERS="$healthy"
[[ "$out" == "No problems found." ]] || fail "remote provider: $out"

write_env
doctor DOCTOR_CONTAINERS="$healthy" DOCTOR_READY='{"ok":false,"degraded":false,"database":"unreachable"}'
expect_status 1
expect "Error: The API cannot reach its database. See why: docker logs --tail 50 rakazo-api-1"
doctor DOCTOR_CONTAINERS="$healthy" DOCTOR_READY='{"ok":false,"degraded":true}'
expect_status 0
expect "Warning: Secret storage is degraded."

rm "$tmp/install/.env"
doctor
expect_status 1
expect "Error: .env is missing. Run bash install-images.sh to create it."

usage_status=0
bash "$tmp/install/rakazo" status >/dev/null 2>&1 || usage_status=$?
[[ "$usage_status" == 2 ]] || fail "unknown command exited $usage_status"

echo "ok"
