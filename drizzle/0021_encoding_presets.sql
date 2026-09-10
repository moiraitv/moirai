ALTER TABLE encoding_profiles ADD COLUMN is_builtin INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE encoding_profiles ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE UNIQUE INDEX encoding_profiles_one_default ON encoding_profiles(is_default) WHERE is_default = 1;
--> statement-breakpoint
WITH RECURSIVE candidates(n, name) AS (
 SELECT 0, '480p'
 UNION ALL
 SELECT n + 1, '480p (built-in ' || (n + 1) || ')' FROM candidates
 WHERE n <= (SELECT COUNT(*) FROM encoding_profiles)
), available AS (
 SELECT name FROM candidates WHERE NOT EXISTS (
 SELECT 1 FROM encoding_profiles WHERE name_key = lower(candidates.name)
 ) ORDER BY n LIMIT 1
)
INSERT INTO encoding_profiles (id, name, name_key, config, created_at, updated_at, is_builtin, is_default)
SELECT '10000000-0000-4000-8000-000000000480', name, lower(name), json_set('{"name":"480p","audio":{"format":"aac","bitrateKbps":192,"bufferKbps":384,"channels":2,"sampleRateHz":48000,"normalizeLoudness":true,"loudness":{"integratedTarget":-16,"rangeTarget":11,"truePeak":-1.5}},"video":{"format":"h264","bitDepth":8,"width":854,"height":480,"scalingMode":"scale_and_pad","bitrateKbps":1500,"bufferKbps":3000,"accel":"automatic","vaapiDevice":null,"vaapiDriver":null,"deinterlace":false}}', '$.name', name),
 '2026-09-09T00:00:00Z', '2026-09-09T00:00:00Z', 1, 0 FROM available;
--> statement-breakpoint
WITH RECURSIVE candidates(n, name) AS (
 SELECT 0, '576p'
 UNION ALL
 SELECT n + 1, '576p (built-in ' || (n + 1) || ')' FROM candidates
 WHERE n <= (SELECT COUNT(*) FROM encoding_profiles)
), available AS (
 SELECT name FROM candidates WHERE NOT EXISTS (
 SELECT 1 FROM encoding_profiles WHERE name_key = lower(candidates.name)
 ) ORDER BY n LIMIT 1
)
INSERT INTO encoding_profiles (id, name, name_key, config, created_at, updated_at, is_builtin, is_default)
SELECT '10000000-0000-4000-8000-000000000576', name, lower(name), json_set('{"name":"576p","audio":{"format":"aac","bitrateKbps":192,"bufferKbps":384,"channels":2,"sampleRateHz":48000,"normalizeLoudness":true,"loudness":{"integratedTarget":-16,"rangeTarget":11,"truePeak":-1.5}},"video":{"format":"h264","bitDepth":8,"width":1024,"height":576,"scalingMode":"scale_and_pad","bitrateKbps":2000,"bufferKbps":4000,"accel":"automatic","vaapiDevice":null,"vaapiDriver":null,"deinterlace":false}}', '$.name', name),
 '2026-09-09T00:00:00Z', '2026-09-09T00:00:00Z', 1, 0 FROM available;
--> statement-breakpoint
WITH RECURSIVE candidates(n, name) AS (
 SELECT 0, '720p'
 UNION ALL
 SELECT n + 1, '720p (built-in ' || (n + 1) || ')' FROM candidates
 WHERE n <= (SELECT COUNT(*) FROM encoding_profiles)
), available AS (
 SELECT name FROM candidates WHERE NOT EXISTS (
 SELECT 1 FROM encoding_profiles WHERE name_key = lower(candidates.name)
 ) ORDER BY n LIMIT 1
)
INSERT INTO encoding_profiles (id, name, name_key, config, created_at, updated_at, is_builtin, is_default)
SELECT '10000000-0000-4000-8000-000000000720', name, lower(name), json_set('{"name":"720p","audio":{"format":"aac","bitrateKbps":192,"bufferKbps":384,"channels":2,"sampleRateHz":48000,"normalizeLoudness":true,"loudness":{"integratedTarget":-16,"rangeTarget":11,"truePeak":-1.5}},"video":{"format":"h264","bitDepth":8,"width":1280,"height":720,"scalingMode":"scale_and_pad","bitrateKbps":4000,"bufferKbps":8000,"accel":"automatic","vaapiDevice":null,"vaapiDriver":null,"deinterlace":false}}', '$.name', name),
 '2026-09-09T00:00:00Z', '2026-09-09T00:00:00Z', 1, 0 FROM available;
