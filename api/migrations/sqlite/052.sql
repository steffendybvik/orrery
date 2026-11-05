
    -- The name of the session that wrote it (ORR-466), as it was then: the page shows it instead of Agent, and sessions
    -- are forgotten after a while, so it's kept with the write.
    ALTER TABLE comments ADD COLUMN session_name TEXT;
    ALTER TABLE issue_events ADD COLUMN session_name TEXT;
    ALTER TABLE issues ADD COLUMN session_name TEXT;
