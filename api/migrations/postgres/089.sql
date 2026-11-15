
    -- Workspaces (ORR-1105, decision-workspaces step 2), expand only: nothing reads them yet. A workspace holds projects
    -- and, later, all that is the server's today; a person stands above them, a member of each they reach. What's here
    -- goes into one `default` workspace, coloured as the orrery's tint, its owners the server's.
    CREATE TABLE workspaces (
        id text PRIMARY KEY,
        name text NOT NULL,
        color text,
        created_at text NOT NULL
    );
    CREATE TABLE workspace_members (
        workspace text NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
        person text NOT NULL REFERENCES people(id) ON UPDATE CASCADE ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
        role text NOT NULL CHECK (role IN ('owner', 'member')),
        created_at text NOT NULL,
        PRIMARY KEY (workspace, person)
    );
    INSERT INTO workspaces (id, name, color, created_at)
        SELECT 'default', 'Default', (SELECT value::jsonb #>> '{}' FROM settings WHERE key = 'tint' AND jsonb_typeof(value::jsonb) = 'string'),
            COALESCE((SELECT MIN(created_at) FROM projects), to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
    INSERT INTO workspace_members (workspace, person, role, created_at)
        SELECT 'default', id, 'owner', created_at FROM people WHERE role = 'owner';
    ALTER TABLE projects ADD COLUMN workspace text NOT NULL DEFAULT 'default' REFERENCES workspaces(id) DEFERRABLE INITIALLY IMMEDIATE;
    CREATE INDEX projects_workspace ON projects(workspace);
