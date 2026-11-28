    -- Status ids are unique per workspace, not across the server (ORR-1442): a status is keyed by (workspace, id), and
    -- another workspace's ids lose the workspace's id in front (`work-in-review` becomes `in-review`), where they meet
    -- nothing of that id in the workspace already and don't become `proposed`. What points at them follows: issues,
    -- schedules (`place`, `move_from`), schedules across projects, focus signals and status activity. The old id still
    -- resolves, as an alias the API works out. An issue's or a schedule's status can't reference the id alone now, so
    -- issues and schedules are rebuilt without that reference; the API checks a status is the workspace's.
    CREATE TABLE status_renames AS
        SELECT s.workspace AS workspace, s.id AS old, substr(s.id, length(s.workspace) + 2) AS new FROM statuses s
        WHERE s.workspace <> 'default' AND substr(s.id, 1, length(s.workspace) + 1) = s.workspace || '-'
            AND substr(s.id, length(s.workspace) + 2) NOT IN ('', 'proposed')
            AND NOT EXISTS (SELECT 1 FROM statuses o WHERE o.workspace = s.workspace AND o.id = substr(s.id, length(s.workspace) + 2));

    CREATE TABLE issues_new (
        project TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        id TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'backlog',
        priority TEXT CHECK (priority IN ('P0', 'P1', 'P2', 'P3')),
        assignee TEXT,
        labels TEXT NOT NULL DEFAULT '[]',
        notes TEXT,
        parent TEXT,
        milestone TEXT,
        position REAL NOT NULL,
        created_by TEXT NOT NULL,
        owned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        schedule INTEGER,
        proposal TEXT CHECK (proposal IN ('pending', 'approved', 'changes', 'rejected')),
        decided_by TEXT,
        decided_at TEXT,
        decision_note TEXT, choices TEXT NOT NULL DEFAULT '[]', picks TEXT, explore TEXT, ships_in TEXT, external TEXT NOT NULL DEFAULT '[]', session_name TEXT, github_issues TEXT NOT NULL DEFAULT '[]', claimed_by TEXT, claimed_at TEXT, claimed_session TEXT, created_person TEXT, model TEXT, effort TEXT, epic INTEGER,
        PRIMARY KEY (project, id),
        FOREIGN KEY (project, parent) REFERENCES "issues"(project, id) ON DELETE CASCADE,
        FOREIGN KEY (project, milestone) REFERENCES "milestones"(project, id)
    );
    INSERT INTO issues_new (project, id, title, status, priority, assignee, labels, notes, parent, milestone, position, created_by, owned,
            created_at, updated_at, schedule, proposal, decided_by, decided_at, decision_note, choices, picks, explore, ships_in, external,
            session_name, github_issues, claimed_by, claimed_at, claimed_session, created_person, model, effort, epic)
        SELECT project, id, title, status, priority, assignee, labels, notes, parent, milestone, position, created_by, owned,
            created_at, updated_at, schedule, proposal, decided_by, decided_at, decision_note, choices, picks, explore, ships_in, external,
            session_name, github_issues, claimed_by, claimed_at, claimed_session, created_person, model, effort, epic FROM issues;
    DROP TABLE issues;
    ALTER TABLE issues_new RENAME TO issues;
    CREATE INDEX issues_parent ON issues(project, parent);
    CREATE INDEX issues_epic ON issues (epic) WHERE epic IS NOT NULL;

    CREATE TABLE schedules_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        title TEXT NOT NULL,
        notes TEXT,
        cron TEXT,
        at TEXT,
        timezone TEXT NOT NULL,
        place TEXT NOT NULL DEFAULT 'todo',
        milestone TEXT,
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
        move_from TEXT NOT NULL DEFAULT '[]', across INTEGER REFERENCES schedules_across(id) ON DELETE CASCADE, model TEXT, effort TEXT,
        CHECK ((cron IS NOT NULL) + (at IS NOT NULL) + (on_event IS NOT NULL) = 1)
    );
    INSERT INTO schedules_new (id, project, title, notes, cron, at, timezone, place, milestone, priority, labels, ask, skip_open, enabled,
            next_run, created_by, owned, created_at, updated_at, kind, only_if_changed, untrusted, on_event, on_filter, presets, move_from,
            across, model, effort)
        SELECT id, project, title, notes, cron, at, timezone, place, milestone, priority, labels, ask, skip_open, enabled,
            next_run, created_by, owned, created_at, updated_at, kind, only_if_changed, untrusted, on_event, on_filter, presets, move_from,
            across, model, effort FROM schedules;
    -- A deleted schedule's id isn't handed out again: an issue it made still names it.
    DELETE FROM sqlite_sequence WHERE name = 'schedules_new';
    INSERT INTO sqlite_sequence (name, seq) SELECT 'schedules_new', seq FROM sqlite_sequence WHERE name = 'schedules';
    DROP TABLE schedules;
    ALTER TABLE schedules_new RENAME TO schedules;
    CREATE INDEX schedules_due ON schedules(enabled, next_run);
    CREATE UNIQUE INDEX schedules_across_project ON schedules(across, project) WHERE across IS NOT NULL;

    CREATE TABLE statuses_new (
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('backlog', 'todo', 'started', 'done', 'canceled')),
        color TEXT NOT NULL,
        position REAL NOT NULL,
        workspace TEXT NOT NULL DEFAULT 'default' REFERENCES workspaces(id),
        PRIMARY KEY (workspace, id)
    );
    INSERT INTO statuses_new (id, name, kind, color, position, workspace)
        SELECT coalesce(r.new, s.id), s.name, s.kind, s.color, s.position, s.workspace FROM statuses s
        LEFT JOIN status_renames r ON r.workspace = s.workspace AND r.old = s.id;
    DROP TABLE statuses;
    ALTER TABLE statuses_new RENAME TO statuses;

    UPDATE issues SET status = (SELECT r.new FROM status_renames r JOIN projects p ON p.workspace = r.workspace WHERE p.id = issues.project AND r.old = issues.status)
        WHERE EXISTS (SELECT 1 FROM status_renames r JOIN projects p ON p.workspace = r.workspace WHERE p.id = issues.project AND r.old = issues.status);
    UPDATE schedules SET place = (SELECT r.new FROM status_renames r JOIN projects p ON p.workspace = r.workspace WHERE p.id = schedules.project AND r.old = schedules.place)
        WHERE EXISTS (SELECT 1 FROM status_renames r JOIN projects p ON p.workspace = r.workspace WHERE p.id = schedules.project AND r.old = schedules.place);
    UPDATE schedules SET move_from = (SELECT json_group_array(coalesce(r.new, j.value)) FROM json_each(schedules.move_from) j
            LEFT JOIN projects p ON p.id = schedules.project LEFT JOIN status_renames r ON r.workspace = p.workspace AND r.old = j.value)
        WHERE EXISTS (SELECT 1 FROM json_each(schedules.move_from) j JOIN projects p ON p.id = schedules.project
            JOIN status_renames r ON r.workspace = p.workspace AND r.old = j.value);
    UPDATE schedules_across SET body = json_set(body, '$.column',
            (SELECT r.new FROM status_renames r WHERE r.workspace = schedules_across.workspace AND r.old = json_extract(schedules_across.body, '$.column')))
        WHERE EXISTS (SELECT 1 FROM status_renames r WHERE r.workspace = schedules_across.workspace AND r.old = json_extract(schedules_across.body, '$.column'));
    UPDATE schedules_across SET body = json_set(body, '$.move_from', json((SELECT json_group_array(coalesce(r.new, j.value))
            FROM json_each(schedules_across.body, '$.move_from') j LEFT JOIN status_renames r ON r.workspace = schedules_across.workspace AND r.old = j.value)))
        WHERE EXISTS (SELECT 1 FROM json_each(schedules_across.body, '$.move_from') j
            JOIN status_renames r ON r.workspace = schedules_across.workspace AND r.old = j.value);
    UPDATE signals SET status = (SELECT r.new FROM status_renames r JOIN projects p ON p.workspace = r.workspace WHERE p.id = signals.project AND r.old = signals.status)
        WHERE EXISTS (SELECT 1 FROM status_renames r JOIN projects p ON p.workspace = r.workspace WHERE p.id = signals.project AND r.old = signals.status);
    UPDATE issue_events SET "before" = (SELECT r.new FROM status_renames r JOIN projects p ON p.workspace = r.workspace WHERE p.id = issue_events.project AND r.old = issue_events."before")
        WHERE field = 'status' AND EXISTS (SELECT 1 FROM status_renames r JOIN projects p ON p.workspace = r.workspace WHERE p.id = issue_events.project AND r.old = issue_events."before");
    UPDATE issue_events SET "after" = (SELECT r.new FROM status_renames r JOIN projects p ON p.workspace = r.workspace WHERE p.id = issue_events.project AND r.old = issue_events."after")
        WHERE field = 'status' AND EXISTS (SELECT 1 FROM status_renames r JOIN projects p ON p.workspace = r.workspace WHERE p.id = issue_events.project AND r.old = issue_events."after");
    DROP TABLE status_renames;
