UPDATE `libraries`
SET `accepted_source_identity` = json_object(
	'sourceType', json_extract(`accepted_source_identity`, '$.sourceType'),
	'sourceKey', json_extract(`accepted_source_identity`, '$.canonicalRoot'),
	'details', json_object(
		'canonicalRoot', json_extract(`accepted_source_identity`, '$.canonicalRoot'),
		'device', json_extract(`accepted_source_identity`, '$.device'),
		'inode', json_extract(`accepted_source_identity`, '$.inode')
	)
)
WHERE `accepted_source_identity` IS NOT NULL
	AND json_extract(`accepted_source_identity`, '$.sourceKey') IS NULL;
--> statement-breakpoint
UPDATE `libraries`
SET `candidate_source_identity` = json_object(
	'sourceType', json_extract(`candidate_source_identity`, '$.sourceType'),
	'sourceKey', json_extract(`candidate_source_identity`, '$.canonicalRoot'),
	'details', json_object(
		'canonicalRoot', json_extract(`candidate_source_identity`, '$.canonicalRoot'),
		'device', json_extract(`candidate_source_identity`, '$.device'),
		'inode', json_extract(`candidate_source_identity`, '$.inode')
	)
)
WHERE `candidate_source_identity` IS NOT NULL
	AND json_extract(`candidate_source_identity`, '$.sourceKey') IS NULL;
