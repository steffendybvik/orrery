
    -- A project's schedules: at a time (cron in a timezone, or once `at`) each makes an issue, placed as
    -- `place` (a board column) says, and can ask the project's sessions to pick it up. Runs are kept.
    CREATE TABLE schedules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        notes TEXT,
        cron TEXT,
        at TEXT,
        timezone TEXT NOT NULL,
        place TEXT NOT NULL DEFAULT 'now' CHECK (place IN ('backlog', 'later', 'next', 'now', 'doing')),
        chunk TEXT,
        priority TEXT CHECK (priority IN ('P0', 'P1', 'P2', 'P3')),
        labels TEXT NOT NULL DEFAULT '[]',
        ask INTEGER NOT NULL DEFAULT 0,
        skip_open INTEGER NOT NULL DEFAULT 1,
        enabled INTEGER NOT NULL DEFAULT 1,
        next_run TEXT,
        created_by TEXT NOT NULL,
        owned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK ((cron IS NULL) != (at IS NULL))
    );
    CREATE INDEX schedules_due ON schedules(enabled, next_run);
    CREATE TABLE schedule_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        schedule INTEGER NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
        at TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('made', 'skipped', 'failed')),
        issue TEXT,
        note TEXT
    );
    CREATE INDEX schedule_runs_schedule ON schedule_runs(schedule, id);
    -- The schedule that made an issue, if one did.
    ALTER TABLE issues ADD COLUMN schedule INTEGER;
