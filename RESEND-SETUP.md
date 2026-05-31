# Resend email setup, step by step (password reset, magic links)

Goal: make RecruiterOS actually send emails (password reset, magic sign-in,
verification) from your own domain recruitersos.co.

There are 4 parts:
  A. Create a Resend account + API key
  B. Verify recruitersos.co in Resend (add DNS records in GoDaddy)
  C. Put the key on your Hetzner server and redeploy
  D. Test it

You can do Part D's test the moment Part A + C are done (using a sandbox
sender), and switch to your domain sender once Part B verifies.

================================================================
PART A, Create the Resend account + API key
================================================================
1. Go to https://resend.com and click Sign Up (free; "Sign up with Google" is
   fine, or email + password).
2. Verify your own email if it asks.
3. In the left sidebar, click "API Keys".
4. Click "Create API Key".
   - Name: recruitersos
   - Permission: "Full access" (default) is fine.
   - Domain: leave "All domains".
5. Click "Add". It shows the key ONCE, starting with  re_...
6. Click the copy icon. Paste it into Notepad for a minute.
   KEEP IT PRIVATE, do NOT paste it into chat or commit it to GitHub.

================================================================
PART B, Verify recruitersos.co (so email comes from your domain)
================================================================
1. In Resend left sidebar, click "Domains" -> "Add Domain".
2. Type:  recruitersos.co   (Region: pick "US East" / default), click Add.
3. Resend now shows a table of DNS records to add. There are usually 3 to 4:
     - 1 x MX     (host like "send")
     - 1 x TXT    SPF   (host like "send", value "v=spf1 include:amazonses.com ~all")
     - 1 x TXT    DKIM  (host like "resend._domainkey", a long "p=..." value)
     - sometimes 1 x TXT DMARC (host "_dmarc")
   Leave this Resend tab OPEN. You'll copy each value.

4. In a NEW tab, open GoDaddy:
     godaddy.com -> sign in -> top-right person icon -> "My Products"
     -> find recruitersos.co -> click "DNS" (or the 3 dots -> "Edit DNS").

5. For EACH record Resend lists, in GoDaddy click "Add New Record" and copy it:

   THE KEY GOTCHA, the "Name"/"Host" field:
   Resend shows the FULL host (e.g. "send.recruitersos.co"). GoDaddy wants only
   the PREFIX, drop ".recruitersos.co":
     Resend "send.recruitersos.co"            -> GoDaddy Name:  send
     Resend "resend._domainkey.recruitersos.co" -> GoDaddy Name: resend._domainkey
     Resend "_dmarc.recruitersos.co"          -> GoDaddy Name:  _dmarc
     If Resend shows just "@" or the bare domain -> GoDaddy Name: @

   a) The MX record:
      - Type: MX
      - Name: send   (the prefix Resend shows)
      - Value: the server Resend shows (e.g. feedback-smtp.us-east-1.amazonses.com)
      - Priority: 10  (Resend tells you; usually 10)
      - TTL: 1 Hour (default fine)
      - Save.

   b) The SPF TXT record:
      - Type: TXT
      - Name: send
      - Value: v=spf1 include:amazonses.com ~all   (copy exactly from Resend)
      - TTL: 1 Hour. Save.

   c) The DKIM TXT record:
      - Type: TXT
      - Name: resend._domainkey   (exactly as Resend's prefix)
      - Value: the whole long "p=MIGf..." string (copy the ENTIRE value)
      - TTL: 1 Hour. Save.

   d) DMARC (only if Resend lists one):
      - Type: TXT, Name: _dmarc, Value: the v=DMARC1... string Resend gives.
      - NOTE: you may already have a _dmarc TXT (from earlier). If so, EDIT the
        existing one to Resend's value rather than adding a duplicate.

6. Back in the Resend "Domains" tab, click "Verify" (or just wait, it
   auto-checks). Status turns green "Verified" in ~5 to 30 minutes (DNS lag).
   You do NOT have to wait for this to test, see Part D.

================================================================
PART C, Put the key on the server + redeploy
================================================================
1. Open Windows PowerShell. Connect to the server:
       ssh root@178.156.170.244
   (enter your root password; nothing shows as you type, that's normal)

2. Go to the app folder and pull the latest code:
       cd /opt/recruiteros
       git pull

3. Open the production env file in the nano editor:
       nano .env.production

4. Find these two lines (they already exist, currently blank). Set them:
       RESEND_API_KEY=re_paste_your_key_here
       EMAIL_FROM=RecruiterOS <no-reply@recruitersos.co>

   - If your domain is NOT verified yet (Part B still pending) and you want to
     test NOW, temporarily use the sandbox sender instead:
       EMAIL_FROM=RecruiterOS <onboarding@resend.dev>
     (Sandbox can only email YOUR OWN Resend account address. Switch to the
      no-reply@recruitersos.co line once the domain shows Verified.)

5. Save and exit nano:
       Ctrl + O   (then Enter)   = save
       Ctrl + X                  = exit

6. Apply it (rebuild + restart):
       docker compose up -d --build

   Wait for it to finish (a couple minutes).

================================================================
PART D, Test it
================================================================
1. Go to:  https://recruitersos.co/forgot-password
2. Enter the email of a real account (for the first test, use the email you
   signed up to Resend with, especially if still on the sandbox sender).
3. Submit. Within a minute you should get a "Reset your RecruiterOS password"
   email. Click the link -> it opens /reset-password -> set a new password.

If no email arrives, check the server logs:
       cd /opt/recruiteros
       docker compose logs --tail 50 app | grep -i email
   - "[email] Resend failed 401" -> wrong/expired API key.
   - "[email] Resend failed 403 ... domain not verified" -> finish Part B, or
     use the onboarding@resend.dev sender for now.
   - "[email] (no RESEND_API_KEY ...)" -> the key didn't save; redo Part C.

================================================================
NOTES
================================================================
- The key lives ONLY in /opt/recruiteros/.env.production on the server. It is
  gitignored, never committed, never shown to anyone.
- Free Resend tier: 3,000 emails/month, 100/day. Plenty for auth emails.
- This same setup powers magic-link sign-in and email verification, not just
  password resets.
