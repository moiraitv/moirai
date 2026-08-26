UPDATE `schedule_slots`
SET `filler` = '{"mode":"disabled"}'
WHERE `program_id` IS NULL AND json_extract(`filler`, '$.mode') <> 'disabled';
