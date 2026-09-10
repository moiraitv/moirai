UPDATE encoding_profiles SET config = json_set(config, '$.description', CASE id
 WHEN '10000000-0000-4000-8000-000000000480' THEN 'Lowest bandwidth, widest compatibility.'
 WHEN '10000000-0000-4000-8000-000000000576' THEN 'Common for standard definition content.'
 WHEN '10000000-0000-4000-8000-000000000720' THEN 'Smaller files, great for mobile devices.'
 WHEN '10000000-0000-4000-8000-000000001080' THEN 'Best balance of quality and compatibility.'
 WHEN '10000000-0000-4000-8000-000000001440' THEN 'Higher quality for larger screens.'
 WHEN '10000000-0000-4000-8000-000000002160' THEN 'Maximum quality for compatible devices.'
 ELSE '' END) WHERE json_type(config, '$.description') IS NULL;
