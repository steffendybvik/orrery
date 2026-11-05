
    -- What an event in the log is about (ORR-378): the issue, release, chunk or doc a change to the roadmap was to.
    ALTER TABLE events ADD COLUMN subject TEXT;
