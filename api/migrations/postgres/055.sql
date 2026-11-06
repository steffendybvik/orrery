
    -- When the session on an issue took it, for the issue page's banner: kept while the same session works it
    -- again, unlike `at`, which moves on every write (ORR-536).
    ALTER TABLE issue_sessions ADD COLUMN since text;
    UPDATE issue_sessions SET since = at;
