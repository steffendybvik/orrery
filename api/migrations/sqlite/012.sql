
    -- A schedule can send a message to the project's sessions instead of making an issue. A message
    -- signal is about neither an issue nor a chunk, and names the schedule that sent it; its run is 'sent'.
    ALTER TABLE schedules ADD COLUMN kind TEXT NOT NULL DEFAULT 'issue' CHECK (kind IN ('issue', 'message'));
    CREATE TABLE signals_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        issue TEXT,
        chunk TEXT,
        schedule INTEGER,
        kind TEXT NOT NULL CHECK (kind IN ('focus', 'comment', 'message')),
        note TEXT,
        created_by TEXT NOT NULL,
        owned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        target TEXT,
        delivered_to TEXT NOT NULL DEFAULT '[]',
        CHECK (kind = 'message' OR (issue IS NULL) != (chunk IS NULL))
    );
    INSERT INTO signals_new (id, project, issue, chunk, kind, note, created_by, owned, created_at, target, delivered_to)
        SELECT id, project, issue, chunk, kind, note, created_by, owned, created_at, target, delivered_to FROM signals;
    DROP TABLE signals;
    ALTER TABLE signals_new RENAME TO signals;
    CREATE INDEX signals_project ON signals(project, id);
    CREATE TABLE schedule_runs_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        schedule INTEGER NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
        at TEXT NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('made', 'sent', 'skipped', 'failed')),
        issue TEXT,
        note TEXT
    );
    INSERT INTO schedule_runs_new SELECT * FROM schedule_runs;
    DROP TABLE schedule_runs;
    ALTER TABLE schedule_runs_new RENAME TO schedule_runs;
    CREATE INDEX schedule_runs_schedule ON schedule_runs(schedule, id);
