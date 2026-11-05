
    -- A chunk's focus (or the whole project's, chunk 'all') can be narrowed to a release's issues.
    ALTER TABLE signals ADD COLUMN release TEXT;
