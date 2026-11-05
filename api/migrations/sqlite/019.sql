
    -- A focus on a chunk can be narrowed to its issues of one status ('doing', 'now', …): "work through
    -- the Now issues in chunk 3". Unchecked, so it carries over to statuses a project makes its own.
    ALTER TABLE signals ADD COLUMN status TEXT;
