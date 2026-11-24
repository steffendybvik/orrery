    -- An issue depending on one in another workspace (ORR-1409): before ORR-1383, depends_on took any project the writer
    -- was on, so a link could name another workspace's project and issue, and the board still showed it, as depends_on,
    -- blocked_by and blocks. Since then such a link can't be made, and an issue holding one couldn't save its
    -- dependencies. Each is taken away.
    DELETE FROM issue_links WHERE EXISTS (
        SELECT 1 FROM projects p JOIN projects o ON o.id = issue_links.on_project
        WHERE p.id = issue_links.project AND p.workspace <> o.workspace);
