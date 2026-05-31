# RecruiterOS, Go-Live Walkthrough (recruiteros.co on Hetzner)

Follow this top to bottom. It assumes nothing. ~20 minutes of work, then a wait
for DNS. When you finish, https://recruiteros.co is live with HTTPS.

================================================================
PART A, Make sure you have a Hetzner server
================================================================

1. Go to https://console.hetzner.cloud and log in.
2. Pick (or create) a Project. You'll see a "Servers" list.

   IF YOU ALREADY HAVE A SERVER:
   - Click it. Near the top you'll see "Public IP" / "IPv4", e.g. 5.75.123.45.
   - Write that number down. This is YOUR_SERVER_IP everywhere below.
   - Skip to PART B.

   IF YOU DON'T HAVE ONE YET, create it:
   - Click "Add Server".
   - Location: pick the one nearest your users (e.g. Ashburn VA for US).
   - Image: "Ubuntu 24.04".
   - Type: "Shared vCPU" -> CX22 (2 vCPU, 4 GB). Plenty to start.
   - Networking: leave Public IPv4 ON.
   - SSH keys: optional. If you don't add one, Hetzner emails you a root
     password, OR you just use the web Console (PART C, option 1). Either works.
   - Name it "recruiteros".
   - Click "Create & Buy now".
   - When it finishes, open the server and copy its Public IPv4 = YOUR_SERVER_IP.

================================================================
PART B, Point the domain at the server (GoDaddy DNS)
================================================================

1. Go to https://dcc.godaddy.com/control/portfolio (or godaddy.com -> sign in ->
   top-right person icon -> "My Products").
2. Find "recruiteros.co". Click the 3 dots on its row -> "Edit DNS"
   (or click the domain, then "DNS" / "Manage DNS").

3. FIRST, remove anything that hijacks the domain:
   - On the domain's main page, look for "Forwarding" (Domain / Subdomain).
     If there's a forward set up, click the trash/Delete on it. Forwarding
     overrides DNS and causes a blank or wrong page.
   - In the DNS records list, if you see a "Parked" CNAME or A record pointing
     at GoDaddy parking, you'll replace/delete it in the next step.

4. Set the A records. In the DNS records table:

   Record 1 (the apex / root domain):
   - If an A record with Name "@" already exists: click the pencil/Edit on it.
       Type:  A
       Name:  @
       Value: YOUR_SERVER_IP
       TTL:   600 seconds (or 1 Hour, fine)
     Save.
   - If none exists: click "Add" -> Type A, Name @, Value YOUR_SERVER_IP, Save.

   Record 2 (the www subdomain):
   - Click "Add" -> 
       Type:  A
       Name:  www
       Value: YOUR_SERVER_IP
       TTL:   600 seconds
     Save.

5. Delete leftover conflicts:
   - If there is any OTHER A record on "@" or "www" pointing at a different IP,
     delete it (you want exactly one A record each, both pointing to YOUR_SERVER_IP).
   - Leave the NS and SOA records alone. Leave any MX/email records alone.

6. DNS takes 5-30 minutes to propagate. You can check from your PC later:
   PowerShell:  nslookup recruiteros.co
   It should return YOUR_SERVER_IP.

================================================================
PART C, Run the one command on the server
================================================================

You must run this ON THE SERVER, not on your PC. Two ways, pick one:

OPTION 1, Hetzner web console (no SSH setup needed):
   - In console.hetzner.cloud, open your server.
   - Top-right, click the ">_" Console button. A black terminal opens in the
     browser.
   - If it asks to log in, type:  root   then the password Hetzner emailed you
     (or the one you set). Typing a password shows nothing, that's normal; press
     Enter.

OPTION 2, SSH from your Windows PC:
   - Open PowerShell.
   - Type:  ssh root@YOUR_SERVER_IP
   - First time, type "yes" to accept the fingerprint, then the password.

Once you have the server prompt (it looks like  root@recruiteros:~# ), paste:

   curl -fsSL https://raw.githubusercontent.com/neadusall/recruiteros/main/deploy.sh | bash

Then press Enter. (To paste in the Hetzner web console, use the clipboard icon
or Ctrl+Shift+V. In PowerShell SSH, right-click pastes.)

What you'll see (a few minutes the first time):
   ==> Installing Docker
   ==> Configuring firewall ...
   ==> Cloning repo into /opt/recruiteros
   ==> Generating .env.production with fresh secrets
   ==> Building and starting containers ...
   (docker downloads + builds, this is the slow part)
   ==> Done. Containers:
   NAME ... STATUS  (you want app, db, caddy all "running"/"healthy")
   ------------------------------------------------------------
   1) Point DNS ...  A  @  YOUR_SERVER_IP   <- confirms the IP
   ...
   3) Then open:  https://recruiteros.co/login.html

================================================================
PART D, First load + HTTPS
================================================================

1. Wait until "nslookup recruiteros.co" returns YOUR_SERVER_IP (DNS propagated).
2. Open https://recruiteros.co
   - The first hit may take a few seconds while Caddy fetches the HTTPS
     certificate from Let's Encrypt. Refresh once if needed.
   - You should land on the dark RecruiterOS homepage.
3. Create your account at https://recruiteros.co/signup.html with your work
   email. A corporate-domain email provisions an enterprise workspace.

================================================================
TROUBLESHOOTING
================================================================

- Blank/white page: you're on a stale tab or the bare IP before deploy finished.
  Use the full https://recruiteros.co and hard-refresh (Ctrl+Shift+R).
- "Your connection is not private" right after launch: the cert is still being
  issued. Wait 1-2 minutes and refresh. If it persists 10+ min, DNS probably
  isn't pointing at the server yet (recheck nslookup).
- Site doesn't load at all: confirm DNS resolves to YOUR_SERVER_IP, and that the
  server shows all three containers running:  docker compose ps  (run it from
  /opt/recruiteros on the server).
- Need to add API keys later (AI, texting, ATS):
     nano /opt/recruiteros/.env.production      # edit values
     cd /opt/recruiteros && docker compose up -d # apply
- Redeploy after code changes:
     cd /opt/recruiteros && git pull && docker compose up -d --build

================================================================
USEFUL COMMANDS (run on the server, in /opt/recruiteros)
================================================================
   docker compose ps              # are app/db/caddy up?
   docker compose logs -f caddy   # watch HTTPS cert issuance
   docker compose logs -f app     # app logs
   docker compose restart app     # restart the app
   docker compose down            # stop everything
   docker compose up -d --build   # rebuild + start
