
    -- A board's holder and members (ORR-654). Each board has one holder, the owner for those already here. The server's
    -- owner is on every board without a row.
    CREATE TABLE project_members (
        project text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        person text NOT NULL,
        role text NOT NULL CHECK (role IN ('owner', 'member')),
        created_at text NOT NULL,
        PRIMARY KEY (project, person)
    );
    CREATE UNIQUE INDEX project_members_one_holder ON project_members(project) WHERE role = 'owner';
    INSERT INTO project_members (project, person, role, created_at)
        SELECT projects.id, people.id, 'owner', projects.created_at FROM projects, people WHERE people.role = 'owner';
