
    -- A schedule that moves issues itself (ORR-636), and the statuses (ids or kinds, JSON) it moves them out of. Rebuilt
    -- for its kind's check.
    CREATE TABLE schedules_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        notes TEXT,
        cron TEXT,
        at TEXT,
        timezone TEXT NOT NULL,
        place TEXT NOT NULL DEFAULT 'todo' REFERENCES statuses(id),
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
        kind TEXT NOT NULL DEFAULT 'issue' CHECK (kind IN ('issue', 'message', 'session', 'action')),
        only_if_changed INTEGER NOT NULL DEFAULT 0,
        untrusted INTEGER NOT NULL DEFAULT 0,
        on_event TEXT,
        on_filter TEXT,
        presets TEXT NOT NULL DEFAULT '[]',
        move_from TEXT NOT NULL DEFAULT '[]',
        CHECK ((cron IS NOT NULL) + (at IS NOT NULL) + (on_event IS NOT NULL) = 1)
    );
    INSERT INTO schedules_new (id, project, title, notes, cron, at, timezone, place, chunk, priority, labels, ask, skip_open, enabled, next_run,
        created_by, owned, created_at, updated_at, kind, only_if_changed, untrusted, on_event, on_filter, presets)
        SELECT id, project, title, notes, cron, at, timezone, place, chunk, priority, labels, ask, skip_open, enabled, next_run,
        created_by, owned, created_at, updated_at, kind, only_if_changed, untrusted, on_event, on_filter, presets FROM schedules;
    DROP TABLE schedules;
    ALTER TABLE schedules_new RENAME TO schedules;
    CREATE INDEX schedules_due ON schedules(enabled, next_run);
