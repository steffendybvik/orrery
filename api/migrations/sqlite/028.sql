
    -- Releases: the versions a project ships (`1.0.0-rc.2`), each with the branch its work gathers on, notes,
    -- and the day it shipped (none while it's being prepared). An issue says which one it ships in
    -- (`ships_in`; `release` is a word SQL keeps), and a project where its code is, to link branches and PRs.
    CREATE TABLE releases (
        project TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        version TEXT NOT NULL,
        branch TEXT,
        notes TEXT,
        shipped_on TEXT,
        created_by TEXT NOT NULL,
        owned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project, version)
    );
    ALTER TABLE issues ADD COLUMN ships_in TEXT;
    ALTER TABLE projects ADD COLUMN repo TEXT;
