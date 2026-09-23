#!/bin/sh
umask 077
data_uid="$(id -u)"

data_error() {
  echo "copilot-api: data directory or managed state has unsafe ownership or mode for container UID $data_uid (directories 0700, files 0600). Fix bind-mount ownership/permissions for this UID, or use a named volume." >&2
  exit 1
}

option_error() {
  echo "copilot-api: pass each global option once and provide a non-empty --api-home path." >&2
  exit 2
}

owned_by_runtime_user() {
  [ "$(stat -c %u "$1" 2>/dev/null)" = "$data_uid" ]
}

has_private_mode() {
  file_mode="$(stat -c %a "$1" 2>/dev/null)" || return 1
  [ "$file_mode" = "$2" ] || [ "$file_mode" = "0$2" ]
}

check_existing_directory() {
  [ -e "$1" ] || [ -L "$1" ] || return 0
  [ ! -L "$1" ] && [ -d "$1" ] && [ -r "$1" ] && [ -w "$1" ] && [ -x "$1" ] && owned_by_runtime_user "$1" && has_private_mode "$1" 700 || return 1
}

check_managed_file() {
  [ -e "$1" ] || [ -L "$1" ] || return 0
  [ ! -L "$1" ] && [ -f "$1" ] && [ -r "$1" ] && [ -w "$1" ] && owned_by_runtime_user "$1" && has_private_mode "$1" 600
}

check_managed_backups() {
  for file in "$1" "$1.bak" "$1.backup"; do
    check_managed_file "$file" || return 1
  done
}

data_dir="${COPILOT_API_HOME:-$HOME/.local/share/copilot-api}"
auth_app="${COPILOT_API_OAUTH_APP:-}"
enterprise_url="${COPILOT_API_ENTERPRISE_URL:-}"
seen_home=0
seen_oauth=0
seen_enterprise=0
pending=
root_options=1
explicit_command=0
legacy_auth=0

if [ "$1" = "--auth" ]; then
  shift
  legacy_auth=1
fi

for arg do
  if [ -n "$pending" ]; then
    case "$arg" in
      ""|-*) option_error ;;
    esac
    case "$pending" in
      home) data_dir="$arg" ;;
      oauth) auth_app="$arg" ;;
      enterprise) enterprise_url="$arg" ;;
    esac
    pending=
    continue
  fi
  case "$arg" in
    --) break ;;
    --api-home=*)
      [ "$seen_home" -eq 0 ] || option_error
      seen_home=1
      data_dir="${arg#*=}"
      [ -n "$data_dir" ] || option_error
      ;;
    --api-home)
      [ "$seen_home" -eq 0 ] || option_error
      seen_home=1
      pending=home
      ;;
    --oauth-app=*)
      [ "$seen_oauth" -eq 0 ] || option_error
      seen_oauth=1
      auth_app="${arg#*=}"
      ;;
    --oauth-app)
      [ "$seen_oauth" -eq 0 ] || option_error
      seen_oauth=1
      pending=oauth
      ;;
    --enterprise-url=*)
      [ "$seen_enterprise" -eq 0 ] || option_error
      seen_enterprise=1
      enterprise_url="${arg#*=}"
      ;;
    --enterprise-url)
      [ "$seen_enterprise" -eq 0 ] || option_error
      seen_enterprise=1
      pending=enterprise
      ;;
    start|auth)
      if [ "$root_options" -eq 1 ]; then
        explicit_command=1
      fi
      root_options=0
      ;;
    *) root_options=0 ;;
  esac
done
[ -z "$pending" ] || option_error

if [ ! -d "$data_dir" ]; then
  mkdir -p "$data_dir" 2>/dev/null || data_error
fi
check_existing_directory "$data_dir" || data_error

auth_dir="$data_dir"
if [ -n "$auth_app" ]; then
  auth_dir="$data_dir/$auth_app"
  check_existing_directory "$auth_dir" || data_error
fi
token_prefix=
if [ -n "$enterprise_url" ]; then
  token_prefix=ent_
fi
check_managed_backups "$auth_dir/${token_prefix}github_token" || data_error

catalog_path="${COPILOT_API_CODEX_MODEL_CATALOG_PATH:-$data_dir/codex-model-catalog.json}"
desktop_settings_path="${COPILOT_API_DESKTOP_SETTINGS_PATH:-$HOME/.local/share/copilot-api/desktop-config.json}"
db_path="${COPILOT_API_SQLITE_DB_PATH:-$data_dir/copilot-api.sqlite}"
for managed_path in "$data_dir/config.json" "$data_dir/codex_credentials.json" \
  "$catalog_path" "$data_dir/reasoning-recovery-cache.json" "$desktop_settings_path"; do
  check_managed_backups "$managed_path" || data_error
done
if [ "$db_path" != ":memory:" ]; then
  for managed_path in "$db_path" "$db_path-wal" "$db_path-shm"; do
    check_managed_backups "$managed_path" || data_error
  done
fi

if [ "$legacy_auth" -eq 1 ]; then
  exec bun --use-system-ca run dist/main.js auth "$@"
elif [ "$explicit_command" -eq 1 ]; then
  exec bun --use-system-ca run dist/main.js "$@"
else
  exec bun --use-system-ca run dist/main.js start "$@"
fi
