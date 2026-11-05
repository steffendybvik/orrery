
    -- A schedule across projects (ORR-638): what it says (`body`), and which projects it's for: `*`, or a JSON list, with
    -- `skip` those that opted out of `*`. Each of them has an ordinary schedule made from it, pointing back here.
    CREATE TABLE schedules_across (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        projects TEXT NOT NULL,
        skip TEXT NOT NULL DEFAULT '[]',
        body TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
    );
    ALTER TABLE schedules ADD COLUMN across INTEGER REFERENCES schedules_across(id) ON DELETE CASCADE;
    CREATE UNIQUE INDEX schedules_across_project ON schedules(across, project) WHERE across IS NOT NULL;
