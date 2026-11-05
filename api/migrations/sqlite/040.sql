
    -- A message schedule that skips a run when nothing in its project changed since the last one it sent.
    ALTER TABLE schedules ADD COLUMN only_if_changed INTEGER NOT NULL DEFAULT 0;
