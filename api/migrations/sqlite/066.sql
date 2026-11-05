
    -- Who holds an issue (ORR-655): the person who took it up and when, and the session on it, each taken with a
    -- conditional write; and whose agent made it.
    ALTER TABLE issues ADD COLUMN claimed_by TEXT;
    ALTER TABLE issues ADD COLUMN claimed_at TEXT;
    ALTER TABLE issues ADD COLUMN claimed_session TEXT;
    ALTER TABLE issues ADD COLUMN created_person TEXT;
