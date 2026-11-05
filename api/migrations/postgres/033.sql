
    UPDATE issues SET proposal = NULL, status = CASE WHEN status IN (SELECT id FROM statuses WHERE kind = 'backlog')
        THEN COALESCE((SELECT id FROM statuses WHERE kind = 'todo' ORDER BY position, id LIMIT 1), status) ELSE status END
        WHERE proposal = 'approved';
