
    -- Letting orrery start sessions is the owner's one setting, not each project's: the first project that had it
    -- passes its limits on, and the projects' own are let go.
    INSERT INTO settings (key, value) SELECT 'starts', starts FROM projects WHERE starts IS NOT NULL ORDER BY created_at, id LIMIT 1
        ON CONFLICT (key) DO NOTHING;
    UPDATE projects SET starts = NULL;
