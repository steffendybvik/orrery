
    -- Whether orrery may start sessions for the project itself, without a terminal: a JSON {limit, minutes}
    -- (at most `limit` running at once, each stopped after `minutes`), none while the owner hasn't let it.
    ALTER TABLE projects ADD COLUMN starts TEXT;
