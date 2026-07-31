# JD Sourcing stop codes

When a JD Sourcing run ends without putting people on the screen, the tab shows a
persistent panel with a plain-English reason and a short code. The panel stays until the
recruiter starts another run, so it survives the progress bar disappearing.

**The recruiter's job is to read you the code.** The code says exactly what to go look at.
The recruiter never sees an engine name, an API key, a query or a vendor: that split is
deliberate, keep it.

## Why this exists

A run that finished, showed nothing, and explained nothing was the single worst failure
this tool had. The recruiter could not tell "nobody matches that profile" apart from "the
platform is broken", so it reached the engineer as "it went blank", with nothing to act
on. Every empty or stopped run now carries one of these codes.

## The codes

| Code | What the recruiter sees | What it actually means | Where to fix it |
|---|---|---|---|
| `SRC-CREDITS` | The wide web search stopped early: out of credit or key refused | The wide search pass gave up mid-run: the account is out of credit, or the key was rejected. This is the backbone source, so the run collapses without it. | Top up or replace the wide-search key for that workspace. Keys are **per workspace**, in `snap_integration_credentials_v1.json` under `<ws>/integrations/jd_sourcing/keys`, not env. |
| `SRC-NOKEY` | The wide web search is not switched on for this workspace | No wide-search key is configured at all, so the main source never ran. | Add the key in Setup, under JD Sourcing, Wide pass. |
| `SRC-PEOPLE` | The people search refused every request | The paid people-search host/path in Setup points at an endpoint that 404s. | Correct the host/path in Setup for that workspace. |
| `SRC-CONTACTDB` | The contact database is offline | The free contact-database sweep could not run: worker unreachable, or missing its login. | Check the enrichment worker is up and still has credentials. |
| `SRC-FRESHONLY` | Fresh only is ticked and everyone found was already surfaced | Working as designed. Every result was excluded by the cross-run seen-list. | Nothing to fix. The recruiter unticks Fresh only. |
| `SRC-FILTERED` | People were found but all were ruled out | The engines returned profiles; the search profile's hard disqualifiers or the fit bar discarded every one. | Nothing to fix unless it repeats across many searches, which points at the ICP parse or the geo filter being too strict. |
| `SRC-FREEENGINE` | The free search engine did not answer | The self-hosted free engine returned nothing and nothing else produced anyone. Chronic on this box: datacenter IPs are blocked by every upstream. | Usually not worth fixing. Only residential-proxy egress changes it. |
| `SRC-NONE` | No search source returned anyone | Everything ran, nothing came back, and no specific cause was identified. | If this repeats, check engine health before assuming the profile was simply too narrow. |
| `SRC-SERVER` | The step was refused by the server | An API call returned a non-OK status. The stage name and the server's short error ride along in the message. | Read the stage in the message, then the app logs for that route. |
| `SRC-DEPLOY` | The platform was updating and the search was lost before it was registered | The request died before the recovery checkpoint was armed, so there was nothing to resume. Since the checkpoint now arms before the first slow call, this window is very small. | If this shows up often, the deploy cadence is the problem, not the code. |
| `SRC-RECOVERY` | The server picked the search back up but could not finish it | The crash-net checkpoint was armed and the queue took the search over, but the re-run itself failed. The queue item's own error text is in the message. | Check the night-queue item's error, then the search stage in `nightQueue.ts`. |
| `SRC-TIMEOUT` | The platform did not come back within 30 minutes | The recovery watch gave up. The search may still land on its own. | Check the app came back at all, and whether the queue item completed. |
| `SRC-DELIVERY` | The list is saved but could not be sent to Candidates or OS Text | The list saved fine; the promote and/or OS Text push returned an error. The failing leg and its reason are named in the message. | Look at the named leg: `action:"promote"` or `action:"ostext"` in the sourcing route. |
| `SRC-DELIVERY-NET` | The list is saved but the server could not be reached to send it on | Same as above, but the request never got an answer at all. | Usually a deploy swap. The list is safe; Send retries it. |
| `SRC-UNKNOWN` | (generic) | A stop path that did not set a code. | **Treat as a bug.** Every stop path should name itself; find the one that did not. |

## Rules for adding a code

1. The recruiter-facing sentence names no vendor, no key, no query, no engine. Outcome
   and next action only.
2. Say plainly whether anything was saved. "Nothing was saved" and "the list is saved but
   was not sent on" are very different instructions to the person reading it.
3. Say whether re-running helps. `SRC-CREDITS` explicitly says it will not, so nobody
   burns twenty minutes retrying a run that cannot succeed.
4. Engineer-facing specifics go in `StopReason.detail`, never in the sentence.
5. Add the code to this table in the same commit. A code with no row here is worse than
   no code at all.
