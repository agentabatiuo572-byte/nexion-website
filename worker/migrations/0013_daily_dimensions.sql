-- Versioned completeness prevents pre-migration summary gaps from being rendered as zero.
ALTER TABLE daily_visitors
  ADD COLUMN rollup_version INTEGER NOT NULL DEFAULT 0 CHECK (rollup_version >= 0);

-- One row per independent dimension value; no Cartesian traffic key and no invented attribution.
CREATE TABLE daily_dimensions (
  date TEXT NOT NULL,
  dimension TEXT NOT NULL CHECK (dimension IN ('locale', 'country', 'device', 'ref_class')),
  value TEXT NOT NULL CHECK (length(value) > 0),
  pv INTEGER NOT NULL DEFAULT 0 CHECK (pv >= 0),
  uv INTEGER NOT NULL DEFAULT 0 CHECK (uv >= 0),
  cta_visitors INTEGER,
  PRIMARY KEY (date, dimension, value),
  CHECK (
    (dimension = 'locale' AND cta_visitors IS NOT NULL AND cta_visitors >= 0 AND cta_visitors <= uv)
    OR (dimension <> 'locale' AND cta_visitors IS NULL)
  )
);
