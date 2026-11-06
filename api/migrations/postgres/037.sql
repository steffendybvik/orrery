
    INSERT INTO settings (key, value) SELECT 'starts', starts FROM projects WHERE starts IS NOT NULL ORDER BY created_at, id LIMIT 1
        ON CONFLICT (key) DO NOTHING;
    UPDATE projects SET starts = NULL;
