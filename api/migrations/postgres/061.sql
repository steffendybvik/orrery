
    -- A schedule that moves issues itself (ORR-636), and the statuses (ids or kinds, JSON) it moves them out of.
    ALTER TABLE schedules DROP CONSTRAINT schedules_kind_check;
    ALTER TABLE schedules ADD CONSTRAINT schedules_kind_check CHECK (kind IN ('issue', 'message', 'session', 'action'));
    ALTER TABLE schedules ADD COLUMN move_from text NOT NULL DEFAULT '[]';
