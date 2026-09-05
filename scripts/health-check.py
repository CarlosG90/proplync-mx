#!/usr/bin/env python3
"""
Proplync · dependency health check
==============================================================================
Why this exists
--------------------------------------------------------------------------
Four outages happened back to back and not one of them raised an alert:

  * the n8n container exited and stayed down for six days
  * the Supabase project became unreachable (auth + listings dead)
  * Groq decommissioned `llama-3.3-70b-versatile`, 404-ing every AI feature
  * the Underwriting agent silently slowed to 83-100s per call

All four were found by a human poking at the system by hand. This script is
the cheap, deterministic replacement for that poking: plain stdlib Python, no
dependencies, no LLM calls, no tokens burned. Run it on a schedule and the
next outage reaches you before it reaches a customer.

Usage
--------------------------------------------------------------------------
    python3 scripts/health-check.py              # full run, human output
    python3 scripts/health-check.py --quiet      # only print problems (cron)
    python3 scripts/health-check.py --json       # machine-readable
    python3 scripts/health-check.py --no-local   # skip localhost n8n/ollama

Exit status: 0 = everything healthy, 1 = at least one check failed.
So `python3 scripts/health-check.py || notify-me` is a complete alert rule.
==============================================================================
"""

import argparse
import json
import os
import re
import socket
import ssl
import subprocess
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

# --- what we monitor -------------------------------------------------------

SITE = os.environ.get("PROPLYNC_SITE", "https://proplync-mx.vercel.app")
SAMPLE_PROPERTY_ID = "EB-P8830"          # ships in the hardcoded SAMPLES list
N8N_LOCAL = "http://localhost:5678"
OLLAMA_LOCAL = "http://localhost:11434"
N8N_CONTAINER = "n8n_may"
GROQ_MODELS_URL = "https://api.groq.com/openai/v1/models"

REPO_ROOT = Path(__file__).resolve().parent.parent
GROQ_LIB = REPO_ROOT / "api" / "_lib" / "groq.js"
LOG_PATH = Path(os.environ.get("PROPLYNC_HEALTH_LOG", Path.home() / ".proplync" / "health.log"))

TIMEOUT = 20


class Result:
    __slots__ = ("name", "ok", "detail")

    def __init__(self, name, ok, detail=""):
        self.name = name
        self.ok = ok
        self.detail = detail


def http(url, method="GET", body=None, headers=None, timeout=TIMEOUT):
    """Return (status, text). Status 0 means the request never completed."""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("content-type", "application/json")
    # Groq (and other Cloudflare-fronted APIs) 403 the default Python-urllib
    # User-Agent, which would look exactly like an auth failure.
    req.add_header("user-agent", "proplync-health-check/1.0")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")
    except (urllib.error.URLError, socket.timeout, ssl.SSLError, ConnectionError) as e:
        return 0, str(getattr(e, "reason", e))


# --- checks ----------------------------------------------------------------

def check_site():
    status, _ = http(SITE)
    ok = status == 200
    return Result("site", ok, f"{SITE} -> {status or 'unreachable'}")


def check_supabase():
    """Probe Supabase directly. This is the authoritative database check.

    Deliberately not inferred from the app: a missing `degraded` field could
    mean "healthy" or "running a build that predates the flag", and those must
    not look the same to a monitor.
    """
    url = os.environ.get("SUPABASE_URL") or env_from_dotenv("SUPABASE_URL")
    if not url:
        return Result("supabase", False, "SUPABASE_URL not set (checked env and .env.local)")
    key = (os.environ.get("SUPABASE_ANON_KEY") or env_from_dotenv("SUPABASE_ANON_KEY") or "")
    status, text = http(f"{url.rstrip('/')}/auth/v1/health", headers={"apikey": key} if key else None)
    if status == 0:
        # DNS failure is what a paused/deleted project looks like from outside.
        return Result("supabase", False, f"{url} unreachable ({text}) — project paused or deleted?")
    if status >= 500:
        return Result("supabase", False, f"/auth/v1/health -> {status}")
    return Result("supabase", True, f"{url} -> {status}")


def check_listings_api():
    """Catch the app serving fallback content while looking healthy.

    /api/property intentionally degrades to hardcoded samples so buyers still
    see a page; the `degraded` flag (api/_lib/health.js) is how it says so.
    """
    status, text = http(f"{SITE}/api/property?id={SAMPLE_PROPERTY_ID}")
    if status != 200:
        return Result("listings-api", False, f"/api/property -> {status or 'unreachable'}")
    try:
        payload = json.loads(text)
    except ValueError:
        return Result("listings-api", False, "/api/property returned non-JSON")
    if payload.get("degraded"):
        return Result("listings-api", False,
                      "serving fallback data — database unreachable (site looks fine to visitors)")
    if "degraded" not in payload:
        return Result("listings-api", True,
                      "200, but deployed build predates the degraded flag — cannot detect fallback")
    return Result("listings-api", True, "live data")


def pinned_models():
    """Read both models out of the source so the check can't drift from them."""
    try:
        src = GROQ_LIB.read_text()
    except OSError:
        return {}
    out = {}
    for label, const in (("primary", "PRIMARY_MODEL"), ("fallback", "FALLBACK_MODEL")):
        m = re.search(rf"{const}\s*=\s*['\"]([^'\"]+)['\"]", src)
        if m:
            out[label] = m.group(1)
    return out


