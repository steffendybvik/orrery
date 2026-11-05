
    ALTER TABLE schedules ADD COLUMN presets text NOT NULL DEFAULT '[]';
    ALTER TABLE schedules DROP CONSTRAINT schedules_kind_check;
    ALTER TABLE schedules ADD CONSTRAINT schedules_kind_check CHECK (kind IN ('issue', 'message', 'session'));
