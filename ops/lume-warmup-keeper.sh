#!/usr/bin/env bash
# Lume internal-SMTP warm-up keeper (ros, every 30 min).
#  1. Every Mailcow box keeps Smartlead warm-up ACTIVE (a postfix restart on 2026-08-20
#     switched 74/75 off within minutes; nothing else noticed).
#  2. The warm-up ramp after the egress cutover follows the schedule in
#     snap_internal_egress_v1.json (the same one the Senders card shows), ONE rung per
#     run, and a rung is climbed only on clean evidence from the Mailcow standing
#     monitor (snap_internal_egress_status_v1.json, pulled every 15 min):
#        up:   day reached, no block-ledger pair for the internal fleet seen in 3 days,
#              Google acceptance >= 95% on >= 10 attempts, 0 rate-limit deferrals,
#              blocklists clean, egress pin holding, old IP not mentioned.
#        down: Google acceptance < 90% on >= 20 attempts, any blocklist listing, an
#              old-IP mention, a post-cutover block-ledger pair, or the pin gone -> rung 0.
#     Unknown evidence (monitor stale > 2h) holds the current rung; it never climbs blind.
# Owner is emailed only when something changed (rung, new hold reason, re-enabled boxes).
set -uo pipefail
ENV=/opt/recruiteros/.env.production
K=$(grep -E '^SMARTLEAD_API_KEY=' "$ENV" | cut -d= -f2- | tr -d '"\r')
[ -z "$K" ] && { echo "no SMARTLEAD_API_KEY"; exit 0; }
VOL=/var/lib/docker/volumes/recruiteros_app_data/_data
LEDGER=$VOL/snap_provider_blocks_v1.json
EGRESS=$VOL/snap_internal_egress_v1.json
STATUS=$VOL/snap_internal_egress_status_v1.json
MARKER=/var/lib/recruiteros/internal-egress-cutover-at
STATE=/var/lib/recruiteros/warmup-keeper.json
LOG=/var/log/lume-warmup-keeper.log
# What the app reads back to CHECK OFF a warm-up rung on the fleet monitor: only this
# keeper knows what the boxes are actually set to, so the rung is published as evidence
# (host-owned snapshot; the app never writes this key, so there is no hydration risk).
SNAP=$VOL/snap_internal_warmup_v1.json
RESEND_KEY=$(grep -E '^RESEND_API_KEY=' "$ENV" | cut -d= -f2- | tr -d '"\r')
MAIL_FROM=$(grep -E '^EMAIL_FROM=' "$ENV" | cut -d= -f2- | tr -d '"\r')
OWNER_TO=$(grep -E '^OWNER_EMAIL=' "$ENV" | cut -d= -f2- | tr -d '"\r'); OWNER_TO=${OWNER_TO:-neadusall@gmail.com}
export K LEDGER EGRESS STATUS MARKER STATE SNAP LOG RESEND_KEY MAIL_FROM OWNER_TO
DRY=${1:-}

python3 - "$DRY" <<'PY'
import json, os, re, sys, time, urllib.request, datetime as dt
K=os.environ["K"]; DRY = sys.argv[1] == "--dry-run"
UA={"content-type":"application/json","user-agent":"curl/8.5.0 lume-warmup-keeper"}
def utc(): return dt.datetime.now(dt.timezone.utc).replace(tzinfo=None)
def log(m):
    line=f"{utc().isoformat(timespec='seconds')}Z {m}"
    print(line); open(os.environ["LOG"],"a").write(line+"\n")
def api(path, body=None):
    url=f"https://server.smartlead.ai/api/v1{path}{'&' if '?' in path else '?'}api_key={K}"
    req=urllib.request.Request(url, data=json.dumps(body).encode() if body is not None else None, headers=UA, method="POST" if body is not None else "GET")
    with urllib.request.urlopen(req, timeout=40) as r: return json.loads(r.read().decode() or "null")
def load(p):
    try: return json.load(open(p))
    except Exception: return None
def parse(iso):
    try: return dt.datetime.fromisoformat(str(iso).replace("Z",""))
    except Exception: return None
