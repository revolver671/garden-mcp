"""
Garmin Browser Auth - The Garden
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

Uses Playwright to open a real browser for Garmin SSO login.
Bypasses the 429/403 Cloudflare blocks that kill programmatic login.

The browser opens, auto-fills your credentials, you click Sign In
(and handle MFA if needed), and the script captures the SSO ticket
then exchanges it for OAuth1 -> OAuth2 tokens.

Prerequisites:
  pip install playwright requests-oauthlib
  python -m playwright install chromium

Usage:
  python scripts/garmin-browser-auth.py
"""

import json
import os
import re
import sys
import time
from pathlib import Path
from urllib.parse import parse_qs

try:
    import requests
    from requests_oauthlib import OAuth1Session
    from playwright.sync_api import sync_playwright
except ImportError as e:
    print(f"Missing dependency: {e}")
    print()
    print("Install requirements:")
    print("  pip install playwright requests-oauthlib")
    print("  python -m playwright install chromium")
    sys.exit(1)


OAUTH_CONSUMER_URL = "https://thegarth.s3.amazonaws.com/oauth_consumer.json"
ANDROID_UA = "com.garmin.android.apps.connectmobile"


def get_oauth_consumer():
    resp = requests.get(OAUTH_CONSUMER_URL, timeout=10)
    resp.raise_for_status()
    return resp.json()


def get_oauth1_token(ticket, consumer):
    sess = OAuth1Session(consumer["consumer_key"], consumer["consumer_secret"])
    url = (
        f"https://connectapi.garmin.com/oauth-service/oauth/"
        f"preauthorized?ticket={ticket}"
        f"&login-url=https://sso.garmin.com/sso/embed"
        f"&accepts-mfa-tokens=true"
    )
    resp = sess.get(url, headers={"User-Agent": ANDROID_UA}, timeout=15)
    resp.raise_for_status()
    parsed = parse_qs(resp.text)
    token = {k: v[0] for k, v in parsed.items()}
    token["domain"] = "garmin.com"
    return token


def exchange_oauth2(oauth1, consumer):
    sess = OAuth1Session(
        consumer["consumer_key"],
        consumer["consumer_secret"],
        resource_owner_key=oauth1["oauth_token"],
        resource_owner_secret=oauth1["oauth_token_secret"],
    )
    url = "https://connectapi.garmin.com/oauth-service/oauth/exchange/user/2.0"
    data = {}
    if oauth1.get("mfa_token"):
        data["mfa_token"] = oauth1["mfa_token"]
    resp = sess.post(
        url,
        headers={
            "User-Agent": ANDROID_UA,
            "Content-Type": "application/x-www-form-urlencoded",
        },
        data=data,
        timeout=15,
    )
    resp.raise_for_status()
    token = resp.json()
    token["expires_at"] = int(time.time() + token["expires_in"])
    token["refresh_token_expires_at"] = int(
        time.time() + token["refresh_token_expires_in"]
    )
    return token


def browser_login(email, password):
    ticket = None

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)
        context = browser.new_context()
        page = context.new_page()

        sso_url = (
            "https://sso.garmin.com/sso/embed"
            "?id=gauth-widget"
            "&embedWidget=true"
            "&gauthHost=https://sso.garmin.com/sso"
            "&clientId=GarminConnect"
            "&locale=en_US"
            "&redirectAfterAccountLoginUrl=https://sso.garmin.com/sso/embed"
            "&service=https://sso.garmin.com/sso/embed"
        )
        page.goto(sso_url)

        try:
            page.wait_for_selector('input[name="email"], #username, input[type="email"]', timeout=15000)
            page.get_by_label('Email').fill(email)
            page.get_by_label('Password').fill(password)
            print("  Credentials auto-filled!")
        except Exception as e:
            print(f"  Could not auto-fill: {e}")

        print()
        print("=" * 60)
        print("  Browser opened with Garmin login page.")
        print("  Click 'Sign In' (and enter MFA if prompted).")
        print("  The window closes automatically when done.")
        print("=" * 60)
        print()

        max_wait = 300
        start = time.time()
        while time.time() - start < max_wait:
            try:
                content = page.content()
                m = re.search(r'ticket=(ST-[A-Za-z0-9\-]+)', content)
                if m:
                    ticket = m.group(1)
                    print(f"  Got ticket: {ticket[:30]}...")
                    break

                url = page.url
                if "ticket=" in url:
                    m = re.search(r'ticket=(ST-[A-Za-z0-9\-]+)', url)
                    if m:
                        ticket = m.group(1)
                        print(f"  Got ticket from URL: {ticket[:30]}...")
                        break
            except Exception:
                pass

            page.wait_for_timeout(500)

        browser.close()

    if not ticket:
        print("ERROR: Timed out waiting for login (5 min).")
        raise SystemExit(1)

    return ticket


