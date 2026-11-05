
    -- A signal can be for one session, and records the sessions it reached (a JSON list of names).
    ALTER TABLE signals ADD COLUMN target TEXT;
    ALTER TABLE signals ADD COLUMN delivered_to TEXT NOT NULL DEFAULT '[]';
