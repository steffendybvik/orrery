
    -- What an event schedule's minute held back (ORR-357): the event that would have run it for this subject, as JSON,
    -- run in its turn if it still fits. One for each schedule and subject, the latest.
    CREATE TABLE schedule_held (
        schedule integer NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
        subject text NOT NULL,
        event text NOT NULL,
        at text NOT NULL,
        PRIMARY KEY (schedule, subject)
    );