def env_from_dotenv(name):
    """Read one var out of .env.local (never printed, only used for auth)."""
    try:
        for line in (REPO_ROOT / ".env.local").read_text().splitlines():
            if line.startswith(f"{name}="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return None


def check_ai_model():
    """The check that would have caught `llama-3.3-70b-versatile` disappearing.

    Lists models instead of generating: no tokens spent, no rate limit risk.
    """
    models = pinned_models()
    if not models.get("primary"):
        return Result("ai-model", False, f"could not read PRIMARY_MODEL from {GROQ_LIB.name}")
    key = os.environ.get("GROQ_API_KEY") or env_from_dotenv("GROQ_API_KEY")
    if not key:
        return Result("ai-model", False, "GROQ_API_KEY not set (checked env and .env.local)")
    status, text = http(GROQ_MODELS_URL, headers={"Authorization": f"Bearer {key}"})
    if status != 200:
        return Result("ai-model", False, f"Groq /models -> {status or 'unreachable'}")
    try:
        available = {m["id"] for m in json.loads(text).get("data", [])}
    except (ValueError, KeyError, TypeError):
        return Result("ai-model", False, "Groq /models returned unexpected JSON")

    missing = [f"{label}='{name}'" for label, name in models.items() if name not in available]
    if any(label == "primary" for label, name in models.items() if name not in available):
        return Result("ai-model", False,
                      f"{', '.join(missing)} no longer offered by Groq — AI features fall back or 404")
    if missing:
        # Primary still works, but the safety net is gone: fix before it matters.
        return Result("ai-model", False, f"{', '.join(missing)} retired — fallback model needs replacing")
    return Result("ai-model", True, " + ".join(f"{k}:{v}" for k, v in models.items()) + " available")


def check_n8n():
    status, _ = http(f"{N8N_LOCAL}/healthz", timeout=5)
    ok = status == 200
    return Result("n8n", ok, f"{N8N_LOCAL} -> {status or 'unreachable'}")


def check_n8n_restart_policy():
    """The container went down and stayed down because nothing restarted it."""
    try:
        out = subprocess.run(
            ["podman", "inspect", N8N_CONTAINER, "--format",
             "{{.State.Status}} {{.HostConfig.RestartPolicy.Name}}"],
            capture_output=True, text=True, timeout=15,
        )
    except (OSError, subprocess.SubprocessError) as e:
        return Result("n8n-container", False, f"podman unavailable: {e}")
    if out.returncode != 0:
        return Result("n8n-container", False, f"container '{N8N_CONTAINER}' not found")
    parts = out.stdout.split()
    state = parts[0] if parts else "unknown"
    policy = parts[1] if len(parts) > 1 else "no"
    if state != "running":
        return Result("n8n-container", False, f"state={state} (restart policy: {policy})")
    if policy in ("", "no"):
        return Result("n8n-container", False,
                      "running, but no restart policy — it will not come back after a reboot")
    return Result("n8n-container", True, f"running, restart={policy}")


def check_ollama():
    status, _ = http(f"{OLLAMA_LOCAL}/api/tags", timeout=5)
    ok = status == 200
    return Result("ollama", ok, f"{OLLAMA_LOCAL} -> {status or 'unreachable'} (agent fallback path)")


# --- runner ----------------------------------------------------------------

def log(results):
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    try:
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        with LOG_PATH.open("a") as fh:
            for r in results:
                fh.write(f"{stamp} {'OK  ' if r.ok else 'FAIL'} {r.name}: {r.detail}\n")
    except OSError:
        pass  # never let logging fail the check


def notify(failed):
    """Best-effort desktop alert so a failure is seen, not just written down."""
    if sys.platform != "darwin" or not failed:
        return
    names = ", ".join(r.name for r in failed)
    msg = f"Proplync health: {len(failed)} failing ({names})"
    try:
        subprocess.run(
            ["osascript", "-e",
             f'display notification {json.dumps(msg)} with title "Proplync health check"'],
            capture_output=True, timeout=10,
        )
    except (OSError, subprocess.SubprocessError):
        pass


def main():
    ap = argparse.ArgumentParser(description="Check every Proplync dependency.")
    ap.add_argument("--quiet", action="store_true", help="print only failures")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    ap.add_argument("--no-local", action="store_true", help="skip localhost-only checks")
    ap.add_argument("--no-notify", action="store_true", help="suppress the macOS notification")
    args = ap.parse_args()

    checks = [check_site, check_supabase, check_listings_api, check_ai_model]
    if not args.no_local:
        checks += [check_n8n, check_n8n_restart_policy, check_ollama]

    results = [c() for c in checks]
    failed = [r for r in results if not r.ok]
    log(results)
    if not args.no_notify:
        notify(failed)

    if args.json:
        print(json.dumps({
            "checked_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "healthy": not failed,
            "checks": [{"name": r.name, "ok": r.ok, "detail": r.detail} for r in results],
        }, indent=2))
    else:
        for r in results:
            if args.quiet and r.ok:
                continue
            print(f"{'  ok  ' if r.ok else ' FAIL '} {r.name:<15} {r.detail}")
        if failed and not args.quiet:
            print(f"\n{len(failed)} of {len(results)} checks failing.")
        elif not failed and not args.quiet:
            print(f"\nAll {len(results)} checks healthy.")

    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
