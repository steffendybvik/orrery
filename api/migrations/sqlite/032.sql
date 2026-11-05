
    -- Not every project ships: one has no releases, its own, or another's (`releases_from`). Those with
    -- releases, or others drawing on them, keep their own; the rest have none until they're turned on.
    ALTER TABLE projects ADD COLUMN release_mode TEXT NOT NULL DEFAULT 'none';
    UPDATE projects SET release_mode = 'shared' WHERE releases_from IS NOT NULL;
    UPDATE projects SET release_mode = 'own' WHERE releases_from IS NULL
        AND (id IN (SELECT project FROM releases) OR id IN (SELECT releases_from FROM projects WHERE releases_from IS NOT NULL));
