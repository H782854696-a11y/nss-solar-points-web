#!/usr/bin/env bash
# Small, dependency-free deployment safety primitives.  They intentionally
# print metadata only; no command here prints data records or credentials.
set -euo pipefail

usage() {
  echo "Usage: $0 {contract|data-floor|rollback-allowed|safe-switch|backup|manifest} ..." >&2
  exit 2
}

contract() {
  local release_dir="$1" contract_file="$1/deploy/release-contract.json"
  [[ -f "$contract_file" ]] || { echo unknown; return 0; }
  node -e '
    const fs = require("fs");
    try {
      const value = JSON.parse(fs.readFileSync(process.argv[1], "utf8")).dataCompatibility;
      process.stdout.write(["daily-deposit-legacy-v0", "daily-deposit-review-v1"].includes(value) ? value : "unknown");
    } catch { process.stdout.write("unknown"); }
  ' "$contract_file"
}

data_floor() {
  local data_dir="$1"
  node -e '
    const fs = require("fs"), path = require("path");
    const dataDir = process.argv[1], file = path.join(dataDir, "dailyDeposits.json");
    try {
      let result = "daily-deposit-legacy-v0";
      const marker = path.join(dataDir, "_storage.json");
      if (fs.existsSync(marker)) {
        const driver = JSON.parse(fs.readFileSync(marker, "utf8")).driver;
        // The deployment guard currently inspects JSON only.  Treat SQLite or
        // a malformed marker as unknown rather than guessing about its rows.
        if (driver && driver !== "json") result = "unknown";
      }
      if (result !== "unknown" && fs.existsSync(file)) {
        const rows = JSON.parse(fs.readFileSync(file, "utf8"));
        if (!Array.isArray(rows)) result = "unknown";
        else {
          const modern = new Set(["pending_review", "rejected", "confirmed"]);
          result = rows.some(row => modern.has(row && row.status))
            ? "daily-deposit-review-v1" : "daily-deposit-legacy-v0";
        }
      }
      process.stdout.write(result);
    } catch { process.stdout.write("unknown"); }
  ' "$data_dir"
}

rollback_allowed() {
  local fallback="$(contract "$1")" floor="$(data_floor "$2")"
  # Unknown metadata and unreadable data always fail closed.
  if [[ "$fallback" == unknown || "$floor" == unknown ]]; then
    echo "refused: compatibility is unknown" >&2
    return 1
  fi
  if [[ "$floor" == daily-deposit-review-v1 && "$fallback" != daily-deposit-review-v1 ]]; then
    echo "refused: fallback cannot read daily-deposit-review-v1 data" >&2
    return 1
  fi
  echo "allowed: fallback=$fallback data=$floor"
}

safe_switch() {
  local link="$1" fallback="$2" data_dir="$3" next_link
  rollback_allowed "$fallback" "$data_dir" || return 1
  next_link="${link}.rollback-next-$$"
  ln -s "$fallback" "$next_link"
  mv -Tf "$next_link" "$link"
}

create_backup() {
  local data_dir="$1" backup_dir="$2" release_id="$3" backup_file checksum
  [[ -d "$data_dir" ]] || { echo "Data directory is absent; refusing an empty backup." >&2; return 1; }
  umask 077
  mkdir -p "$backup_dir"
  backup_file="$backup_dir/nss-solar-v2-data-${release_id}.tar.gz"
  [[ ! -e "$backup_file" ]] || { echo "Backup name already exists; refusing to overwrite it." >&2; return 1; }
  tar -czf "$backup_file" -C "$(dirname "$data_dir")" "$(basename "$data_dir")"
  [[ -s "$backup_file" ]] && tar -tzf "$backup_file" >/dev/null || { echo "Backup validation failed." >&2; return 1; }
  checksum="$(shasum -a 256 "$backup_file" | awk '{print $1}')"
  printf '%s  %s\n' "$checksum" "$(basename "$backup_file")" > "${backup_file}.sha256"
  printf '%s\n%s\n' "$backup_file" "$checksum"
}

write_manifest() {
  local output="$1" release_id="$2" source_sha="$3" deployed_at="$4" compatibility="$5" fallback="$6" backup_file="$7" backup_sha="$8"
  node -e '
    const fs = require("fs");
    const [output, releaseId, sourceSha, deployedAt, compatibility, fallback, backupFile, backupSha] = process.argv.slice(1);
    fs.writeFileSync(output, JSON.stringify({ releaseId, sourceSha, deployedAt, dataCompatibility: compatibility,
      rollbackTarget: fallback || null, backupFile, backupSha }, null, 2) + "\n", { mode: 0o600 });
  ' "$output" "$release_id" "$source_sha" "$deployed_at" "$compatibility" "$fallback" "$backup_file" "$backup_sha"
}

[[ "$#" -ge 1 ]] || usage
command="$1"; shift
case "$command" in
  contract) [[ "$#" == 1 ]] || usage; contract "$1" ;;
  data-floor) [[ "$#" == 1 ]] || usage; data_floor "$1" ;;
  rollback-allowed) [[ "$#" == 2 ]] || usage; rollback_allowed "$1" "$2" ;;
  safe-switch) [[ "$#" == 3 ]] || usage; safe_switch "$1" "$2" "$3" ;;
  backup) [[ "$#" == 3 ]] || usage; create_backup "$1" "$2" "$3" ;;
  manifest) [[ "$#" == 8 ]] || usage; write_manifest "$@" ;;
  *) usage ;;
esac
