#!/usr/bin/env bash
# `rakazo doctor` against a fake Docker CLI that keeps state, so repairs change what the next
# check sees; no daemon, network, or root.
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
fail() { echo "FAIL: $*" >&2; exit 1; }

tmp="$(mktemp -d "${TMPDIR:-/tmp}/rakazo-doctor.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
bin="$tmp/bin" install="$tmp/install" state="$tmp/state"
mkdir -p "$bin" "$install" "$tmp/elsewhere"
cp "$root/rakazo" "$root/docker-compose.images.yml" "$install/"

# State: daemon (Docker runs), group (this user may use it), database (a pgdata volume exists),
# containers (one inspect row each), after-up (the rows `compose up` leaves), no-image (the computer
# image is gone), egress-rules (the host firewall unit is enabled), log (every call).
cat >"$bin/docker" <<'STUB'
#!/usr/bin/env bash
s="$DOCTOR_STATE"
echo "docker $*" >>"$s/log"
running() { [[ -e "$s/daemon" ]]; }
case "$*" in
  "compose version") exit 0 ;;
  version*)
    running || { echo "Cannot connect to the Docker daemon" >&2; exit 1; }
    [[ "${DOCTOR_DOCKER:-}" != denied || -e "$s/group" ]] ||
      { echo "permission denied while trying to connect to the Docker daemon socket" >&2; exit 1; }
    echo "${DOCTOR_API_VERSION:-1.47}"
    ;;
  "info --format {{.DockerRootDir}}") echo "${DOCTOR_DOCKER_ROOT:-}" ;;
  "info --format {{.OperatingSystem}} {{json .SecurityOptions}}") echo 'Ubuntu 24.04 ["name=seccomp"]' ;;
  info) running ;;
  "volume ls"*) [[ ! -e "$s/database" ]] || echo rakazo_pgdata ;;
  "image prune -f" | "builder prune -f") ;;
  *" config --quiet")
    [[ -z "${DOCTOR_MISSING:-}" ]] && exit 0
    for service in api migrate worker; do
      echo "error while interpolating services.$service.environment.X: required variable $DOCTOR_MISSING is missing a value: Set $DOCTOR_MISSING in .env" >&2
    done
    exit 1
    ;;
  *" config --environment") sed -E 's/^export //' .env ;;
  *" ps --all --quiet") [[ ! -s "$s/containers" ]] || cut -d' ' -f2 "$s/containers" ;;
  "inspect --format {{range .Config.Env}}{{println .}}{{end}} rakazo-supervisor-1")
    printf '%s\n' "SANDBOX_SUPERVISOR_TOKEN=$DOCTOR_SUPERVISOR_TOKEN" "RAKAZO_COMPUTER_IMAGE=ghcr.io/elie222/rakazo/computer:edge"
    ;;
  inspect*) cat "$s/containers" ;;
  "image inspect ghcr.io/elie222/rakazo/computer:edge") [[ ! -e "$s/no-image" ]] ;;
  "pull ghcr.io/elie222/rakazo/computer:edge") rm -f "$s/no-image" ;;
  *" up -d"*) [[ ! -e "$s/after-up" ]] || cp "$s/after-up" "$s/containers" ;;
  *" restart "* | *" logs --tail 100"*) ;;
  *) echo "unexpected docker $*" >&2; exit 99 ;;
esac
STUB
# Runs only the stubs here, so a missed stub cannot reach a real command as root.
cat >"$bin/sudo" <<'STUB'
#!/usr/bin/env bash
echo "sudo $*" >>"$DOCTOR_STATE/log"
case "$1" in
  systemctl | usermod) exec "$(dirname "$0")/$@" ;;
  bash) [[ "$2" == ./restrict-computer-egress.sh ]] && exec "$@" ;;
esac
echo "sudo stub refused: $*" >&2
exit 97
STUB
cat >"$bin/systemctl" <<'STUB'
#!/usr/bin/env bash
case "$*" in
  "start docker") touch "$DOCTOR_STATE/daemon" ;;
  show-environment) [[ "${DOCTOR_SYSTEMD:-}" != none ]] ;;
  "is-enabled --quiet rakazo-computer-egress.service") [[ -e "$DOCTOR_STATE/egress-rules" ]] ;;
  "is-failed --quiet rakazo-computer-egress.service") false ;;
  *) echo "unexpected systemctl $*" >&2; exit 99 ;;
