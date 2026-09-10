WITH RECURSIVE candidates(n, name) AS (
 SELECT 0, 'Music video credits'
 UNION ALL
 SELECT n + 1, 'Music video credits (built-in ' || (n + 1) || ')' FROM candidates
 WHERE n <= (SELECT COUNT(*) FROM credit_templates)
), available AS (
 SELECT name FROM candidates WHERE NOT EXISTS (
 SELECT 1 FROM credit_templates
 WHERE name_key = lower(candidates.name)
 AND id <> '20000000-0000-4000-8000-000000000001'
 ) ORDER BY n LIMIT 1
)
UPDATE credit_templates
SET name = (SELECT name FROM available), name_key = lower((SELECT name FROM available))
WHERE id = '20000000-0000-4000-8000-000000000001' AND is_builtin = 1;