def age_days(iso):
    t=parse(iso); return (utc()-t).total_seconds()/86400 if t else None

now=utc()
egress=load(os.environ["EGRESS"]) or {}
ramp=sorted(egress.get("warmupRamp") or [{"afterDays":0,"perDay":8}], key=lambda r:r["afterDays"])
cut=parse(egress.get("cutoverAt")) or (parse(open(os.environ["MARKER"]).read().strip()) if os.path.exists(os.environ["MARKER"]) else None)
days=(now-cut).total_seconds()/86400 if cut else 0
due_idx=max(i for i,r in enumerate(ramp) if r["afterDays"]<=days)

# --- evidence
reasons_down=[]; reasons_hold=[]
led=load(os.environ["LEDGER"]) or {}
for b in (led.get("blocks") or {}).values():
    if b.get("fleet")!="internal" or not b.get("lastSeen"): continue
    a=age_days(b["lastSeen"])
    if a is not None and a<=3 and (b.get("count") or 0)>=20:
        msg=f"{b.get('provider')} rejections in the ledger ({b.get('count')}, last {a:.1f}d ago)"
        seen=parse(b["lastSeen"])
        (reasons_down if (cut and seen and seen>cut) else reasons_hold).append(msg)
st=load(os.environ["STATUS"])
st_age=age_days(st.get("at")) if st else None
if st and st_age is not None and st_age<=2/24:
    g=st["receivers"]["google"]; att=g["accepted"]+g["rejected"]; acc=g["accepted"]/att if att else None
    listed=[z for z,v in (st.get("dnsbl") or {}).items() if v!="clean"]
    if listed: reasons_down.append("blocklist listing: "+", ".join(listed))
    if st.get("oldIpMentions",0)>0: reasons_down.append(f"old IP named {st['oldIpMentions']}x in the window")
    if st.get("rulePos1") is False or (st.get("egressSeen") and st["egressSeen"]!=st.get("newIp")): reasons_down.append("egress pin not holding")
    if att>=20 and acc is not None and acc<0.90: reasons_down.append(f"Google acceptance {acc*100:.0f}% on {att}")
    if g.get("rateLimited",0)>0: reasons_hold.append(f"{g['rateLimited']} Gmail rate-limit deferrals")
    if att<10: reasons_hold.append(f"only {att} Google attempts in the window (need 10)")
    elif acc is not None and acc<0.95: reasons_hold.append(f"Google acceptance {acc*100:.0f}% (need 95%)")
else:
    reasons_hold.append("standing monitor stale or missing; not climbing blind")
evidence_ok = not reasons_down and not reasons_hold

# --- decide the rung (one step per run)
prev=load(os.environ["STATE"]) or {}
cur_idx=min(int(prev.get("rung", 0)), len(ramp)-1)
if reasons_down: new_idx=0
elif due_idx>cur_idx and evidence_ok: new_idx=cur_idx+1
else: new_idx=cur_idx
target=ramp[new_idx]["perDay"]

# --- census + apply
rows=[]
for off in range(0,2000,100):
    j=api(f"/email-accounts/?offset={off}&limit=100")
    page = j if isinstance(j,list) else (j or {}).get("data",[])
    if not page: break
    rows+=page
pat=re.compile(r"@lume(advisor|exec|placements|recruits|recruity|searchco|searchie|searchpartners|sexecutivesearch|shire|spartners|srecruits|ssearchgroup|ssolutions|talentpartner)\.com$")
internal=[r for r in rows if pat.search(r.get("from_email",""))]
inactive=[r for r in internal if (r.get("warmup_details") or {}).get("status")!="ACTIVE"]
offtarget=[r for r in internal if (r.get("warmup_details") or {}).get("max_email_per_day")!=target]
todo={r["id"]:r for r in inactive+offtarget}
log(f"census: {len(internal)} boxes, {len(inactive)} inactive, {len(offtarget)} not at {target}/day | day {days:.1f}, rung {cur_idx}->{new_idx} (due {due_idx}), down={reasons_down or '-'} hold={reasons_hold or '-'}{' [dry-run]' if DRY else ''}")
done=[]; failed=[]; done_ids=set()
for id_,r in todo.items():
    if DRY: continue
    try:
        res=api(f"/email-accounts/{id_}/warmup", {"warmup_enabled":True,"total_warmup_per_day":target,"daily_rampup":5,"reply_rate_percentage":30})
        ok=bool((res or {}).get("ok"))
        (done if ok else failed).append(r["from_email"])
        if ok: done_ids.add(id_)
        time.sleep(0.4)
    except Exception as e: failed.append(f"{r['from_email']} ({str(e)[:60]})")

