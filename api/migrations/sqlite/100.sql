    -- A board that takes its releases from a project in another workspace (ORR-1382): a board upload kept the link
    -- unchecked, and so did PATCH /projects before ORR-1350, so one workspace's releases were served on another's board
    -- and its issues counted in them. Each such board gets no releases, as one with an unknown source does on upload,
    -- and its issues leave the releases they were set for.
    UPDATE issues SET ships_in = NULL WHERE ships_in IS NOT NULL AND project IN (
        SELECT p.id FROM projects p JOIN projects s ON s.id = p.releases_from WHERE p.workspace <> s.workspace);
    UPDATE projects SET release_mode = 'none', releases_from = NULL WHERE id IN (
        SELECT p.id FROM projects p JOIN projects s ON s.id = p.releases_from WHERE p.workspace <> s.workspace);
