# "Sign in with LinkedIn" setup

Lets users sign up / log in with their LinkedIn account. Their name, email, and
photo are captured automatically, and their LinkedIn identity is stored on their
workspace so the Alfred outreach extension links to the same account.

IMPORTANT (honest note): LinkedIn OAuth only shares IDENTITY (name/email/photo).
It does NOT grant permission to send connection requests or messages on the
user's behalf, LinkedIn has no API for that. Actual LinkedIn outreach is done by
the Alfred browser extension, which acts inside the user's own logged-in tab.
This OAuth is purely for sign-in + linking the identity.

================================================================
STEP 1, Create a LinkedIn app (free, ~5 min)
================================================================
1. Go to https://www.linkedin.com/developers/apps and click "Create app".
2. Fill in:
   - App name: RecruitersOS
   - LinkedIn Page: attach any company page you control (required; make a free
     one if needed).
   - Logo: upload anything.
   - Check the legal box, Create app.
3. Open your new app -> "Products" tab.
4. Find "Sign In with LinkedIn using OpenID Connect" and click "Request access".
   It's usually granted instantly.

================================================================
STEP 2, Set the redirect URL
================================================================
1. In the app -> "Auth" tab.
2. Under "OAuth 2.0 settings" -> "Authorized redirect URLs for your app",
   add EXACTLY:
       https://recruitersos.co/api/auth/linkedin/callback
   Save.
3. On the same Auth tab, copy:
       Client ID
       Client Secret  (click "Show")
   Keep the secret private.

================================================================
STEP 3, Put the keys on the server
================================================================
SSH in and add them to .env.production:
       ssh root@178.156.170.244
       cd /opt/recruiteros
       echo 'LINKEDIN_CLIENT_ID=PASTE_CLIENT_ID' >> .env.production
       echo 'LINKEDIN_CLIENT_SECRET=PASTE_CLIENT_SECRET' >> .env.production
       docker compose up -d --force-recreate app

================================================================
STEP 4, Test
================================================================
1. Go to https://recruitersos.co/login
2. Click "Continue with LinkedIn".
3. Approve on LinkedIn -> you land in /command, signed in, with your LinkedIn
   name/photo on your account.

If the button says "LinkedIn sign-in isn't set up yet", the keys aren't loaded,
re-check STEP 3 (and that you ran --force-recreate).

Scopes used: openid profile email  (no write access; identity only).
