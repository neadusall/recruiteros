import type { SignalAngle, SignalType } from "./taxonomy";

export const SIGNAL_ANGLES: Record<SignalType, SignalAngle> = {

  funding_round: {
    type: "funding_round",
    timing: "Fresh capital means the mandate to build out the team typically follows within 30 to 90 days, before the board cadence locks in the plan.",
    bd: "Saw {company} closed its latest round — usually the moment the mandate to build out the team gets real.",
    recruiting: "Noticed {company} just raised, which tends to mean a wave of senior hiring and new scope opening up.",
  },

  ipo_or_s1: {
    type: "ipo_or_s1",
    timing: "An S-1 filing or IPO triggers the most aggressive hiring cycle a company ever runs — public-company infrastructure has to be in place before the bell rings.",
    bd: "Saw {company} is moving toward a public listing — that transition usually means building out functions fast to meet public-company requirements.",
    recruiting: "With {company} heading toward a public listing, the roles that open up tend to carry real scope and visibility that is hard to find elsewhere.",
  },

  acquisition: {
    type: "acquisition",
    timing: "Acquisitions create an integration window of three to six months where both retention churn and net-new headcount requirements are highest.",
    bd: "Noticed {company} is going through an acquisition — the integration period tends to surface both gaps and opportunities across teams.",
    recruiting: "With {company} in the middle of an acquisition, it is often a moment when talented people are reassessing their situation and what comes next.",
  },

  merger: {
    type: "merger",
    timing: "Mergers reorganize reporting structures and role mandates quickly, creating a window where new leaders are actively staffing their combined organizations.",
    bd: "Saw that {company} is working through a merger — org resets at that scale usually generate both backfill needs and newly scoped roles.",
    recruiting: "Mergers tend to reshape teams in ways that are not always obvious from the outside, and a lot of strong people start thinking about their options.",
  },

  revenue_milestone: {
    type: "revenue_milestone",
    timing: "A revenue milestone or earnings beat is typically followed by board-approved headcount expansion before the next planning cycle closes.",
    bd: "Saw {company} recently hit a significant revenue milestone — that kind of momentum usually unlocks the headcount budget that has been on hold.",
    recruiting: "With {company} hitting a growth milestone, the teams driving that are usually adding capacity quickly.",
  },

  grant_or_contract: {
    type: "grant_or_contract",
    timing: "A government grant or major contract win comes with delivery obligations and staffing timelines that are often contractually binding.",
    bd: "Noticed {company} recently won a significant contract or grant — those awards usually come with very specific staffing requirements attached.",
    recruiting: "When {company} lands a contract of that size, the teams responsible for delivery typically need to grow to meet the timeline.",
  },

  job_posting: {
    type: "job_posting",
    timing: "An active job posting is the clearest possible signal that a hiring manager has an approved req and is actively looking.",
    bd: "Saw {company} just posted a {role} role — an open req with an approved headcount is usually the right moment to have a conversation.",
    recruiting: "Noticed {company} is actively looking for a {role} — thought it was worth reaching out directly given your background.",
  },

  hiring_velocity: {
    type: "hiring_velocity",
    timing: "A surge in posting cadence above a company's own baseline signals a growth phase where the pipeline is almost always under-resourced.",
    bd: "Noticed {company} has picked up its posting cadence significantly recently — a surge like that usually means the pipeline is feeling the pressure.",
    recruiting: "With {company} opening {n} roles in a short window, there is usually a lot of movement happening across the organization.",
  },

  job_repost: {
    type: "job_repost",
    timing: "A reposted role tells you the position is still unfilled and the hiring team is feeling the pain — they are receptive to help they would not have accepted at first post.",
    bd: "Saw {company} has reposted the {role} role — a position that keeps getting reposted usually means the search is harder than expected.",
    recruiting: "Noticed {company} has re-opened a {role} search — when a role comes back around, it is often because the bar is high and the right fit hasn't appeared yet.",
  },

  evergreen_role: {
    type: "evergreen_role",
    timing: "A role open for more than a typical hiring cycle signals ongoing pipeline pain and a team that has likely already tried the usual approaches.",
    bd: "Saw {company} has had a {role} position open for a while now — roles that stay open that long usually point to a sourcing challenge worth talking through.",
    recruiting: "Noticed {company} has been running a {role} search for some time — those long-running searches tend to mean a specific profile they haven't found yet.",
  },

  headcount_growth: {
    type: "headcount_growth",
    timing: "Observed headcount growth is a lagging indicator that confirms a hiring phase is already underway, and usually means the next wave is already being planned.",
    bd: "Noticed {company}'s team has grown meaningfully recently — that kind of expansion tends to create demand across multiple functions at once.",
    recruiting: "Saw {company} has been growing its team, which usually means new scope and new mandates being handed to the people already inside.",
  },

  careers_page_launch: {
    type: "careers_page_launch",
    timing: "Launching a careers page or ATS subdomain is one of the first public acts of building a recruiting function, meaning the hiring infrastructure is brand new.",
    bd: "Noticed {company} just launched a careers page — building that hiring infrastructure from scratch is usually where outside support makes the biggest difference.",
    recruiting: "With {company} just standing up its careers presence, this is early in what is likely a sustained hiring push.",
  },

  ats_detected: {
    type: "ats_detected",
    timing: "Adopting or switching an ATS signals that the company is formalizing its hiring process, which typically accompanies a meaningful ramp in volume.",
    bd: "Noticed {company} recently adopted a new ATS — companies that make that investment are usually expecting volume to justify it.",
    recruiting: "Saw {company} formalizing its hiring setup, which typically means they are gearing up for a sustained period of growth.",
  },

  exec_hire: {
    type: "exec_hire",
    timing: "A new VP or C-level executive rebuilds their organization within the first 90 days — that is the window when relationships with outside partners get formed.",
    bd: "Saw {company} recently brought on a new {role} — incoming execs typically spend the first quarter shaping their team and their vendor relationships.",
    recruiting: "With a new {role} just joining {company}, the organization around them tends to shift fairly quickly.",
  },

  exec_departure: {
    type: "exec_departure",
    timing: "An executive departure creates both a backfill need and a destabilized team that often prompts a broader look at the org structure.",
    bd: "Noticed that {company} recently had a {role} departure — leadership transitions like that usually prompt a review of the team and what needs to change.",
    recruiting: "When a senior leader leaves {company}, it often creates movement across the organization, with scope shifting to people who stay.",
  },

  department_head_change: {
    type: "department_head_change",
    timing: "A new function lead almost always rebuilds their team in the first quarter, replacing contractors, promoting from within, and hiring for gaps they identified before accepting the role.",
    bd: "Saw {company} has a new head of {role} — function leads that are new to the role typically move fast to put their own team in place.",
    recruiting: "With {company} bringing in a new {role} leader, the team underneath tends to see real change in the months that follow.",
  },

  board_change: {
    type: "board_change",
    timing: "Board composition changes often signal a strategic pivot that soon flows into executive and functional hiring aligned with the new direction.",
    bd: "Noticed {company} recently had a board change — new board members typically bring a perspective that shapes the executive and functional priorities pretty quickly.",
    recruiting: "A board-level shift at {company} often signals a strategic reset that tends to create new roles and new mandates internally.",
  },

  layoff: {
    type: "layoff",
    timing: "A workforce reduction concentrates talent in the market and, on the company side, typically opens a window where remaining leadership is receptive to conversations about building back smarter.",
    bd: "Aware that {company} has been going through a difficult restructuring — when teams are rebuilding after a reduction, the focus on doing more with less often creates a different kind of conversation.",
    recruiting: "Know that {company} has gone through some difficult changes recently, in case it is useful to talk through what options look like from here.",
  },

  warn_notice: {
    type: "warn_notice",
    timing: "A WARN Act filing names a specific date and count, giving the market a precise window to prepare and making outreach timely rather than speculative.",
    bd: "Aware of the WARN notice filed by {company} — as leadership thinks through next steps, there are sometimes ways we can help with the transition.",
    recruiting: "Saw the WARN notice from {company} and happy to have a conversation whenever the timing feels right for you.",
  },

  office_closure: {
    type: "office_closure",
    timing: "A site shutdown releases a concentrated pool of talent from a specific location, and many of those individuals are open to conversations they would not have taken before.",
    bd: "Aware that {company} is closing its {location} office — transitions like that sometimes open up conversations about what the team looks like going forward.",
    recruiting: "Heard about {company}'s office closure and wanted to check in — if it would be helpful to talk through what is available in the market, happy to do that.",
  },

  down_round: {
    type: "down_round",
    timing: "Distress financing heightens flight risk among key staff and often prompts a quiet search for opportunities, making proactive outreach unusually well-received.",
    bd: "Aware that {company} has been navigating some financing headwinds — when teams are working through that, outside perspective on priorities can sometimes be useful.",
    recruiting: "Know that things at {company} have been uncertain lately, in case it is helpful to have a conversation about what else might be worth exploring.",
  },

  bankruptcy: {
    type: "bankruptcy",
    timing: "A bankruptcy filing puts talent, client relationships, and operating capacity into motion simultaneously, and timing outreach to that window matters.",
    bd: "Aware that {company} is working through a restructuring process — there are sometimes ways we can help during that period, and wanted to make sure the line was open.",
    recruiting: "Heard about the situation at {company} . If it would be useful to talk about what the landscape looks like right now, I am available whenever the timing works for you.",
  },

  office_expansion: {
    type: "office_expansion",
    timing: "Opening or expanding an office creates a greenfield team-building moment where the local network does not exist yet and outside help has the most leverage.",
    bd: "Noticed {company} is expanding into {location} — standing up a team in a new market is one of those moments where local knowledge and sourcing relationships matter a lot.",
    recruiting: "Saw that {company} is opening in {location} — new offices usually mean real opportunities for people who want to be part of building something from the ground up.",
  },

  market_entry: {
    type: "market_entry",
    timing: "Entering a new country, region, or segment requires specialized local talent and network that almost no company has in place on day one.",
    bd: "Noticed {company} is moving into {market} — standing up a team in a new market is one of the harder parts of that expansion.",
    recruiting: "Saw that {company} is entering {market} — market expansions tend to create roles with real scope for people who know the territory.",
  },

  product_launch: {
    type: "product_launch",
    timing: "A new product line requires both the people to build it and the go-to-market team to sell it, typically on a compressed timeline tied to launch commitments.",
    bd: "Noticed {company} recently launched {product} — new product lines tend to generate parallel demand across engineering, product, and go-to-market functions.",
    recruiting: "With {company} launching {product}, the teams responsible for taking that to market are usually adding capacity quickly.",
  },

  partnership: {
    type: "partnership",
    timing: "A major partnership or channel deal creates implementation and enablement demands that often outpace the current headcount immediately.",
    bd: "Saw {company} recently announced a partnership — those deals tend to generate demand on the teams responsible for making them work.",
    recruiting: "With {company} taking on a significant partnership, the functions that support it tend to grow to match the commitment.",
  },

  tech_stack_change: {
    type: "tech_stack_change",
    timing: "Adopting a new technology creates an immediate skills gap while the team is mid-transition, making specialist sourcing acutely time-sensitive.",
    bd: "Noticed {company} recently adopted {technology} — technology transitions like that usually surface a need for people who already know the tooling.",
    recruiting: "Saw that {company} is moving toward {technology} — teams in the middle of a stack transition often need people who can hit the ground running.",
  },

  intent_surge: {
    type: "intent_surge",
    timing: "A spike in research activity on hiring-adjacent topics is a leading indicator that a decision is forming before it becomes a posted req.",
    bd: "Noticed elevated research activity around {topic} from {company}'s direction — that kind of interest usually means something is being evaluated.",
    recruiting: "Saw signals that {company} is actively exploring {topic} — that research phase tends to translate into openings fairly quickly.",
  },

  web_traffic_surge: {
    type: "web_traffic_surge",
    timing: "A demand spike that outpaces current capacity creates scale pressure that hiring must address before it erodes the customer experience.",
    bd: "Noticed {company} appears to be experiencing a significant traffic surge — that kind of growth typically puts pressure on the teams responsible for delivering at scale.",
    recruiting: "With {company} seeing strong demand growth, the teams responsible for capacity and delivery tend to be the first ones that need to grow.",
  },

  review_velocity: {
    type: "review_velocity",
    timing: "A spike in Glassdoor or G2 reviews, positive or negative, signals an inflection point in the company's momentum that often precedes hiring changes.",
    bd: "Noticed a recent uptick in reviews for {company} — review velocity at that pace usually reflects a shift in momentum worth paying attention to.",
    recruiting: "Saw that {company} has been getting a lot of attention in reviews lately — that kind of visibility often comes with a growth phase that opens up interesting roles.",
  },

  open_to_work: {
    type: "open_to_work",
    timing: "An explicit availability flag is the clearest possible signal that a person is actively open, making outreach immediately relevant rather than speculative.",
    bd: "Noticed {full_name} recently indicated they are open to new opportunities — worth keeping in mind if a relevant situation comes up on our side.",
    recruiting: "Saw you recently indicated you are open to new opportunities, so it is a good time to connect and see if a conversation might be useful.",
  },

  tenure_milestone: {
    type: "tenure_milestone",
    timing: "Three- and four-year marks are when people most commonly start looking, whether or not they have said so publicly.",
    bd: "Noticed {full_name} is coming up on a significant tenure milestone at {company} — people at that stage are often thinking about what the next chapter looks like.",
    recruiting: "Reaching out because you are approaching a point in your time at {company} where a lot of people start thinking about what might be next.",
  },

  promotion_passed_over: {
    type: "promotion_passed_over",
    timing: "A title that has not moved in line with tenure and scope is one of the quietest and most reliable signals that someone is assessing their options.",
    bd: "Noticed {full_name}'s title at {company} has been stable for a while relative to what people in similar roles are typically moving into.",
    recruiting: "Reaching out because your tenure and scope at {company} stood out — happy to have a confidential conversation if it would be useful.",
  },

  employer_distress: {
    type: "employer_distress",
    timing: "When someone's employer hits a layoff, down-round, or exit event, even people not directly affected become receptive to understanding their options.",
    bd: "Aware that things have been uncertain at {company} lately — wanted to make sure the line was open if that is ever relevant.",
    recruiting: "Know that things at {company} have been unsettled recently, and happy to have a conversation about what is out there whenever it feels right.",
  },

  layoff_affected: {
    type: "layoff_affected",
    timing: "A person who is directly impacted by a reduction is immediately in the market, but the most useful outreach reaches them early and without pressure.",
    bd: "Aware of the recent changes at {company} and {full_name}'s background may be relevant to what we are working on.",
    recruiting: "Heard about the recent changes at {company} . If a conversation about what is out there would be helpful, I am available at whatever pace works for you.",
  },

  job_change: {
    type: "job_change",
    timing: "A recent job change means the person is probably settled in their new role but their network and profile are warm, making this a good moment to establish a relationship for later.",
    bd: "Noticed {full_name} recently made a move — as they get settled in a new role, it is a good time to introduce ourselves for when the timing is right.",
    recruiting: "Saw you recently made a move and wanted to congratulate you — always happy to stay connected for whenever it might be useful down the road.",
  },

  profile_update: {
    type: "profile_update",
    timing: "A headline or skills refresh often precedes an active search by a few weeks, making it an early signal while the person is not yet being flooded with outreach.",
    bd: "Noticed {full_name} recently refreshed their profile — that kind of update often reflects a shift in direction worth paying attention to.",
    recruiting: "Saw you recently updated your profile and happy to have a conversation if you are exploring what might be next.",
  },

  activity_spike: {
    type: "activity_spike",
    timing: "A surge in posting, endorsing, or engaging on LinkedIn signals that someone is raising their visibility, which typically precedes or accompanies a search.",
    bd: "Noticed {full_name} has been quite active recently — that kind of engagement usually reflects a moment of momentum worth staying in touch around.",
    recruiting: "Saw you have been active recently . If there is anything I can be useful for, happy to connect.",
  },

  relocation: {
    type: "relocation",
    timing: "A recent move opens up a new market for the person and often prompts a reassessment of their role and options in the new location.",
    bd: "Noticed {full_name} recently relocated to {location} — new markets tend to open up new conversations about what makes sense next.",
    recruiting: "Saw you recently moved to {location} — happy to share what the market looks like here if that would be useful as you get settled.",
  },

  education_completion: {
    type: "education_completion",
    timing: "Finishing a degree, bootcamp, or certification is a defined transition point where the person is actively considering their next step.",
    bd: "Noticed {full_name} recently completed {program} — people coming out of a focused program like that are often at an interesting transition point.",
    recruiting: "Saw you recently completed {program}, congratulations. A conversation about what is out there might be useful if you are open to it.",
  },

  contract_ending: {
    type: "contract_ending",
    timing: "A contractor or visa term with a known end date creates a precise availability window, making outreach well-timed when it arrives before the contract closes.",
    bd: "Noticed {full_name}'s current engagement at {company} may be wrapping up, so now is a good time to explore whether there is something relevant.",
    recruiting: "Aware that your current engagement may be coming to a close . Happy to talk through what is in the market at whatever pace works.",
  },

};
