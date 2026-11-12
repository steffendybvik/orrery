
    -- Workspaces (ORR-1105, decision-workspaces step 2), expand only: nothing reads them yet. A workspace holds projects
    -- and, later, all that is the server's today; a person stands above them, a member of each they reach. What's here
    -- goes into one `default` workspace, coloured as the orrery's tint, its owners the server's.
    CREATE TABLE workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        color TEXT,
        created_at TEXT NOT NULL
    );
    CREATE TABLE workspace_members (
        workspace TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        person TEXT NOT NULL REFERENCES people(id) ON UPDATE CASCADE ON DELETE CASCADE,
        role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
        created_at TEXT NOT NULL,
        PRIMARY KEY (workspace, person)
    );
    INSERT INTO workspaces (id, name, color, created_at)
        SELECT 'default', 'Default', (SELECT json_extract(value, '$') FROM settings WHERE key = 'tint' AND json_type(value) = 'text'),
            COALESCE((SELECT MIN(created_at) FROM projects), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
    INSERT INTO workspace_members (workspace, person, role, created_at)
        SELECT 'default', id, 'owner', created_at FROM people WHERE role = 'owner';
    ALTER TABLE projects ADD COLUMN workspace TEXT NOT NULL DEFAULT 'default' REFERENCES workspaces(id);
    CREATE INDEX projects_workspace ON projects(workspace);
