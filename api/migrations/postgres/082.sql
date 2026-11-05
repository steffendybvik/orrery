
    -- A change's risk (ORR-879): high, medium or low, with a line on why, rated by the session that opens the PR. by is
    -- 'owner' once the owner sets it, and then a session's rating doesn't replace it. None on those from before.
    ALTER TABLE issue_pulls ADD COLUMN risk text CHECK (risk IN ('high', 'medium', 'low'));
    ALTER TABLE issue_pulls ADD COLUMN risk_why text;
    ALTER TABLE issue_pulls ADD COLUMN risk_by text;
