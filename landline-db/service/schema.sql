-- LandlineDB service schema (isolated database: landlinedb)
CREATE TABLE IF NOT EXISTS records (
  id          bigserial PRIMARY KEY,
  source      text,
  source_id   text,
  company     text,
  person      text,
  title       text,
  phone_e164  text,
  cell_e164   text,
  email       text,
  city        text,
  state       text,
  zip         text,
  industry    text,
  dial_class  text,
  domain      text,
  retrieved_at timestamptz DEFAULT now()
);

-- Dedup unit: one company/person can appear once per source per phone.
CREATE UNIQUE INDEX IF NOT EXISTS ux_rec
  ON records (source_id, phone_e164, md5(coalesce(company, person, '')));

CREATE INDEX IF NOT EXISTS ix_state   ON records (state);
CREATE INDEX IF NOT EXISTS ix_source  ON records (source_id);
CREATE INDEX IF NOT EXISTS ix_ind     ON records (industry);
CREATE INDEX IF NOT EXISTS ix_dial    ON records (dial_class);
CREATE INDEX IF NOT EXISTS ix_phone   ON records (phone_e164);
CREATE INDEX IF NOT EXISTS ix_search  ON records
  USING gin (to_tsvector('simple', coalesce(company,'') || ' ' || coalesce(person,'') || ' ' || coalesce(city,'')));
