"""
Garmin Token Capture - The Garden
~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~

One-time script to capture DI OAuth Bearer tokens from Garmin Connect.
Uses python-garminconnect's mobile SSO flow (same as the Android app).

Once tokens are captured, the Cloudflare Worker handles everything:
  - API calls with Bearer auth
  - Auto-refresh when tokens expire
  - Token storage in R2

Usage:
  pip install garminconnect --upgrade
  python garmin-token-capture.py

Output:
  garmin_tokens.json - contains access_token, refresh_token, token expiry
  
Then set Wrangler secrets:
  wrangler secret put GARMIN_ACCESS_TOKEN
  wrangler secret put GARMIN_REFRESH_TOKEN
"""

import json
import os
import sys
from datetime import datetime

try:
    from garminconnect import Garmin
except ImportError:
    print("ERROR: garminconnect not installed.")
    print("Run: pip install garminconnect --upgrade")
    sys.exit(1)


def prompt_mfa():
    """Callback for MFA code if account has 2FA enabled."""
    return input("Enter MFA code from your authenticator app: ").strip()


def main():
    print("=" * 60)
    print("  Garmin Token Capture - The Garden")
    print("=" * 60)
    print()

    # Check for environment variables first, then prompt
    email = os.environ.get("GARMIN_EMAIL") or input("Garmin email: ").strip()
    password = os.environ.get("GARMIN_PASSWORD") or input("Garmin password: ").strip()

    if not email or not password:
        print("ERROR: Email and password required.")
        sys.exit(1)

    print()
    print(f"Logging in as {email}...")
    print("(If MFA is enabled, you'll be prompted for a code)")
    print()

    try:
        client = Garmin(email, password, prompt_mfa=prompt_mfa)
        client.login()
    except Exception as e:
        print(f"LOGIN FAILED: {e}")
        print()
        print("Possible causes:")
        print("  - Wrong credentials")
        print("  - Garmin changed auth again (check python-garminconnect issues)")
        print("  - Rate limited (wait a few minutes)")
        print("  - MFA required but not handled")
        sys.exit(1)

    print("Login successful!")
    print()

    # Extract tokens from garth (the underlying auth library)
    garth_session = client.garth

    # The DI OAuth tokens
    oauth2 = garth_session.oauth2_token
    oauth1 = garth_session.oauth1_token

    if not oauth2:
        print("ERROR: No DI OAuth2 tokens found.")
        print("The library may have changed its token structure.")
        print("Check ~/.garminconnect/garmin_tokens.json manually.")
        sys.exit(1)

    # Build our token file
    tokens = {
        "captured_at": datetime.utcnow().isoformat() + "Z",
        "email": email,
    }

    # Extract what we can from the oauth2 token object
    if hasattr(oauth2, 'access_token'):
        tokens["access_token"] = oauth2.access_token
    elif isinstance(oauth2, dict):
        tokens["access_token"] = oauth2.get("access_token", "")
    
    if hasattr(oauth2, 'refresh_token'):
        tokens["refresh_token"] = oauth2.refresh_token
    elif isinstance(oauth2, dict):
        tokens["refresh_token"] = oauth2.get("refresh_token", "")

    if hasattr(oauth2, 'expires_at'):
        tokens["expires_at"] = oauth2.expires_at
    elif isinstance(oauth2, dict):
        tokens["expires_at"] = oauth2.get("expires_at", 0)

    if hasattr(oauth2, 'token_type'):
        tokens["token_type"] = oauth2.token_type
    elif isinstance(oauth2, dict):
        tokens["token_type"] = oauth2.get("token_type", "Bearer")

    # Save raw token structure for debugging
    if oauth2:
        if hasattr(oauth2, '__dict__'):
            tokens["_oauth2_raw"] = str(oauth2.__dict__)
        elif isinstance(oauth2, dict):
            tokens["_oauth2_raw"] = oauth2

    # Also check the default token file location
    default_token_dir = os.path.expanduser("~/.garminconnect")
    default_token_file = os.path.join(default_token_dir, "garmin_tokens.json")
    if os.path.exists(default_token_file):
        tokens["_default_token_path"] = default_token_file
        print(f"Note: Tokens also saved by library at {default_token_file}")
        # Read the library's own token file for reference
        try:
            with open(default_token_file, "r") as f:
                lib_tokens = json.load(f)
            tokens["_library_tokens"] = lib_tokens
        except Exception:
            pass

    # Write our token file
    output_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "garmin_tokens.json")
    with open(output_path, "w") as f:
        json.dump(tokens, f, indent=2, default=str)

    print(f"Tokens saved to: {output_path}")
    print()

    # Verify by making a test API call
    print("Verifying with test API call...")
    try:
        full_name = client.get_full_name()
        print(f"  Display name: {full_name}")
    except Exception as e:
        print(f"  Warning: get_full_name failed ({e})")
    
    try:
        user_settings = client.get_user_settings()
        if user_settings:
            print(f"  User settings retrieved successfully")
    except Exception as e:
        print(f"  Warning: get_user_settings failed ({e})")

    print()
    print("=" * 60)
    print("  TOKENS CAPTURED")
    print("=" * 60)
    print()
    
    if tokens.get("access_token"):
        at = tokens["access_token"]
        at_display = at[:30] + "..." if len(at) > 30 else at
        print(f"  Access token:  {at_display}")
    if tokens.get("refresh_token"):
        rt = tokens["refresh_token"]
        rt_display = rt[:30] + "..." if len(rt) > 30 else rt
        print(f"  Refresh token: {rt_display}")
    
    print()
    print("  Next: set Wrangler secrets in the cloud_worker directory:")
    print()
    print("    wrangler secret put GARMIN_ACCESS_TOKEN")
    print("    wrangler secret put GARMIN_REFRESH_TOKEN")
    print()
    print("  Paste the full token values when prompted.")
    print("  The Worker will auto-refresh tokens from here.")
    print("=" * 60)


if __name__ == "__main__":
    main()
