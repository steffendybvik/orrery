
    -- Each board and the server get a random id, for the full form of ids (ORR-674): 8 characters of base32.
    ALTER TABLE projects ADD COLUMN uid text NOT NULL DEFAULT '';
    UPDATE projects SET uid = (
        SELECT string_agg(substr('abcdefghijklmnopqrstuvwxyz234567', floor(random() * 32)::int + 1, 1), '')
        FROM generate_series(1, 8) WHERE projects.id IS NOT NULL
    );
    INSERT INTO settings (key, value) SELECT 'uid', '"' || string_agg(substr('abcdefghijklmnopqrstuvwxyz234567', floor(random() * 32)::int + 1, 1), '') || '"' FROM generate_series(1, 8);
