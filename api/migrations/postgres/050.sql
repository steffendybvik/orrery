
    CREATE TABLE proposal_clears (
        project text NOT NULL,
        issue text NOT NULL,
        put_up text NOT NULL,
        cleared_at text NOT NULL,
        PRIMARY KEY (project, issue, put_up),
        FOREIGN KEY (project, issue) REFERENCES issues(project, id) ON DELETE CASCADE ON UPDATE CASCADE DEFERRABLE INITIALLY IMMEDIATE
    );
