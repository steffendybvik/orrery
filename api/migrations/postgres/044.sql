
    ALTER TABLE schedules ADD COLUMN on_event text;
    ALTER TABLE schedules ADD COLUMN on_filter text;
    ALTER TABLE schedules DROP CONSTRAINT schedules_check;
    ALTER TABLE schedules ADD CONSTRAINT schedules_when CHECK ((cron IS NOT NULL)::int + (at IS NOT NULL)::int + (on_event IS NOT NULL)::int = 1);
    ALTER TABLE schedule_runs ADD COLUMN subject text;
