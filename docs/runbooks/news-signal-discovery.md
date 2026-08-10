# News-signal discovery (Signal Watchlists, `source: "news"`)

Companion to [signal-watchlists.md](./signal-watchlists.md). That runbook covers the
job-feed front end. This one covers the news front end, which answers a different and
earlier question.

| | job feed | news feed |
|---|---|---|
| trigger | a role was **posted** | the company **raised / hired an exec / expanded / acquired / launched** |
| you search | a job title | a **segment** ("supply chain software") |
| cost | RapidAPI JSearch, budget-metered | **$0**, Google News RSS is keyless |
| timing | after the req exists | **before the reqs are posted** |

Both hand the same `InMarketLead[]` to the same belt: dedupe against the global seen
set, `curateFromPool` for 3 decision-makers, Clients tab, email, Send Queue.

## Why a news lead reaches the same decision-maker

`curateFromPool` finds a buyer by asking "who owns this open role?", and it **drops any
lead with no roles**. A funding headline carries none, so discovery infers the build-out
the money buys (`Account Executive`, `Software Engineer`, `Operations Manager` by
default). Those three classify into three distinct job functions, so the curator
researches three different bosses at the same company. Set `targetRoles` on the list to
override the inference with the roles your desk actually fills.

## Why a company is never pitched twice

News leads are keyed with the job feed's own `companyKey()` (`jobfeed_<normalized>`).
A company that both raised and posted a role is one company to the seen set, so it gets
one pitch, not two.

## Creating a news watchlist

```bash
curl -sS https://<host>/api/signals/watch \
  -H 'content-type: application/json' -H 'cookie: <session>' \
  -d '{
    "action": "save",
    "watchlist": {
      "name": "Supply chain software raises",
      "source": "news",
      "segment": "supply chain software",
      "newsSignals": ["funding_round", "exec_hire"],
      "newsWindowDays": 7,
      "minAmountUsd": 5000000,
      "targetRoles": ["Director of Operations"],
      "everyMinutes": 60
    }
  }'
```

Fields (all optional except `segment`):

| field | default | notes |
|---|---|---|
| `segment` | required | plain English, quoted into the news query |
| `newsSignals` | `funding_round`, `exec_hire` | also `office_expansion`, `acquisition`, `product_launch` |
| `newsWindowDays` | 7 | clamped 1..90, uses Google News' own `when:` operator |
| `minAmountUsd` | none | a raise with **no stated amount is kept**: plenty of real rounds omit the figure |
| `targetRoles` | inferred | overrides the post-signal build-out |
| `perPollCompanyCap` | 25 | ceiling on net-new companies per poll |

Layoff and distress signals are deliberately **not** discoverable here. A layoff is a
candidate-supply signal, not a reason to pitch a company on hiring help.

## The desk profile (required for good copy)

The pitch makes exactly two claims about **you**, and neither can come from a headline.
Set them once per workspace:

```bash
curl -sS https://<host>/api/signals/watch \
  -H 'content-type: application/json' -H 'cookie: <session>' \
  -d '{
    "action": "saveDeskProfile",
    "profile": {
      "firmName": "Lume",
      "verticals": ["distribution", "warehousing", "logistics"],
      "placesTitles": "the operations and supply chain leaders we bring",
      "domainDifficulty": "regulated, complex product handling",
      "positioning": "We build leadership teams as an embedded partner, not a resume vendor.",
      "ctaMinutes": 15
    }
  }'
```

Read it back with `{"action":"deskProfile"}`. Until it is set the email still renders,
but beats 3 and 4 fall back to generic language rather than inventing a specialization
the desk never claimed.

`verticals` and `domainDifficulty` are the two fields that assert something about the
FIRM, and they go out verbatim in every send. Set them to what Lume genuinely recruits
into. The values above are the worked example, not a verified claim.

## The email

Five beats, in this order:

1. **observation** the signal said back as a fact about their business
2. **stakes** why that hire is hard in their vertical
3. **proof** your matching specialization (desk profile)
4. **positioning** one line (desk profile)
5. **ask** a time-boxed question