# --- state + owner email only on change
state={"rung":new_idx,"target":target,"down":reasons_down,"hold":reasons_hold,"due":due_idx,"lastRun":now.isoformat(timespec="seconds")+"Z","reenabled":len(done),"failed":failed}
holding_late = due_idx>new_idx and not reasons_down
changed = prev.get("rung")!=new_idx or bool(done) or bool(failed) or (bool(prev.get("down"))!=bool(reasons_down)) or (holding_late and prev.get("hold")!=reasons_hold)
if not DRY: json.dump(state, open(os.environ["STATE"],"w"), indent=1)

# --- publish the rung as EVIDENCE for the fleet monitor's living plan.
# The board checks a warm-up step off only when this snapshot proves the boxes are
# actually running at that rung; a stale or missing snapshot leaves the step unchecked
# rather than assuming the calendar was kept. Atomic write; never fatal.
wd=lambda r:(r.get("warmup_details") or {})
at_target={r["id"] for r in internal if wd(r).get("max_email_per_day")==target and wd(r).get("status")=="ACTIVE"}
confirmed=len(at_target|done_ids)
stamp=now.isoformat(timespec="seconds")+"Z"
snap={"at":stamp,"lastRun":stamp,"rung":new_idx,"rungs":len(ramp)-1,"target":target,"due":due_idx,
      "down":reasons_down,"hold":reasons_hold,"boxes":len(internal),"atTarget":confirmed,
      "active":len(internal)-len(inactive)+len(done_ids),"reenabled":len(done),"failed":failed[:10],
      "daysSinceCutover":round(days,2)}
if not DRY:
    try:
        pth=os.environ["SNAP"]; tmp=f"{pth}.tmp{os.getpid()}"
        json.dump(snap, open(tmp,"w"), indent=1); os.replace(tmp,pth); os.chmod(pth,0o644)
    except Exception as e: log(f"snapshot publish failed: {e}")
if done or failed: log(f"applied {target}/day to {len(done)} boxes; failed {len(failed)}: {failed[:5]}")
if changed and not DRY and os.environ.get("RESEND_KEY"):
    what = "stepped DOWN" if new_idx<cur_idx else "stepped up" if new_idx>cur_idx else "holding"
    subj=f"Internal server warm-up {what}: {target}/day per box" + (f", {len(done)} boxes re-enabled" if done else "")
    body=(f"mail.lumesp.com fleet, day {days:.1f} since the egress cutover. Rung {new_idx} of {len(ramp)-1}: {target}/day per box.\n\n"
          + (f"Stepped down because: {'; '.join(reasons_down)}.\n" if reasons_down else "")
          + (f"Holding below schedule because: {'; '.join(reasons_hold)}.\n" if (holding_late and reasons_hold) else "")
          + (f"Re-enabled warm-up on {len(done)} boxes that Smartlead had switched off.\n" if done else "")
          + (f"Could not update: {', '.join(failed[:10])}\n" if failed else "")
          + "\nNothing to do unless a line above says stepped down or could not update.")
    try:
        req=urllib.request.Request("https://api.resend.com/emails", data=json.dumps({"from":os.environ["MAIL_FROM"],"to":[os.environ["OWNER_TO"]],"subject":subj,"text":body}).encode(),
                                   headers={"authorization":f"Bearer {os.environ['RESEND_KEY']}","content-type":"application/json","user-agent":"curl/8.5.0 lume-warmup-keeper"}, method="POST")
        urllib.request.urlopen(req, timeout=20).read(); log("owner emailed: "+subj)
    except Exception as e: log(f"owner email failed: {e}")
PY
