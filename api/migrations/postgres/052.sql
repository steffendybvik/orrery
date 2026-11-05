
    ALTER TABLE comments ADD COLUMN session_name text;
    ALTER TABLE issue_events ADD COLUMN session_name text;
    ALTER TABLE issues ADD COLUMN session_name text;
