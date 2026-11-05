
    ALTER TABLE issues ADD COLUMN choices text NOT NULL DEFAULT '[]';
    ALTER TABLE issues ADD COLUMN picks text;
    ALTER TABLE issues ADD COLUMN explore text;
