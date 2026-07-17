/**
 * RecruitersOS · Signal Watchlists, public surface.
 * Target-job watchlists that poll the job feed on a cadence and feed net-new hiring companies
 * into the In-Market curation spine (→ Clients tab → emails → Send Queue), fully server-side.
 */

export {
  listWatchlists, getWatchlist, upsertWatchlist, setWatchlistActive, deleteWatchlist,
  recordPollResult, fetchBudgetRemaining, dailyFetchCap,
  type Watchlist, type WatchStats, type WatchlistInput,
} from "./store";

export {
  tickWatchlists, pollWatchlistNow, pollOne,
  type PollOutcome, type TickSummary,
} from "./poll";
