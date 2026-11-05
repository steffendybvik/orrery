
    CREATE TABLE releases (
        project text NOT NULL REFERENCES projects(id) ON DELETE CASCADE DEFERRABLE INITIALLY IMMEDIATE,
        version text NOT NULL,
        branch text,
        notes text,
        shipped_on text,
        created_by text NOT NULL,
        owned integer NOT NULL DEFAULT 0,
        created_at text NOT NULL,
        updated_at text NOT NULL,
        PRIMARY KEY (project, version)
    );
    ALTER TABLE issues ADD COLUMN ships_in text;
    ALTER TABLE projects ADD COLUMN repo text;
