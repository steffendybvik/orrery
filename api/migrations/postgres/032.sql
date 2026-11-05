
    ALTER TABLE projects ADD COLUMN release_mode text NOT NULL DEFAULT 'none';
    UPDATE projects SET release_mode = 'shared' WHERE releases_from IS NOT NULL;
    UPDATE projects SET release_mode = 'own' WHERE releases_from IS NULL
        AND (id IN (SELECT project FROM releases) OR id IN (SELECT releases_from FROM projects WHERE releases_from IS NOT NULL));