--> statement-breakpoint
WITH RECURSIVE candidates(n, name) AS (
 SELECT 0, '1080p'
 UNION ALL
 SELECT n + 1, '1080p (built-in ' || (n + 1) || ')' FROM candidates
 WHERE n <= (SELECT COUNT(*) FROM encoding_profiles)
), available AS (
 SELECT name FROM candidates WHERE NOT EXISTS (
 SELECT 1 FROM encoding_profiles WHERE name_key = lower(candidates.name)
 ) ORDER BY n LIMIT 1
)
INSERT INTO encoding_profiles (id, name, name_key, config, created_at, updated_at, is_builtin, is_default)
SELECT '10000000-0000-4000-8000-000000001080', name, lower(name), json_set('{"name":"1080p","audio":{"format":"aac","bitrateKbps":192,"bufferKbps":384,"channels":2,"sampleRateHz":48000,"normalizeLoudness":true,"loudness":{"integratedTarget":-16,"rangeTarget":11,"truePeak":-1.5}},"video":{"format":"h264","bitDepth":8,"width":1920,"height":1080,"scalingMode":"scale_and_pad","bitrateKbps":8000,"bufferKbps":16000,"accel":"automatic","vaapiDevice":null,"vaapiDriver":null,"deinterlace":false}}', '$.name', name),
 '2026-09-09T00:00:00Z', '2026-09-09T00:00:00Z', 1, 1 FROM available;
--> statement-breakpoint
WITH RECURSIVE candidates(n, name) AS (
 SELECT 0, '1440p'
 UNION ALL
 SELECT n + 1, '1440p (built-in ' || (n + 1) || ')' FROM candidates
 WHERE n <= (SELECT COUNT(*) FROM encoding_profiles)
), available AS (
 SELECT name FROM candidates WHERE NOT EXISTS (
 SELECT 1 FROM encoding_profiles WHERE name_key = lower(candidates.name)
 ) ORDER BY n LIMIT 1
)
INSERT INTO encoding_profiles (id, name, name_key, config, created_at, updated_at, is_builtin, is_default)
SELECT '10000000-0000-4000-8000-000000001440', name, lower(name), json_set('{"name":"1440p","audio":{"format":"aac","bitrateKbps":192,"bufferKbps":384,"channels":2,"sampleRateHz":48000,"normalizeLoudness":true,"loudness":{"integratedTarget":-16,"rangeTarget":11,"truePeak":-1.5}},"video":{"format":"h264","bitDepth":8,"width":2560,"height":1440,"scalingMode":"scale_and_pad","bitrateKbps":16000,"bufferKbps":32000,"accel":"automatic","vaapiDevice":null,"vaapiDriver":null,"deinterlace":false}}', '$.name', name),
 '2026-09-09T00:00:00Z', '2026-09-09T00:00:00Z', 1, 0 FROM available;
--> statement-breakpoint
WITH RECURSIVE candidates(n, name) AS (
 SELECT 0, '4K'
 UNION ALL
 SELECT n + 1, '4K (built-in ' || (n + 1) || ')' FROM candidates
 WHERE n <= (SELECT COUNT(*) FROM encoding_profiles)
), available AS (
 SELECT name FROM candidates WHERE NOT EXISTS (
 SELECT 1 FROM encoding_profiles WHERE name_key = lower(candidates.name)
 ) ORDER BY n LIMIT 1
)
INSERT INTO encoding_profiles (id, name, name_key, config, created_at, updated_at, is_builtin, is_default)
SELECT '10000000-0000-4000-8000-000000002160', name, lower(name), json_set('{"name":"4K","audio":{"format":"aac","bitrateKbps":192,"bufferKbps":384,"channels":2,"sampleRateHz":48000,"normalizeLoudness":true,"loudness":{"integratedTarget":-16,"rangeTarget":11,"truePeak":-1.5}},"video":{"format":"h264","bitDepth":8,"width":3840,"height":2160,"scalingMode":"scale_and_pad","bitrateKbps":32000,"bufferKbps":64000,"accel":"automatic","vaapiDevice":null,"vaapiDriver":null,"deinterlace":false}}', '$.name', name),
 '2026-09-09T00:00:00Z', '2026-09-09T00:00:00Z', 1, 0 FROM available;