def main():
    print("=" * 60)
    print("  Garmin Browser Auth - The Garden")
    print("=" * 60)
    print()

    email = os.environ.get("GARMIN_EMAIL") or input("Garmin email: ").strip()
    password = os.environ.get("GARMIN_PASSWORD") or input("Garmin password: ").strip()

    print("Fetching OAuth consumer credentials...")
    consumer = get_oauth_consumer()
    print(f"  Got consumer key: {consumer.get('consumer_key', '?')[:15]}...")

    print("Launching browser...")
    ticket = browser_login(email, password)

    print("Exchanging ticket for OAuth1 token...")
    oauth1 = get_oauth1_token(ticket, consumer)
    print(f"  OAuth1 token: {oauth1['oauth_token'][:20]}...")

    print("Exchanging OAuth1 for OAuth2 Bearer token...")
    oauth2 = exchange_oauth2(oauth1, consumer)
    print(f"  Access token: {oauth2['access_token'][:30]}...")
    print(f"  Expires in: {oauth2['expires_in']}s (~{oauth2['expires_in'] // 3600}h)")
    print(f"  Refresh expires in: {oauth2['refresh_token_expires_in']}s (~{oauth2['refresh_token_expires_in'] // 86400}d)")

    print("Verifying tokens with API call...")
    try:
        verify_resp = requests.get(
            "https://connectapi.garmin.com/userprofile-service/socialProfile",
            headers={
                "User-Agent": "GCM-iOS-5.7.2.1",
                "Authorization": f"Bearer {oauth2['access_token']}",
            },
            timeout=15,
        )
        verify_resp.raise_for_status()
        profile = verify_resp.json()
        print(f"  Authenticated as: {profile.get('displayName', 'unknown')}")
    except Exception as e:
        print(f"  Verification failed ({e}), but tokens may still work")

    output = {
        "captured_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "email": email,
        "access_token": oauth2["access_token"],
        "refresh_token": oauth2["refresh_token"],
        "expires_at": oauth2["expires_at"],
        "expires_in": oauth2["expires_in"],
        "refresh_token_expires_at": oauth2["refresh_token_expires_at"],
        "refresh_token_expires_in": oauth2["refresh_token_expires_in"],
        "token_type": oauth2.get("token_type", "Bearer"),
        "oauth1_token": oauth1["oauth_token"],
        "oauth1_token_secret": oauth1["oauth_token_secret"],
        "consumer_key": consumer["consumer_key"],
        "consumer_secret": consumer["consumer_secret"],
    }

    output_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "garmin_tokens.json")
    with open(output_path, "w") as f:
        json.dump(output, f, indent=2)

    garth_dir = Path.home() / ".garminconnect"
    garth_dir.mkdir(exist_ok=True)
    (garth_dir / "oauth1_token.json").write_text(json.dumps(oauth1, indent=2))
    (garth_dir / "oauth2_token.json").write_text(json.dumps(oauth2, indent=2))

    print()
    print("=" * 60)
    print("  TOKENS CAPTURED SUCCESSFULLY")
    print("=" * 60)
    print()
    print(f"  Saved to: {output_path}")
    print()
    print("  Next steps - set Wrangler secrets:")
    print()
    print("    wrangler secret put GARMIN_ACCESS_TOKEN")
    print(f"      paste: {oauth2['access_token'][:40]}...")
    print()
    print("    wrangler secret put GARMIN_REFRESH_TOKEN")
    print(f"      paste: {oauth2['refresh_token'][:40]}...")
    print()
    print("    Then: wrangler deploy")
    print("=" * 60)


if __name__ == "__main__":
    main()
