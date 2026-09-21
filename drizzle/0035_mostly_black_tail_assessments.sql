DELETE FROM `media_tail_assessments`
WHERE `accepted` = 0 AND `result` IN ('not-black', 'uncertain');