esac
STUB
cat >"$bin/usermod" <<'STUB'
#!/usr/bin/env bash
touch "$DOCTOR_STATE/group"
STUB
cat >"$bin/uname" <<'STUB'
#!/usr/bin/env bash
echo "${DOCTOR_UNAME:-Linux}"
STUB
cat >"$bin/curl" <<'STUB'
#!/usr/bin/env bash
echo "curl $*" >>"$DOCTOR_STATE/log"
case "$*" in
  *"/install-images.sh -o install-images.sh.tmp")
    printf '#!/usr/bin/env bash\necho "installer ran in $PWD" >>"$DOCTOR_STATE/log"\n' >install-images.sh.tmp
    ;;
  *"/restrict-computer-egress.sh -o restrict-computer-egress.sh.tmp")
    printf '#!/usr/bin/env bash\necho "egress $*" >>"$DOCTOR_STATE/log"\ntouch "$DOCTOR_STATE/egress-rules"\n' \
      >restrict-computer-egress.sh.tmp
    ;;
  *"http://127.0.0.1:3100/ready")
    ready='{"ok":true,"degraded":false}'
    echo "${DOCTOR_READY:-$ready}"
    ;;
  *"http://127.0.0.1:3100/internal/health")
    health='{"ok":true,"runtime":"pi","sandbox":"docker"}'
    echo "${DOCTOR_HEALTH:-$health}"
    ;;
  *) exit 7 ;;
