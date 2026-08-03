#!/usr/bin/env python3
"""
Checks `pnpm audit --json` output against `.github/audit-allowlist.txt`,
failing only on advisories that aren't explicitly allowlisted.

`pnpm audit` (via npm's advisory API) has produced more than one JSON shape
across versions - an older `{"advisories": {"<id>": {...}}}` map, and a
newer `{"vulnerabilities": {"<package>": {"via": [...]}}}` shape where `via`
entries are either a plain dependency-chain string or an advisory object
with a `url`/`source`/`name` field. This parses defensively against both,
since the exact shape hasn't been verified against this repo's real `pnpm
audit` output (no Node/pnpm runtime was available when this was written -
see the PR this shipped in). If this script silently finds zero advisories
on a real run where `pnpm audit` itself exited non-zero, that's a sign the
shape assumptions below are wrong for the installed pnpm version - treat
that as a bug in this script, not a clean bill of health.

Usage: check-audit-allowlist.py <audit.json> <allowlist.txt>
"""
import json
import re
import sys


def load_allowlist(path: str) -> set[str]:
    ids: set[str] = set()
    try:
        with open(path, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.split("#", 1)[0].strip()
                if line:
                    ids.add(line)
    except FileNotFoundError:
        pass
    return ids


# `pnpm audit --audit-level=high` gates its own EXIT CODE on severity, but the
# JSON report it writes still contains every advisory including low/moderate.
# Filtering here is what makes this gate actually mean "HIGH/CRITICAL", rather
# than failing on any advisory at all.
BLOCKING_SEVERITIES = {"high", "critical"}


def _blocking(entry: object) -> bool:
    if not isinstance(entry, dict):
        return False
    return str(entry.get("severity", "")).lower() in BLOCKING_SEVERITIES


def extract_advisory_ids(data: dict) -> set[str]:
    ids: set[str] = set()

    # Older shape: {"advisories": {"<numeric-id>": {"url": "...", "github_advisory_id": "GHSA-..."}}}
    for advisory_id, advisory in (data.get("advisories") or {}).items():
        if not _blocking(advisory):
            continue
        ids.add(str(advisory_id))
        if isinstance(advisory, dict):
            ghsa = advisory.get("github_advisory_id") or advisory.get("url")
            if ghsa:
                match = re.search(r"GHSA-[a-z0-9-]+", str(ghsa))
                if match:
                    ids.add(match.group(0))

    # Newer shape: {"vulnerabilities": {"<package>": {"via": [ ... ]}}}
    for _pkg, vuln in (data.get("vulnerabilities") or {}).items():
        if not isinstance(vuln, dict):
            continue
        if not _blocking(vuln):
            continue
        for via in vuln.get("via", []):
            if isinstance(via, str):
                match = re.search(r"GHSA-[a-z0-9-]+", via)
                if match:
                    ids.add(match.group(0))
            elif isinstance(via, dict):
                for key in ("url", "source", "name"):
                    value = via.get(key)
                    if not value:
                        continue
                    match = re.search(r"GHSA-[a-z0-9-]+", str(value))
                    if match:
                        ids.add(match.group(0))
                    elif isinstance(value, (int, str)) and str(value).strip():
                        ids.add(str(value))

    return ids


def main() -> int:
    if len(sys.argv) != 3:
        print("Usage: check-audit-allowlist.py <audit.json> <allowlist.txt>", file=sys.stderr)
        return 2

    audit_path, allowlist_path = sys.argv[1], sys.argv[2]

    try:
        with open(audit_path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
    except (FileNotFoundError, json.JSONDecodeError) as err:
        print(f"Could not read/parse {audit_path}: {err}", file=sys.stderr)
        return 2

    found = extract_advisory_ids(data)
    allowlisted = load_allowlist(allowlist_path)

    if not found:
        print("pnpm audit: no HIGH/CRITICAL advisories detected in the report.")
        return 0

    unallowed = found - allowlisted
    already_allowed = found & allowlisted

    if already_allowed:
        print(f"Allowlisted (see {allowlist_path}): {sorted(already_allowed)}")

    if unallowed:
        print(f"UNALLOWLISTED advisories found: {sorted(unallowed)}", file=sys.stderr)
        print(
            f"Add each to {allowlist_path} (one per line, with a comment explaining "
            "why it's accepted) only after a deliberate risk decision - do not add an "
            "entry just to make CI pass.",
            file=sys.stderr,
        )
        return 1

    print("All found advisories are explicitly allowlisted.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
