#!/usr/bin/env bash
# `curl -fsSL <url> | bash`: the installer piped into bash, against fake curl, Docker and sudo, with
# HOME and PATH inside a temporary folder; no network, daemon, or root.
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
fail() { echo "FAIL: $*" >&2; exit 1; }

tmp="$(mktemp -d "${TMPDIR:-/tmp}/install-one-line.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT
bin="$tmp/bin" tools="$tmp/tools"
mkdir -p "$bin" "$tools" "$tmp/cwd"
export STUB_LOG="$tmp/log" SRC="$root" FULL_DOCKER="$bin/docker" TOOLS="$tools"
# Restricted egress needs root; the egress smoke covers it.
export SANDBOX_COMPUTER_EGRESS=open

cat >"$bin/docker" <<'STUB'
#!/usr/bin/env bash
echo "docker $*" >>"$STUB_LOG"
case "$*" in
  "compose version"*) echo "Docker Compose version v2.29.0" ;;
  "compose up --help") echo "--pull --wait --wait-timeout" ;;
  info*) ;;
  *" config --environment") cat >/dev/null; sed -E 's/^export //' .env ;;
  *" pull" | *" up -d"*) ;;
  *) echo "unexpected docker $*" >&2; exit 99 ;;
esac
STUB
# Serves the files the installer downloads from this checkout, and a Docker install script that
# puts the fake Docker on PATH.
cat >"$bin/curl" <<'STUB'
#!/usr/bin/env bash
echo "curl $*" >>"$STUB_LOG"
[[ " $* " != *" --help "* ]] || { echo "--retry-all-errors"; exit 0; }
out="" url="" prev=""
for arg in "$@"; do
  [[ "$prev" != -o ]] || out="$arg"
  [[ "$arg" != https://* ]] || url="$arg"
  prev="$arg"
done
case "$url" in
  https://get.docker.com) printf 'ln -s "%s" "%s/docker"\n' "$FULL_DOCKER" "$TOOLS" ;;
  */install-images.sh | */docker-compose.images.yml | */.env.images.example | */rakazo) cp "$SRC/${url##*/}" "$out" ;;
  *) exit 22 ;;
esac
STUB
cat >"$bin/sudo" <<'STUB'
#!/usr/bin/env bash
echo "sudo $*" >>"$STUB_LOG"
exec "$@"
STUB
chmod +x "$bin"/*

out=""
status=0
# Pipes the installer into bash from an unrelated folder, as `curl … | bash` does. /usr/local/bin
# stays off PATH so the real one is never written.
install_piped() {
  status=0
  out="$(cd "$tmp/cwd" && env HOME="$tmp/home" PATH="$tmp/home/.local/bin:$bin:/usr/bin:/bin" "$@" \
    bash <"$root/install-images.sh" 2>&1)" || status=$?
}
expect() { [[ "$out" == *"$1"* ]] || fail "missing '$1' in: $out"; }

mkdir -p "$tmp/home/.local/bin"
install_piped
[[ "$status" == 0 ]] || fail "piped install exited $status: $out"
home_dir="$tmp/home/rakazo"
for file in install-images.sh docker-compose.images.yml .env.images.example rakazo .env; do
  [[ -f "$home_dir/$file" ]] || fail "the rakazo folder in HOME is missing $file"
done
[[ -z "$(ls -A "$tmp/cwd")" ]] || fail "wrote into the folder it was run from: $(ls -A "$tmp/cwd")"
key="$(sed -n 's/^ENCRYPTION_KEY=//p' "$home_dir/.env")"
[[ "$key" =~ ^[0-9a-f]{64}$ ]] || fail "ENCRYPTION_KEY was not generated without OpenSSL"
grep -q "docker compose --env-file .env -f docker-compose.images.yml up -d" "$STUB_LOG" || fail "did not start Rakazo"
expect "Rakazo is starting at http://127.0.0.1:5173"
expect "Commands: rakazo doctor, rakazo logs, rakazo update"

# The command on PATH runs this install's copy from anywhere.
command_path="$tmp/home/.local/bin/rakazo"
[[ -x "$command_path" ]] || fail "rakazo is not on PATH"
help="$(cd / && "$command_path" --help)"
[[ "$help" == "Usage: rakazo <command>"* ]] || fail "the rakazo command does not run the install's copy: $help"

# Running the one-liner again keeps .env and its secrets.
install_piped
[[ "$status" == 0 ]] || fail "second piped install exited $status: $out"
expect "Keeping existing .env."
[[ "$(sed -n 's/^ENCRYPTION_KEY=//p' "$home_dir/.env")" == "$key" ]] || fail "a rerun replaced ENCRYPTION_KEY"

# Another program's rakazo stays; the full path stands in for it.
printf '#!/usr/bin/env bash\necho other\n' >"$command_path"
install_piped
expect "Commands: $home_dir/rakazo doctor"
[[ "$("$command_path")" == other ]] || fail "replaced another program's rakazo"

# RAKAZO_DIR picks the folder.
install_piped RAKAZO_DIR="$tmp/elsewhere"
[[ "$status" == 0 && -f "$tmp/elsewhere/.env" ]] || fail "RAKAZO_DIR was not used: $out"

# Without Docker (or OpenSSL): unattended, say what is needed; in a terminal, offer to install it.
for tool in /usr/bin/* /bin/*; do
  [[ "${tool##*/}" =~ ^(docker|openssl)$ || -e "$tools/${tool##*/}" ]] || ln -s "$tool" "$tools/${tool##*/}"
done
for stub in curl sudo; do ln -sf "$bin/$stub" "$tools/$stub"; done
printf '#!/usr/bin/env bash\necho Linux\n' >"$tmp/uname" && chmod +x "$tmp/uname" && ln -sf "$tmp/uname" "$tools/uname"
mkdir -p "$tmp/no-docker"
cp "$root/install-images.sh" "$tmp/no-docker/"
status=0
out="$(cd "$tmp/no-docker" && env HOME="$tmp/home" PATH="$tools" bash install-images.sh 2>&1 </dev/null)" || status=$?
[[ "$status" != 0 ]] || fail "installed without Docker"
expect "Docker is required. See https://docs.docker.com/engine/install/"
if script --version 2>/dev/null | grep -q util-linux; then
  out="$(cd "$tmp/no-docker" && printf 'n\n' | env HOME="$tmp/home" PATH="$tools" \
    script -qec "bash install-images.sh" /dev/null)" || true
  expect "Install it now? [Y/n]"
  expect "Docker is required."
  [[ ! -e "$tools/docker" ]] || fail "installed Docker after a no"
  out="$(cd "$tmp/no-docker" && printf 'y\n' | env HOME="$tmp/home" PATH="$tools" \
    script -qec "bash install-images.sh" /dev/null)" || true
  expect "Installing Docker..."
  expect "Rakazo is starting at http://127.0.0.1:5173"
  [[ -L "$tools/docker" ]] || fail "did not run Docker's install script"
  grep -Eq '^ENCRYPTION_KEY=[0-9a-f]{64}$' "$tmp/no-docker/.env" || fail "no secrets without OpenSSL"
fi

echo "ok"
