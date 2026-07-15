-- LandlineDB: proprietary B2B phone intelligence store
-- Runs in its own Postgres database (landlinedb), never mixed with app data.

CREATE TABLE IF NOT EXISTS sources (
  source_id      text PRIMARY KEY,
  source_name    text NOT NULL,
  official_url   text,
  license        text,
  rights_score   int,
  last_ingest_at timestamptz,
  last_status    text,
  record_count   bigint DEFAULT 0
);

-- One row per source record (raw evidence is never overwritten; re-ingest upserts on (source_id, source_record_id))
CREATE TABLE IF NOT EXISTS records (
  id               bigserial PRIMARY KEY,
  source_id        text NOT NULL REFERENCES sources(source_id),
  source_record_id text NOT NULL,
  company_name     text,
  dba_name         text,
  person_name      text,
  person_title     text,
  phone_raw        text,
  phone_e164       text,
  cell_raw         text,
  cell_e164        text,
  fax_raw          text,
  email            text,
  website          text,
  address1         text,
  city             text,
  state            text,
  zip              text,
  industry         text,
  dial_class       text,          -- direct_dial | owner_main | switchboard
  company_size_hint int,          -- e.g. FMCSA power_units, DAC num_org_mem
  extra            jsonb,
  retrieved_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_id, source_record_id)
);

-- Deduped phone summary; the serving unit
CREATE TABLE IF NOT EXISTS phones (
  e164            text PRIMARY KEY,
  line_type       text,           -- landline | voip | mobile | unknown (Telnyx)
  line_checked_at timestamptz,
  best_dial_class text,
  support_count   int DEFAULT 1,
  first_seen      timestamptz DEFAULT now(),
  last_seen       timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_records_phone   ON records (phone_e164);
CREATE INDEX IF NOT EXISTS idx_records_cell    ON records (cell_e164);
CREATE INDEX IF NOT EXISTS idx_records_state   ON records (state);
CREATE INDEX IF NOT EXISTS idx_records_source  ON records (source_id);
CREATE INDEX IF NOT EXISTS idx_records_company ON records (lower(company_name) text_pattern_ops);
CREATE INDEX IF NOT EXISTS idx_records_person  ON records (lower(person_name) text_pattern_ops);
