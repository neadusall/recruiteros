/**
 * RecruitersOS · BD · MPC · The 50 Day-0 templates
 *
 * The single cold-email BD model: a short, real, recent-placement MPC note that opens with a timeline
 * hook (the strongest-converting hook type), speaks the role's native lingo through resolved tokens,
 * names the local market, and closes on ONE soft "worth a conversation?" CTA (soft asks beat meeting
 * asks ~3x). Casual punctuation on purpose — reads like a person typed it fast, not a campaign.
 *
 * DESIGN RULES (so 50 x spintax stays clean at scale):
 *  - Fixed template text is UNIVERSAL. Every role/industry/city-specific word arrives via a {{token}},
 *    so the same 50 speak sales, nursing, or engineering natively (lexicon.ts fills the tokens).
 *  - Merge tokens are DOUBLE brace {{Token}} (filled per-prospect in renderTouch). Spin groups are
 *    SINGLE brace {a|b} and only swap grammar-SAFE alternates — never an article + variable token,
 *    never two "just" slots, never a pronoun that breaks a contraction. The two never collide (a merge
 *    token has no pipe; a spin group has no braces of its own).
 *  - `needsProximity`: uses the "right by you" angle — skipped when placement and job share a metro.
 *  - `needsCompetitor`: names {{Competitor}} — skipped when we don't have one.
 *
 * Tokens (resolved in resolve.ts): {{First_Name}} {{Open_Role}} {{Job_Title}} {{Near_City}}
 * {{Competitor}} {{Industry}} {{Job_Location}} {{MH1}} {{MH2}} {{Metric}} {{P_subj}} {{P_obj}}
 * {{P_pos}} {{Your_Name}}. Merge-fill + spintax expansion run per-prospect in lib/automation/model.ts.
 */

export interface MpcTemplate {
  id: string;
  angle: string;
  subject: string;
  body: string;
  needsProximity?: boolean;
  needsCompetitor?: boolean;
}

const SIGN = "\n{Thanks|Best}, {{Your_Name}}";

