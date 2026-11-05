
    -- Releases are arranged by hand, from 0 at the top: they start in the order they had, those being
    -- prepared first, then the shipped ones, latest first.
    ALTER TABLE releases ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
    UPDATE releases SET position = (SELECT n FROM (
        SELECT project, version, row_number() OVER (PARTITION BY project ORDER BY shipped_on IS NOT NULL, shipped_on DESC, created_at DESC, version DESC) - 1 AS n
        FROM releases) o WHERE o.project = releases.project AND o.version = releases.version);
