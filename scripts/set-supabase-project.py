#!/usr/bin/env python3
"""
Point Proplync at a Supabase project.
==============================================================================
The project ref lives in three places that must agree, and when they disagree
the failure is silent and confusing: the browser signs in against one project
while the API validates tokens against another, so you get a 401 that looks
like a wrong password.

    1. js/supabase-client.js   URL + anon key, shipped to the browser
    2. .env.local              local `vercel dev`
    3. Vercel env vars         production + preview

This script sets all three from one source of truth.

Usage
--------------------------------------------------------------------------
Grab the values from Supabase Studio -> Project Settings -> API, then:

    export SUPABASE_URL="https://<ref>.supabase.co"
    export SUPABASE_ANON_KEY="eyJ..."
    export SUPABASE_SERVICE_ROLE_KEY="eyJ..."
    python3 scripts/set-supabase-project.py            # local files only
    python3 scripts/set-supabase-project.py --vercel   # also push to Vercel

Keys are read from the environment, never taken as arguments (arguments show
up in shell history and `ps`), and never printed back out.
==============================================================================
"""

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
CLIENT_JS = REPO / "js" / "supabase-client.js"
ENV_LOCAL = REPO / ".env.local"

# Every Vercel var that must carry each value. The NEXT_PUBLIC_* copies exist
# because the Vercel/Supabase integration created them; keeping them in sync
# avoids a stale one being picked up later.
VERCEL_VARS = {
    "SUPABASE_URL": "url",
    "NEXT_PUBLIC_SUPABASE_URL": "url",
    "SUPABASE_ANON_KEY": "anon",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY": "anon",
    "SUPABASE_SERVICE_ROLE_KEY": "service",
}
VERCEL_ENVIRONMENTS = ("production", "preview", "development")


def fail(msg):
    print(f"error: {msg}", file=sys.stderr)
    sys.exit(1)


def redact(value):
    """Show only enough to confirm which key it is."""
    return f"{value[:8]}…{value[-4:]} ({len(value)} chars)" if len(value) > 16 else "<short value>"


def load_inputs():
    url = os.environ.get("SUPABASE_URL", "").strip().rstrip("/")
    anon = os.environ.get("SUPABASE_ANON_KEY", "").strip()
    service = os.environ.get("SUPABASE_SERVICE_ROLE_KEY", "").strip()

    missing = [n for n, v in
               (("SUPABASE_URL", url), ("SUPABASE_ANON_KEY", anon),
                ("SUPABASE_SERVICE_ROLE_KEY", service)) if not v]
    if missing:
        fail("set these environment variables first: " + ", ".join(missing))

    if not re.fullmatch(r"https://[a-z0-9]+\.supabase\.(co|in)", url):
        fail(f"SUPABASE_URL doesn't look like a project URL: {url}")
    if anon == service:
        fail("anon key and service-role key are identical — check which is which in Studio")
    for name, key in (("anon", anon), ("service-role", service)):
        if not key.startswith("eyJ") and not key.startswith("sb_"):
            print(f"warning: {name} key has an unfamiliar prefix; continuing anyway")
    return url, anon, service


def patch_client_js(url, anon):
    """Rewrite the two constants the browser client uses."""
    if not CLIENT_JS.exists():
        fail(f"{CLIENT_JS} not found")
    src = CLIENT_JS.read_text()
    new, n_url = re.subn(r"(const SUPABASE_URL\s*=\s*)'[^']*'", rf"\g<1>'{url}'", src)
    new, n_key = re.subn(r"(const SUPABASE_ANON_KEY\s*=\s*)'[^']*'", rf"\g<1>'{anon}'", new)
    if n_url != 1 or n_key != 1:
        fail(f"expected one SUPABASE_URL and one SUPABASE_ANON_KEY in {CLIENT_JS.name} "
             f"(found {n_url} and {n_key}) — fix by hand")
    CLIENT_JS.write_text(new)
    print(f"  updated {CLIENT_JS.relative_to(REPO)}")


def patch_env_local(values):
    """Set or add each key in .env.local, leaving every other line untouched."""
    lines = ENV_LOCAL.read_text().splitlines() if ENV_LOCAL.exists() else []
    for name, value in values.items():
        quoted = f'{name}="{value}"'
        for i, line in enumerate(lines):
            if line.startswith(f"{name}=") or line.startswith(f"{name} ="):
                lines[i] = quoted
                break
        else:
            lines.append(quoted)
    ENV_LOCAL.write_text("\n".join(lines) + "\n")
    print(f"  updated {ENV_LOCAL.relative_to(REPO)} ({len(values)} keys)")


def push_to_vercel(values):
    """Replace each var in every environment. `vercel env add` reads stdin, so
    the value never appears in argv."""
    for name, value in values.items():
        for env in VERCEL_ENVIRONMENTS:
            subprocess.run(["npx", "--yes", "vercel", "env", "rm", name, env, "--yes"],
                           cwd=REPO, capture_output=True, text=True, timeout=120)
            add = subprocess.run(["npx", "--yes", "vercel", "env", "add", name, env],
                                 cwd=REPO, input=value, capture_output=True, text=True, timeout=120)
            status = "ok" if add.returncode == 0 else "FAILED"
            print(f"  vercel {name} [{env}]: {status}")


def main():
    ap = argparse.ArgumentParser(description="Point Proplync at a Supabase project.")
    ap.add_argument("--vercel", action="store_true", help="also replace the Vercel env vars")
    args = ap.parse_args()

    url, anon, service = load_inputs()
    by_role = {"url": url, "anon": anon, "service": service}

    print("Applying Supabase project:")
    print(f"  url          {url}")
    print(f"  anon key     {redact(anon)}")
    print(f"  service key  {redact(service)}")
    print()

    patch_client_js(url, anon)
    patch_env_local({
        "SUPABASE_URL": url,
        "NEXT_PUBLIC_SUPABASE_URL": url,
        "SUPABASE_ANON_KEY": anon,
        "NEXT_PUBLIC_SUPABASE_ANON_KEY": anon,
        "SUPABASE_SERVICE_ROLE_KEY": service,
    })

    if args.vercel:
        print()
        push_to_vercel({name: by_role[role] for name, role in VERCEL_VARS.items()})
        print("\nRedeploy for the new Vercel values to take effect:  npx vercel --prod")
    else:
        print("\nLocal files only. Re-run with --vercel to update production.")

    print("\nThen verify:  python3 scripts/health-check.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