export const MPC_TEMPLATES: MpcTemplate[] = [
  /* 1. Direct value ------------------------------------------------------------------ */
  { id: "direct-1", angle: "Direct value", subject: "{one by you last week|found one for your {{Open_Role}}}",
    body: "Hi {{First_Name}}, i wrapped {{A_Job_Title}} search in {{Near_City}} last week and met someone sharper for your {{Open_Role}} seat. {{MH1}}, {{MH2}}, and {{P_subj}}'s set on {{Job_Location}}. worth a conversation?" + SIGN },
  { id: "direct-2", angle: "Direct value", subject: "found your next {{Open_Role}}",
    body: "Hi {{First_Name}}, met {{P_obj}} filling {{A_Job_Title}} role in {{Near_City}} and {{P_subj}} lines up almost exactly with your {{Open_Role}} seat. {{MH1}}, {{MH2}}. worth a conversation?" + SIGN },
  { id: "direct-3", angle: "Direct value", subject: "sharper than the role i had {{P_obj}} for",
    body: "Hi {{First_Name}}, quick one. just closed {{A_Job_Title}} search and the person i met is a better fit for your {{Open_Role}} than the seat i had {{P_obj}} for. {{MH1}}, {{MH2}}, wants {{Job_Location}}. worth a conversation?" + SIGN },
  { id: "direct-4", angle: "Direct value", subject: "a strong {{Open_Role}}, already vetted",
    body: "Hi {{First_Name}}, one candidate, not a list. maps to your {{Open_Role}} almost too well. {{MH1}}, {{MH2}}, and already screened on comp and timing. wants {{Job_Location}}. worth a conversation?" + SIGN },
  { id: "direct-5", angle: "Direct value", subject: "{{Open_Role}} that fits your team",
    body: "Hi {{First_Name}}, i met a strong {{Open_Role}} on a recent {{Job_Title}} search who fits a team like yours better than the role i had in mind. {{MH1}}, {{MH2}}. worth a conversation?" + SIGN },

  /* 2. Local market ------------------------------------------------------------------ */
  { id: "local-1", angle: "Local market", subject: "local to you",
    body: "Hi {{First_Name}}, i run a lot of {{Industry}} searches around {{Near_City}}, and last week's turned up a strong {{Open_Role}} who wants {{Job_Location}}. {{MH1}}, {{Metric}}. worth a conversation?" + SIGN },
  { id: "local-2", angle: "Local market", subject: "someone in your market",
    body: "Hi {{First_Name}}, i work the {{Near_City}} market pretty hard and just met {{A_Open_Role}} worth flagging to you. {{MH1}}, {{MH2}}, wants to land in {{Job_Location}}. worth a conversation?" + SIGN },
  { id: "local-3", angle: "Local market", subject: "{{Near_City}} {{Open_Role}}",
    body: "Hi {{First_Name}}, most of my week is {{Industry}} searches around {{Near_City}}, so your {{Open_Role}} opening stood out. i've got someone in process right now who fits: {{MH1}}, {{MH2}}. worth a conversation?" + SIGN },
  { id: "local-4", angle: "Local market", subject: "know your market, know this one",
    body: "Hi {{First_Name}}, i place a lot of these near {{Near_City}}. met one this week who reads like your {{Open_Role}} and wants {{Job_Location}}: {{MH1}}, {{MH2}}. worth a conversation?" + SIGN },

  /* 3. Quiet candidate --------------------------------------------------------------- */
  { id: "quiet-1", angle: "Quiet candidate", subject: "quiet one, worth a look",
    body: "Hi {{First_Name}}, {{A_Job_Title}} placement in {{Near_City}} last week turned up someone better for your {{Open_Role}} than the role i had {{P_obj}} for. {{MH1}}, {{MH2}}, keeping it quiet. worth a conversation before {{P_subj}} moves?" + SIGN },
  { id: "quiet-2", angle: "Quiet candidate", subject: "not on the market, {{First_Name}}",
    body: "Hi {{First_Name}}, {{P_subj}}'s not on the open market, so this is an early look. strong {{Open_Role}} i met on a {{Near_City}} search, quietly open, set on {{Job_Location}}. {{MH1}}, {{MH2}}. worth a conversation?" + SIGN },
  { id: "quiet-3", angle: "Quiet candidate", subject: "before {{P_subj}} goes public",
    body: "Hi {{First_Name}}, i'd rather you see {{P_obj}} before {{P_subj}}'s on every job board. {{Open_Role}} out of a recent {{Near_City}} search, {{MH1}}, {{MH2}}, wants {{Job_Location}}. worth a conversation?" + SIGN },
  { id: "quiet-4", angle: "Quiet candidate", subject: "a quiet maybe",
    body: "Hi {{First_Name}}, {{P_subj}}'s a quiet maybe, not actively looking, open for a short window. fits your {{Open_Role}} well: {{MH1}}, {{MH2}}. i'd rather you saw {{P_obj}} first. worth a conversation?" + SIGN },

  /* 4. Not a mass email -------------------------------------------------------------- */
  { id: "solo-1", angle: "Not a mass email", subject: "not a mass email, {{First_Name}}",
    body: "Hi {{First_Name}}, one person, one seat. a rep in {{Industry}}, headed to {{Job_Location}}, whose record reads like your {{Open_Role}}: {{MH1}}, {{MH2}}. worth a conversation?" + SIGN },
  { id: "solo-2", angle: "Not a mass email", subject: "one specific person for one seat",
    body: "Hi {{First_Name}}, this isn't a blast. one {{Open_Role}} i met on a {{Near_City}} search whose background maps to your seat: {{MH1}}, {{MH2}}, wants {{Job_Location}}. worth a conversation?" + SIGN },
  { id: "solo-3", angle: "Not a mass email", subject: "sending you one, not a list",
    body: "Hi {{First_Name}}, i'm sending one candidate because {{P_subj}} fits your {{Open_Role}} that cleanly. {{MH1}}, {{MH2}}, set on {{Job_Location}}. worth a conversation?" + SIGN },
  { id: "solo-4", angle: "Not a mass email", subject: "the reason i'm writing",
    body: "Hi {{First_Name}}, i thought of your team for one reason: {{A_Open_Role}} i just met who'd fit. {{MH1}}, {{MH2}}, headed to {{Job_Location}}. worth a conversation?" + SIGN },

  /* 5. Proximity (needs a distinct nearby metro) ------------------------------------- */
  { id: "prox-1", angle: "Proximity", needsProximity: true, subject: "right down the road",
    body: "Hi {{First_Name}}, i filled {{A_Job_Title}} role for a team in {{Near_City}} last week, right up the road from you. same search left me a strong {{Open_Role}} who wants {{Job_Location}}: {{MH1}}, {{MH2}}. worth a conversation?" + SIGN },
  { id: "prox-2", angle: "Proximity", needsProximity: true, subject: "one town over",
    body: "Hi {{First_Name}}, just wrapped a search a town over in {{Near_City}} and met {{A_Open_Role}} better suited to your seat. {{MH1}}, {{MH2}}, wants {{Job_Location}} anyway. worth a conversation?" + SIGN },
  { id: "prox-3", angle: "Proximity", needsProximity: true, subject: "in your backyard",
    body: "Hi {{First_Name}}, i've been working {{Near_City}}, basically your backyard. met a strong {{Open_Role}} on it who's set on {{Job_Location}}: {{MH1}}, {{MH2}}. worth a conversation?" + SIGN },
  { id: "prox-4", angle: "Proximity", needsProximity: true, subject: "close to you",
    body: "Hi {{First_Name}}, placed {{A_Job_Title}} close to you in {{Near_City}} last week. the person i met after fits your {{Open_Role}} better: {{MH1}}, {{MH2}}, wants {{Job_Location}}. worth a conversation?" + SIGN },
  { id: "prox-5", angle: "Proximity", needsProximity: true, subject: "already local",
    body: "Hi {{First_Name}}, this one's already near you. {{A_Open_Role}} out of a {{Near_City}} search, wants to stay around {{Job_Location}}, and reads like your seat: {{MH1}}, {{MH2}}. worth a conversation?" + SIGN },

  /* 6. Comparable placement (needs a competitor name) -------------------------------- */
  { id: "comp-1", angle: "Comparable placement", needsCompetitor: true, subject: "placed one like this last week",
    body: "Hi {{First_Name}}, i placed {{A_Job_Title}} at {{Competitor}} in {{Near_City}} last week. the person i met after fits your {{Open_Role}} better than {{P_pos}} current seat: {{MH1}}, {{MH2}}, headed to {{Job_Location}}. worth a conversation?" + SIGN },
  { id: "comp-2", angle: "Comparable placement", needsCompetitor: true, subject: "off a {{Competitor}} search",
    body: "Hi {{First_Name}}, came off {{A_Job_Title}} search at {{Competitor}} with a strong {{Open_Role}} i couldn't place there. {{P_subj}} fits your seat: {{MH1}}, {{MH2}}, wants {{Job_Location}}. worth a conversation?" + SIGN },
  { id: "comp-3", angle: "Comparable placement", needsCompetitor: true, subject: "i place exactly this",
    body: "Hi {{First_Name}}, i just closed the same profile at {{Competitor}}, so i know it fills. the {{Open_Role}} i met on it wants {{Job_Location}}: {{MH1}}, {{MH2}}. worth a conversation?" + SIGN },
  { id: "comp-4", angle: "Comparable placement", needsCompetitor: true, subject: "your competitor just did this",
    body: "Hi {{First_Name}}, filled this exact seat at {{Competitor}} last week. the runner up is stronger than where {{P_subj}} is now and wants {{Job_Location}}: {{MH1}}, {{MH2}}. worth a conversation?" + SIGN },
  { id: "comp-5", angle: "Comparable placement", needsCompetitor: true, subject: "same seat, {{Near_City}}",
    body: "Hi {{First_Name}}, just did {{A_Job_Title}} for a team like yours at {{Competitor}}. met a second one who fits your {{Open_Role}}: {{MH1}}, {{MH2}}, set on {{Job_Location}}. worth a conversation?" + SIGN },

  /* 7. Ramp-ready -------------------------------------------------------------------- */
  { id: "ramp-1", angle: "Ramp ready", subject: "no ramp needed",
    body: "Hi {{First_Name}}, met a strong {{Open_Role}} on a {{Near_City}} search who'd produce early. {{MH1}} at {{Metric}}, {{MH2}}. relocating to {{Job_Location}} this quarter. worth a conversation?" + SIGN },
  { id: "ramp-2", angle: "Ramp ready", subject: "hits the ground running",
    body: "Hi {{First_Name}}, this {{Open_Role}} has been doing exactly your seat and hitting. {{MH1}}, {{MH2}}, {{Metric}}. wants {{Job_Location}}. worth a conversation?" + SIGN },
  { id: "ramp-3", angle: "Ramp ready", subject: "day one contributor",
    body: "Hi {{First_Name}}, i've got {{A_Open_Role}} who steps in and produces, because {{P_subj}}'s carried the same load already. {{MH1}}, {{MH2}}. headed to {{Job_Location}}. worth a conversation?" + SIGN },
  { id: "ramp-4", angle: "Ramp ready", subject: "already proven in the seat",
    body: "Hi {{First_Name}}, met {{P_obj}} on {{A_Job_Title}} search: proven in exactly your {{Open_Role}}, {{MH1}}, {{MH2}}, {{Metric}}. moving to {{Job_Location}}. worth a conversation?" + SIGN },

  /* 8. Matched to JD ----------------------------------------------------------------- */
  { id: "match-1", angle: "Matched to JD", subject: "matched line by line",
    body: "Hi {{First_Name}}, i read what good looks like for your {{Open_Role}} and matched {{P_obj}} line by line: {{MH1}}, {{MH2}}. {{Industry}} background, moving to {{Job_Location}}. worth a conversation?" + SIGN },
  { id: "match-2", angle: "Matched to JD", subject: "{{P_subj}} is your {{Open_Role}}",
    body: "Hi {{First_Name}}, read your must haves and this {{Open_Role}} is it. {{MH1}}, {{MH2}}, and set on {{Job_Location}}. worth a conversation?" + SIGN },
  { id: "match-3", angle: "Matched to JD", subject: "checks your two big boxes",
    body: "Hi {{First_Name}}, your seat needs {{MH1}} and {{MH2}}. i met someone who's both, on a recent {{Near_City}} search, wants {{Job_Location}}. worth a conversation?" + SIGN },
  { id: "match-4", angle: "Matched to JD", subject: "built for your {{Open_Role}}",
    body: "Hi {{First_Name}}, met {{A_Open_Role}} who fits your posting better than the role i had {{P_obj}} for: {{MH1}}, {{MH2}}. wants {{Job_Location}}. worth a conversation?" + SIGN },

  /* 9. Help first -------------------------------------------------------------------- */
  { id: "help-1", angle: "Help first", subject: "i can probably help",
    body: "Hi {{First_Name}}, i wrapped {{A_Job_Title}} search in {{Near_City}} and ended up with a strong {{Open_Role}} because of it, one who wants {{Job_Location}}. {{MH1}}, {{MH2}}. worth a conversation?" + SIGN },
  { id: "help-2", angle: "Help first", subject: "here if your {{Open_Role}} is a priority",
    body: "Hi {{First_Name}}, if filling your {{Open_Role}} is on your plate this quarter, i've got a strong one already: {{MH1}}, {{MH2}}, wants {{Job_Location}}. no pressure. worth a conversation?" + SIGN },
  { id: "help-3", angle: "Help first", subject: "one to save you the search",
    body: "Hi {{First_Name}}, might save you a search. met a strong {{Open_Role}} in {{Near_City}} who wants {{Job_Location}} and fits your seat: {{MH1}}, {{MH2}}. worth a conversation?" + SIGN },
  { id: "help-4", angle: "Help first", subject: "happy to point {{P_obj}} your way",
    body: "Hi {{First_Name}}, i've got a good {{Open_Role}} and your opening is the closest fit i've seen. {{MH1}}, {{MH2}}, set on {{Job_Location}}. happy to point {{P_obj}} your way. worth a conversation?" + SIGN },

  /* 10. Timing / window -------------------------------------------------------------- */
  { id: "time-1", angle: "Timing", subject: "before {{P_subj}} settles",
    body: "Hi {{First_Name}}, found a strong {{Open_Role}} while filling {{A_Job_Title}} in {{Near_City}}. quietly looking, set on {{Job_Location}}: {{MH1}}, {{MH2}}. worth a conversation before {{P_subj}} lands somewhere?" + SIGN },
  { id: "time-2", angle: "Timing", subject: "short window on this one",
    body: "Hi {{First_Name}}, this {{Open_Role}} is early in {{P_pos}} look, so the window's open now. {{MH1}}, {{MH2}}, wants {{Job_Location}}. worth a conversation?" + SIGN },
  { id: "time-3", angle: "Timing", subject: "taking calls this week",
    body: "Hi {{First_Name}}, met {{A_Open_Role}} on a {{Near_City}} search who's just started taking calls. fits your seat: {{MH1}}, {{MH2}}, headed to {{Job_Location}}. worth a conversation?" + SIGN },
  { id: "time-4", angle: "Timing", subject: "mid process elsewhere",
    body: "Hi {{First_Name}}, {{P_subj}}'s mid process with another firm, but {{P_subj}} wants {{Job_Location}} and fits your {{Open_Role}} better: {{MH1}}, {{MH2}}. worth a conversation before someone moves?" + SIGN },

  /* 11. Curiosity / pattern interrupt ------------------------------------------------ */
  { id: "cur-1", angle: "Curiosity", subject: "the one that got away (to me)",
    body: "Hi {{First_Name}}, i couldn't place this {{Open_Role}} on my last search and {{P_subj}}'s too good to sit on. wants {{Job_Location}}, fits your seat: {{MH1}}, {{MH2}}. worth a conversation?" + SIGN },
  { id: "cur-2", angle: "Curiosity", subject: "found your {{Open_Role}} by accident",
    body: "Hi {{First_Name}}, i wasn't even looking for you. met a strong {{Open_Role}} on a {{Near_City}} search who happens to fit your seat and wants {{Job_Location}}: {{MH1}}, {{MH2}}. worth a conversation?" + SIGN },
  { id: "cur-3", angle: "Curiosity", subject: "probably should send this",
    body: "Hi {{First_Name}}, sitting on {{A_Open_Role}} who'd do well on your team and figured i should say something. {{MH1}}, {{MH2}}, wants {{Job_Location}}. worth a conversation?" + SIGN },
  { id: "cur-4", angle: "Curiosity", subject: "worth 60 seconds",
    body: "Hi {{First_Name}}, 60 seconds: strong {{Open_Role}}, {{MH1}}, {{MH2}}, wants {{Job_Location}}, met {{P_obj}} on a recent {{Near_City}} search. worth a conversation?" + SIGN },

  /* 12. Peer / social proof ---------------------------------------------------------- */
  { id: "peer-1", angle: "Peer proof", subject: "teams like yours are hiring this",
    body: "Hi {{First_Name}}, i keep placing this exact profile for {{Industry}} teams at your stage. the {{Open_Role}} i've got now wants {{Job_Location}}: {{MH1}}, {{MH2}}. worth a conversation?" + SIGN },
  { id: "peer-2", angle: "Peer proof", subject: "pattern i keep seeing",
    body: "Hi {{First_Name}}, {{Industry}} teams around {{Near_City}} keep needing this seat, and i've got a strong {{Open_Role}} for it right now: {{MH1}}, {{MH2}}, wants {{Job_Location}}. worth a conversation?" + SIGN },
  { id: "peer-3", angle: "Peer proof", subject: "same profile, three teams",
    body: "Hi {{First_Name}}, third {{Industry}} team this month that could use this {{Open_Role}}. {{P_subj}} wants {{Job_Location}} and fits you best: {{MH1}}, {{MH2}}. worth a conversation?" + SIGN },
];

/** Templates that survive given what we know about the lead (drop proximity/competitor variants we
 *  can't honestly fill). Always leaves a healthy pool, so selection never starves. */
export function eligibleTemplates(opts: { proximityOk: boolean; hasCompetitor: boolean }): MpcTemplate[] {
  return MPC_TEMPLATES.filter((t) => {
    if (t.needsProximity && !opts.proximityOk) return false;
    if (t.needsCompetitor && !opts.hasCompetitor) return false;
    return true;
  });
}

/** Deterministic template pick for a prospect (stable per seed), from the eligible pool. */
export function pickTemplate(seed: string, opts: { proximityOk: boolean; hasCompetitor: boolean }): MpcTemplate {
  const pool = eligibleTemplates(opts);
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  return pool[(h >>> 0) % pool.length] ?? MPC_TEMPLATES[0];
}
