
    -- A message schedule that brings in what others wrote (GitHub issues): its run gets a locked-down session of its own.
    ALTER TABLE schedules ADD COLUMN untrusted INTEGER NOT NULL DEFAULT 0;
