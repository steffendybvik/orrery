
    -- Who resolved an event in the log when it wasn't the owner (ORR-420): the bell still shows it until they look.
    ALTER TABLE events ADD COLUMN resolved_by TEXT;
