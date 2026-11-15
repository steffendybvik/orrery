    -- A board held out of pick lists (ORR-1224): when it was uploaded from a file (POST /api/boards), whose Todo titles
    -- nobody has checked yet. While it's set, no session is handed its issues: not in a pick list, a Todo hand-out or
    -- `next`. The owner lifts it on the board's Settings ("Let sessions pick from this board"), which clears it.
    ALTER TABLE projects ADD COLUMN picks_held TEXT;
