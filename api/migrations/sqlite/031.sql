
    -- An issue's tasks on the team's tracker: a JSON list of ids or URLs.
    ALTER TABLE issues ADD COLUMN external TEXT NOT NULL DEFAULT '[]';
