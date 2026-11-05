
    -- Approving a proposal commits it now; those approved before wait no longer: they go on the roadmap, in Todo
    -- if they were still in the backlog, else where their work already took them (started, done).
    UPDATE issues SET proposal = NULL, status = CASE WHEN status IN (SELECT id FROM statuses WHERE kind = 'backlog')
        THEN COALESCE((SELECT id FROM statuses WHERE kind = 'todo' ORDER BY position, id LIMIT 1), status) ELSE status END
        WHERE proposal = 'approved';
