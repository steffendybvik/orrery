
    ALTER TABLE releases ADD COLUMN position integer NOT NULL DEFAULT 0;
    UPDATE releases SET position = (SELECT n FROM (
        SELECT project, version, row_number() OVER (PARTITION BY project ORDER BY shipped_on IS NOT NULL, shipped_on DESC, created_at DESC, version DESC) - 1 AS n
        FROM releases) o WHERE o.project = releases.project AND o.version = releases.version);