esac
STUB
cat >"$bin/df" <<'STUB'
#!/usr/bin/env bash
printf 'Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 100000000 99000000 1048576 99%% /\n'
STUB
printf '#!/usr/bin/env bash\nexit 0\n' >"$bin/iptables"
chmod +x "$bin"/*

healthy="postgres /rakazo-postgres-1 running healthy 0 0
supervisor /rakazo-supervisor-1 running healthy 0 0
migrate /rakazo-migrate-1 exited none 0 0
computer /rakazo-computer-1 exited none 0 0
api /rakazo-api-1 running healthy 0 0
worker /rakazo-worker-1 running healthy 0 0
web /rakazo-web-1 running none 0 0"

secret="0123456789abcdef0123456789abcdef-not-a-real-secret"
export DOCTOR_SUPERVISOR_TOKEN="$secret-token"
# Only the stubs and system folders, and a HOME of its own: a rakazo command or install of the
# machine running this test can neither change the results nor be changed.
test_path="$bin:/usr/bin:/bin"
export HOME="$tmp/home"
secrets=("POSTGRES_PASSWORD=$secret" "POSTGRES_APP_PASSWORD=$secret" "BETTER_AUTH_SECRET=$secret"
  "ENCRYPTION_KEY=$secret" "SCREEN_PROXY_SECRET=$secret-screen" "SANDBOX_SUPERVISOR_TOKEN=$secret-token")
# A fresh state with Docker running, the given containers, and .env holding every secret plus "$@".
setup() {
  rm -rf "$state" "$install/.env" "$install/docker-compose.override.yml"
  mkdir "$state"
  touch "$state/daemon" "$state/egress-rules" "$state/log"
  printf '%s\n' "$1" >"$state/containers"
  shift
  printf '%s\n' "${secrets[@]}" "$@" >"$install/.env"
  chmod 600 "$install/.env"
}
env_value() { sed -n "s/^$1=//p" "$install/.env"; }

out=""
status=0
doctor() {
  local args=(doctor)
  [[ "${1:-}" != --fix ]] || { args+=(--fix); shift; }
  status=0
  out="$(cd "$tmp/elsewhere" &&
    env "$@" DOCTOR_STATE="$state" PATH="$test_path" bash "$install/rakazo" "${args[@]}" 2>&1 </dev/null)" ||
    status=$?
  local line value
  [[ "$out" != *"$secret"* ]] || fail "printed a secret: $out"
  # Nor a secret the doctor or installer wrote.
  [[ -f "$install/.env" ]] || return 0
  while IFS= read -r line; do
    case "$line" in *SECRET=?* | *PASSWORD=?* | *TOKEN=?* | ENCRYPTION_KEY=?*) ;; *) continue ;; esac
    value="${line#*=}"
    [[ "$out" != *"$value"* ]] || fail "printed ${line%%=*}: $out"
  done <"$install/.env"
}
expect() { [[ "$out" == *"$1"* ]] || fail "missing '$1' in: $out"; }
refute() { [[ "$out" != *"$1"* ]] || fail "unexpected '$1' in: $out"; }
expect_status() { [[ "$status" == "$1" ]] || fail "exit $status, wanted $1: $out"; }
expect_clean() { [[ "$out" == *"No problems found." && "$status" == 0 ]] || fail "not repaired: $out"; }
logged() { grep -qF -- "$1" "$state/log" || fail "did not run '$1': $(cat "$state/log")"; }
times_logged() { grep -cF -- "$1" "$state/log" || true; }

# Healthy.
setup "$healthy"
doctor
[[ "$out" == "No problems found." && "$status" == 0 ]] || fail "healthy install: $out"

# Stopped: report only when unattended, start it with --fix.
setup ""
doctor
expect_status 1
expect "Error: Rakazo is not running."
expect "Run $install/rakazo doctor --fix to fix 1 of these."
[[ "$(times_logged " up -d")" == 0 ]] || fail "started Rakazo without --fix"
printf '%s\n' "$healthy" >"$state/after-up"
touch "$install/docker-compose.override.yml"
doctor --fix
expect "Starting Rakazo..."
expect_clean
logged "-f docker-compose.images.yml -f docker-compose.override.yml up -d --wait"

# A repair that changes nothing is tried once, not forever.
setup "${healthy/web \/rakazo-web-1 running none 0 0/web /rakazo-web-1 exited none 0 143}"
doctor --fix
expect_status 1
expect "Error: web is not running."
[[ "$(times_logged " up -d --wait")" == 1 ]] || fail "retried a repair that did not help: $(cat "$state/log")"

# Even alongside other repairs: a restart that leaves postgres unhealthy runs once.
setup "${healthy/postgres \/rakazo-postgres-1 running healthy/postgres /rakazo-postgres-1 running unhealthy}"
chmod 644 "$install/.env"
doctor --fix
expect_status 1
expect "Error: postgres is unhealthy."
[[ "$(times_logged "restart postgres")" == 1 ]] || fail "restarted postgres again: $(cat "$state/log")"

# Docker.
setup "$healthy"
rm "$state/daemon"
doctor
expect "Error: Docker is not running."
expect "fix 1 of these"
doctor --fix
expect "Starting Docker..."
expect_clean
logged "sudo systemctl start docker"

setup "$healthy"
doctor --fix DOCTOR_DOCKER=denied
expect_status 1
expect "Error: This user cannot use Docker."
expect "to the docker group. Sign out and back in, then run $install/rakazo doctor again."
logged "sudo usermod -aG docker"

setup "$healthy"
doctor DOCTOR_API_VERSION=1.43
expect_status 1
expect "Error: Docker Engine 26 or newer is required."
refute "--fix"

# Secrets: generated when missing, except the two existing data depends on.
setup "$healthy"
grep -Ev '^(POSTGRES_APP_PASSWORD|SCREEN_PROXY_SECRET|ENCRYPTION_KEY)=' "$install/.env" >"$tmp/env"
printf 'SCREEN_PROXY_SECRET=\n' >>"$tmp/env"
cp "$tmp/env" "$install/.env"
doctor
expect "Error: ENCRYPTION_KEY is missing from .env."
expect "fix 3 of these"
doctor --fix
expect "Generated SCREEN_PROXY_SECRET in .env."
expect_clean
[[ "$(env_value POSTGRES_APP_PASSWORD)" =~ ^[0-9a-f]{32}$ ]] || fail "POSTGRES_APP_PASSWORD: $(env_value POSTGRES_APP_PASSWORD)"
[[ "$(env_value ENCRYPTION_KEY)" =~ ^[0-9a-f]{64}$ ]] || fail "ENCRYPTION_KEY was not generated"
[[ "$(grep -c '^SCREEN_PROXY_SECRET=' "$install/.env")" == 1 ]] || fail "SCREEN_PROXY_SECRET is not one line"
[[ "$(env_value SCREEN_PROXY_SECRET)" =~ ^[0-9a-f]{64}$ ]] || fail "empty SCREEN_PROXY_SECRET was kept"
[[ "$(env_value POSTGRES_PASSWORD)" == "$secret" ]] || fail "replaced a secret that was set"

setup "$healthy"
touch "$state/database"
grep -v '^ENCRYPTION_KEY=' "$install/.env" >"$tmp/env" && cp "$tmp/env" "$install/.env"
doctor --fix
expect_status 1
expect "Error: ENCRYPTION_KEY is missing from .env. Restore it from a backup of .env"
refute "Generated"
grep -q '^ENCRYPTION_KEY=' "$install/.env" && fail "invented ENCRYPTION_KEY over existing data"

# Compose reports a missing setting once per use; the doctor says it once.
setup "$healthy"
doctor DOCTOR_MISSING=TELEGRAM_BOT_TOKEN
expect_status 1
[[ "$out" == "Error: Set TELEGRAM_BOT_TOKEN in .env." ]] || fail "missing setting: $out"

setup "$healthy"
chmod 644 "$install/.env"
doctor --fix
expect "Warning: Other users can read .env."
expect "Made .env readable only by you."
expect_clean
[[ -z "$(find "$install/.env" \( -perm -040 -o -perm -004 \))" ]] || fail ".env is still readable by others"

# The public address.
setup "$healthy" "WEB_ORIGIN=https://app.example.com/"
doctor
expect "Warning: BETTER_AUTH_URL, WEB_ORIGIN and API_URL differ."
expect "Error: RAKAZO_HOST is not app.example.com, so the web app refuses requests for it."
expect "fix 2 of these"
doctor --fix
expect "Set Rakazo's address in .env to https://app.example.com."
expect_clean
for name in WEB_ORIGIN BETTER_AUTH_URL API_URL; do
  [[ "$(env_value "$name")" == https://app.example.com ]] || fail "$name: $(env_value "$name")"
done
[[ "$(env_value RAKAZO_HOST)" == app.example.com ]] || fail "RAKAZO_HOST: $(env_value RAKAZO_HOST)"

setup "$healthy" "WEB_ORIGIN=https://a.example.com" "export BETTER_AUTH_URL=https://b.example.com"
doctor --fix
expect "Warning: BETTER_AUTH_URL, WEB_ORIGIN and API_URL name different addresses."
expect "Error: RAKAZO_HOST is not a.example.com"
refute "Set Rakazo's address"
[[ "$(env_value WEB_ORIGIN)" == https://a.example.com ]] || fail "picked an address for the operator"

setup "$healthy" "WEB_ORIGIN=http://app.example.com" "BETTER_AUTH_URL=http://app.example.com" \
  "API_URL=http://app.example.com" "RAKAZO_HOST=app.example.com"
doctor
expect_status 0
[[ "$out" == "Warning: http://app.example.com is not https. Put TLS in front of Rakazo." ]] || fail "http: $out"

# Computers: the provider the API actually runs.
setup "$healthy" "SANDBOX_PROVIDER=e2b"
doctor DOCTOR_HEALTH='{"ok":true,"sandbox":"none"}'
expect_status 1
expect "Error: Bots have no computers: SANDBOX_PROVIDER=e2b is missing its key or settings."
refute "--fix"
doctor DOCTOR_HEALTH='{"ok":true,"sandbox":"e2b"}'
expect_clean

# The computer image, which a `docker system prune -a` removes.
setup "$healthy"
touch "$state/no-image"
doctor
expect "Error: The bot computer image is missing, so computers cannot start."
doctor --fix
expect "Downloaded the bot computer image."
expect_clean
logged "docker pull ghcr.io/elie222/rakazo/computer:edge"
refute "$DOCTOR_SUPERVISOR_TOKEN"

# Computer egress, where this Docker can enforce the host rules.
cat >"$tmp/egress-stub" <<'STUB'
#!/usr/bin/env bash
echo "egress $*" >>"$DOCTOR_STATE/log"
touch "$DOCTOR_STATE/egress-rules"
STUB
setup "$healthy" "SANDBOX_COMPUTER_EGRESS=open"
cp "$tmp/egress-stub" "$install/restrict-computer-egress.sh"
doctor
expect "Warning: Bot computers can reach this host, its LAN and cloud metadata."
expect "fix 1 of these"
doctor --fix
logged "sudo bash ./restrict-computer-egress.sh"
expect_clean
[[ "$(grep -c '^SANDBOX_COMPUTER_EGRESS=' "$install/.env")" == 1 && "$(env_value SANDBOX_COMPUTER_EGRESS)" == restricted ]] ||
  fail "egress setting: $(grep EGRESS "$install/.env")"
logged " up -d --wait"

# Unset (auto) without the rules is open; the script is fetched when it is not here.
setup "$healthy"
rm "$state/egress-rules" "$install/restrict-computer-egress.sh"
doctor --fix
expect "Warning: Bot computers can reach this host"
logged "/restrict-computer-egress.sh -o restrict-computer-egress.sh.tmp"
logged "sudo bash ./restrict-computer-egress.sh"
expect_clean

# Restricted without the rules: computers cannot start.
setup "$healthy" "SANDBOX_COMPUTER_EGRESS=restricted"
rm "$state/egress-rules"
doctor
expect_status 1
expect "Error: Bot computers cannot start: SANDBOX_COMPUTER_EGRESS=restricted, but this host's firewall rules are not in place."
expect "fix 1 of these"

# Only a script no one else can change runs with sudo.
chmod o+w "$install/restrict-computer-egress.sh"
doctor --fix
expect "Warning: Other users can change restrict-computer-egress.sh, so it is not run with sudo."
grep -q "sudo bash" "$state/log" && fail "ran a script others can change with sudo"
rm "$install/restrict-computer-egress.sh"

# Without systemd the rules cannot be read, so unset says nothing.
setup "$healthy"
rm "$state/egress-rules"
doctor DOCTOR_SYSTEMD=none
expect_clean

# Where this Docker cannot enforce them (macOS, Docker Desktop): quiet, unless set to restricted.
setup "$healthy" "SANDBOX_COMPUTER_EGRESS=open"
doctor DOCTOR_UNAME=Darwin
expect_clean
setup "$healthy" "SANDBOX_COMPUTER_EGRESS=restricted"
doctor DOCTOR_UNAME=Darwin
expect_status 1
expect "Error: SANDBOX_COMPUTER_EGRESS=restricted cannot work with this Docker, so bot computers cannot start."
refute "--fix"

setup "$healthy" "SANDBOX_PROVIDER=e2b" "SANDBOX_COMPUTER_EGRESS=open"
rm "$state/egress-rules"
doctor
expect_clean

# A folder others can write: its Compose file and .env run through Docker as root.
setup "$healthy"
chmod o+w "$install"
doctor
expect "Error: Other users can change $install."
doctor --fix
expect "Other users can no longer change $install."
expect_clean

# Containers.
broken="postgres /rakazo-postgres-1 running unhealthy 0 0
supervisor /rakazo-supervisor-1 running starting 0 0
migrate /rakazo-migrate-1 exited none 0 1
api /rakazo-api-1 restarting none 4 1
worker /rakazo-worker-1 running starting 2 0
web /rakazo-web-1 created none 0 0"
setup "$broken"
doctor
expect_status 1
expect "Error: postgres is unhealthy. See why: $install/rakazo logs postgres"
expect "Warning: supervisor is still starting."
expect "Error: api keeps restarting. See why: $install/rakazo logs api"
expect "Error: worker keeps restarting. See why: $install/rakazo logs worker"
expect "Error: web has not started."
expect "Error: migrate failed. See why: $install/rakazo logs migrate"
expect "fix 3 of these"
printf '%s\n' "$healthy" >"$state/after-up"
doctor --fix
expect "Restarted postgres."
expect_clean
logged "restart postgres"

setup "$healthy"
doctor --fix DOCTOR_READY='{"ok":false,"degraded":false,"database":"unreachable"}'
expect_status 1
expect "Error: The API cannot reach its database. See why: $install/rakazo logs api"
refute "Starting Rakazo"
doctor DOCTOR_READY='{"ok":false,"degraded":true}'
expect_status 0
expect "Warning: Secret storage is degraded."

setup "$healthy"
doctor --fix DOCTOR_DOCKER_ROOT="$tmp"
expect "Warning: Docker has less than 5 GiB of free disk."
expect "Removed unused Docker images and build cache."
logged "docker image prune -f"
logged "docker builder prune -f"

# .env itself: the installer creates it when it is here.
setup "$healthy"
rm "$install/.env"
doctor
expect "Error: .env is missing. Run bash install-images.sh to create it."
refute "--fix"
cat >"$install/install-images.sh" <<'STUB'
#!/usr/bin/env bash
echo "installer $*" >>"$DOCTOR_STATE/log"
for name in POSTGRES_PASSWORD POSTGRES_APP_PASSWORD BETTER_AUTH_SECRET ENCRYPTION_KEY SCREEN_PROXY_SECRET SANDBOX_SUPERVISOR_TOKEN; do
  echo "$name=installer-value"
done >.env
chmod 600 .env
STUB
doctor --fix
logged "installer --local"
expect_clean
rm "$install/install-images.sh"

# In a terminal it asks first, and a no changes nothing.
if script --version 2>/dev/null | grep -q util-linux; then
  setup ""
  printf '%s\n' "$healthy" >"$state/after-up"
  out="$(cd "$tmp/elsewhere" && printf 'n\n' |
    DOCTOR_STATE="$state" PATH="$test_path" script -qec "bash '$install/rakazo' doctor" /dev/null)" || true
  expect "Fix 1 of these? [Y/n]"
  refute "Starting Rakazo"
  out="$(cd "$tmp/elsewhere" && printf '\n' |
    DOCTOR_STATE="$state" PATH="$test_path" script -qec "bash '$install/rakazo' doctor" /dev/null)" || true
  expect "Starting Rakazo..."
  expect "No problems found."
fi

# logs: the last lines, followed only in a terminal so a script or agent gets them back.
setup "$healthy"
(cd "$tmp/elsewhere" && DOCTOR_STATE="$state" PATH="$test_path" bash "$install/rakazo" logs api worker </dev/null >/dev/null)
logged "-f docker-compose.images.yml logs --tail 100 api worker"
grep -q -- "--follow" "$state/log" && fail "followed logs without a terminal"
if script --version 2>/dev/null | grep -q util-linux; then
  (cd "$tmp/elsewhere" && DOCTOR_STATE="$state" PATH="$test_path" script -qec "bash '$install/rakazo' logs" /dev/null >/dev/null)
  logged "logs --tail 100 --follow"
fi

# update: fetch the newest installer next to this file and run it there.
setup "$healthy"
(cd "$tmp/elsewhere" && DOCTOR_STATE="$state" PATH="$test_path" bash "$install/rakazo" update </dev/null)
logged "https://raw.githubusercontent.com/elie222/rakazo/main/infra/compose/install-images.sh -o install-images.sh.tmp"
logged "installer ran in $install"
[[ ! -e "$install/install-images.sh.tmp" ]] || fail "left the download behind"
(cd "$tmp/elsewhere" && RAKAZO_DOWNLOAD_BASE=https://mirror.example.com/rakazo/ DOCTOR_STATE="$state" PATH="$test_path" \
  bash "$install/rakazo" update </dev/null)
logged "https://mirror.example.com/rakazo/install-images.sh -o"
rm "$install/install-images.sh"

[[ "$(bash "$install/rakazo")" == "Usage: rakazo <command>"* ]] || fail "no usage without a command"
for args in "status" "doctor --bogus" "doctor --fix extra" "update now"; do
  usage_status=0
  # shellcheck disable=SC2086 # one argument per word
  bash "$install/rakazo" $args >/dev/null 2>&1 || usage_status=$?
  [[ "$usage_status" == 2 ]] || fail "'$args' exited $usage_status"
done

echo "ok"