The prose reason also lands on the prospect's `signalReason`, which is the `Signal:`
line in the existing Email 1 prompt, so the belt's own copy is anchored on the same fact.

`SIGNAL_PITCH_AI=0` disables the Haiku surface-variation pass. The deterministic
template is always the floor: a rewrite is discarded whenever it adds a dash, a banned
phrase, an unrendered token, a candidate claim, or drifts outside 45..130 words.

## Verifying it works

```bash
cd integration
npx tsx scripts/test-news-signals.mts   # 142 deterministic assertions, no network
npx tsx scripts/live-news-check.mts     # live Google News pull, prints extracted leads
npx tsx scripts/live-news-pitch.mts     # live leads composed into finished emails
```

`live-news-check` is the one to run when quality drops: it prints
`queries / headlines / named / leads`. A healthy segment names a company in most
headlines. A collapse in `named` means the extractor is meeting a headline shape it does
not know, and `scripts/live-news-check.mts` is the place to widen it.

## Head to head vs Hire Signals

Both arms feed the same belt, the same curation, the same copy engine and the same
mailboxes. The only difference is which front end put the company in the funnel, which
is what makes the result readable rather than two dashboards side by side.

Open a matched pair (same cap, same cadence, same segment):

```bash
COOKIE='session=...' SEGMENT='supply chain software' JOB_QUERY='VP Operations' \
  bash C:/Users/nead0/start-source-trial.sh
```

Read it any time:

```bash
curl -sS "$HOST/api/signals/watch" -H 'content-type: application/json' \
  -H "cookie: $COOKIE" -d '{"action":"sourceTrial","from":"2026-08-10"}'
# or on the box:
npx tsx scripts/source-trial-report.mts --from 2026-08-10
```

**Headline metric is replies / sends.** Reply per send is unaffected by one arm simply
discovering more companies, which is a volume question rather than a quality one. Volume
is reported next to it as `replies/100 companies`, because an arm that finds ten times as
many companies at the same reply rate is still worth far more. The pair of numbers is
what decides where to spend.

**Attribution is first-touch and never moves.** The arm that first puts a company in the
funnel keeps credit for whatever it goes on to do. A later re-curate by the other arm
does not re-attribute it. Without that rule the trial would score its own bookkeeping.
Rows curated before the trial shipped carry no attribution, sit in neither arm, and are
reported as `unattributedProspects`.

**The verdict refuses to be rushed.** It stays `insufficient_data` until both arms clear
200 sends, and `tie` unless a two-proportion z-test on reply rate clears p < 0.05. This
matters more than it sounds: a 15/215 vs 8/240 split looks like double the reply rate and
is still only p=0.077. The report says how many more sends per arm would resolve the gap
it is actually seeing.

Sends per arm needed, 80% power, p<0.05, at a 3.5% baseline:

| to distinguish | sends per arm |
|---|---|
| 3.5% vs 4.5% | ~6,000 |
| 3.5% vs 5.0% | ~2,840 |
| 3.5% vs 7.0% | ~640 |

So a week of normal volume can only settle a large difference. A 1-point difference is a
quarter-long question. Plan the call accordingly.

The report also warns when one arm has 3x the other's volume, and when an arm's bounce
rate is above 2% (a reply rate bought with domain damage is not a win).

## Known limits (stated honestly)

- **Google News is a pull feed.** "Real time" means same-hour, bounded by indexing lag
  plus the poll cadence, not the second an article publishes.
- **Outlet name variants do not merge.** Two outlets spelling a company "Conner" and
  "Connor" produce two leads. Possessive and descriptor prefixes DO merge.
- **Segment fit is the recruiter's call.** A company surfaced under "supply chain
  software" is asserted to be in that market by the copy. Narrow segments behave better
  than broad ones.
- **LinkedIn posts are not a discovery source.** Unipile reads posts for a profile you
  already follow (`lib/linkedin/poster.ts`), so LinkedIn adds depth on known targets, not
  new companies. RSS is what finds companies you do not know yet.
