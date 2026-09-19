ALTER TABLE `libraries` ADD `item_count` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
UPDATE `libraries` SET `item_count` = (
	SELECT count(*) FROM `media_items` WHERE `media_items`.`library_id` = `libraries`.`id`
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS catalog_search_defer (
	defer INTEGER NOT NULL
);
--> statement-breakpoint
DROP TRIGGER IF EXISTS catalog_search_groups_ai;
--> statement-breakpoint
DROP TRIGGER IF EXISTS catalog_search_groups_au;
--> statement-breakpoint
DROP TRIGGER IF EXISTS catalog_search_groups_au_children;
--> statement-breakpoint
DROP TRIGGER IF EXISTS catalog_search_groups_ad;
--> statement-breakpoint
DROP TRIGGER IF EXISTS catalog_search_items_ai;
--> statement-breakpoint
DROP TRIGGER IF EXISTS catalog_search_items_au;
--> statement-breakpoint
DROP TRIGGER IF EXISTS catalog_search_items_ad;
--> statement-breakpoint
DROP TRIGGER IF EXISTS catalog_search_people_ai;
--> statement-breakpoint
DROP TRIGGER IF EXISTS catalog_search_people_ad;
--> statement-breakpoint
DROP TRIGGER IF EXISTS catalog_search_genres_ai;
--> statement-breakpoint
DROP TRIGGER IF EXISTS catalog_search_genres_ad;
--> statement-breakpoint
CREATE TRIGGER catalog_search_groups_ai AFTER INSERT ON media_groups
WHEN NOT EXISTS (SELECT 1 FROM catalog_search_defer)
BEGIN
	INSERT INTO catalog_search(library_id, entity_id, entity_kind, body)
	VALUES (NEW.library_id, NEW.id, 'group', trim(NEW.title || ' ' || COALESCE(NEW.plot, '')));
END;
--> statement-breakpoint
CREATE TRIGGER catalog_search_groups_au AFTER UPDATE ON media_groups
WHEN NOT EXISTS (SELECT 1 FROM catalog_search_defer)
AND (OLD.title IS NOT NEW.title OR OLD.plot IS NOT NEW.plot)
BEGIN
	DELETE FROM catalog_search WHERE entity_id = OLD.id AND entity_kind = 'group';
	INSERT INTO catalog_search(library_id, entity_id, entity_kind, body)
	VALUES (NEW.library_id, NEW.id, 'group', trim(NEW.title || ' ' || COALESCE(NEW.plot, '')));
END;
--> statement-breakpoint
CREATE TRIGGER catalog_search_groups_au_children AFTER UPDATE ON media_groups
WHEN NOT EXISTS (SELECT 1 FROM catalog_search_defer)
AND OLD.title IS NOT NEW.title
BEGIN
	DELETE FROM catalog_search WHERE entity_kind = 'item' AND entity_id IN (
		SELECT i.id FROM media_items i
		LEFT JOIN media_groups g ON g.id = i.group_id
		WHERE i.group_id = NEW.id OR g.parent_id = NEW.id
	);
	INSERT INTO catalog_search(library_id, entity_id, entity_kind, body)
	SELECT i.library_id, i.id, 'item', trim(
		i.title || ' ' || COALESCE(i.plot, '') || ' ' ||
		COALESCE((SELECT title FROM media_groups WHERE id = i.group_id), '') || ' ' ||
		COALESCE((SELECT parent.title FROM media_groups g JOIN media_groups parent ON parent.id = g.parent_id WHERE g.id = i.group_id), '') || ' ' ||
		COALESCE((SELECT group_concat(name || ' ' || normalized_name, ' ') FROM media_item_people WHERE item_id = i.id), '') || ' ' ||
		COALESCE((SELECT group_concat(genre_name || ' ' || genre_key, ' ') FROM media_item_genres WHERE item_id = i.id), '')
	)
	FROM media_items i
	LEFT JOIN media_groups g ON g.id = i.group_id
	WHERE i.group_id = NEW.id OR g.parent_id = NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER catalog_search_groups_ad AFTER DELETE ON media_groups
WHEN NOT EXISTS (SELECT 1 FROM catalog_search_defer)
BEGIN
	DELETE FROM catalog_search WHERE entity_id = OLD.id AND entity_kind = 'group';
	DELETE FROM catalog_search WHERE entity_kind = 'item' AND entity_id IN (
		SELECT i.id FROM media_items i
		LEFT JOIN media_groups g ON g.id = i.group_id
		WHERE i.group_id = OLD.id OR g.parent_id = OLD.id
	);
	INSERT INTO catalog_search(library_id, entity_id, entity_kind, body)
	SELECT i.library_id, i.id, 'item', trim(
		i.title || ' ' || COALESCE(i.plot, '') || ' ' ||
		COALESCE((SELECT title FROM media_groups WHERE id = i.group_id), '') || ' ' ||
		COALESCE((SELECT parent.title FROM media_groups g JOIN media_groups parent ON parent.id = g.parent_id WHERE g.id = i.group_id), '') || ' ' ||
		COALESCE((SELECT group_concat(name || ' ' || normalized_name, ' ') FROM media_item_people WHERE item_id = i.id), '') || ' ' ||
		COALESCE((SELECT group_concat(genre_name || ' ' || genre_key, ' ') FROM media_item_genres WHERE item_id = i.id), '')
	)
	FROM media_items i
	LEFT JOIN media_groups g ON g.id = i.group_id
	WHERE i.group_id = OLD.id OR g.parent_id = OLD.id;
END;
--> statement-breakpoint
CREATE TRIGGER catalog_search_items_ai AFTER INSERT ON media_items
WHEN NOT EXISTS (SELECT 1 FROM catalog_search_defer)
BEGIN
	INSERT INTO catalog_search(library_id, entity_id, entity_kind, body)
	VALUES (
		NEW.library_id, NEW.id, 'item',
		trim(NEW.title || ' ' || COALESCE(NEW.plot, '') || ' ' ||
			COALESCE((SELECT title FROM media_groups WHERE id = NEW.group_id), '') || ' ' ||
			COALESCE((SELECT parent.title FROM media_groups g JOIN media_groups parent ON parent.id = g.parent_id WHERE g.id = NEW.group_id), '') || ' ' ||
			COALESCE((SELECT group_concat(name || ' ' || normalized_name, ' ') FROM media_item_people WHERE item_id = NEW.id), '') || ' ' ||
			COALESCE((SELECT group_concat(genre_name || ' ' || genre_key, ' ') FROM media_item_genres WHERE item_id = NEW.id), ''))
	);
END;
--> statement-breakpoint
CREATE TRIGGER catalog_search_items_au AFTER UPDATE ON media_items
WHEN NOT EXISTS (SELECT 1 FROM catalog_search_defer)
AND (OLD.title IS NOT NEW.title OR OLD.plot IS NOT NEW.plot OR OLD.group_id IS NOT NEW.group_id)
BEGIN
	DELETE FROM catalog_search WHERE entity_id = OLD.id AND entity_kind = 'item';
	INSERT INTO catalog_search(library_id, entity_id, entity_kind, body)
	VALUES (
		NEW.library_id, NEW.id, 'item',
		trim(NEW.title || ' ' || COALESCE(NEW.plot, '') || ' ' ||
			COALESCE((SELECT title FROM media_groups WHERE id = NEW.group_id), '') || ' ' ||
			COALESCE((SELECT parent.title FROM media_groups g JOIN media_groups parent ON parent.id = g.parent_id WHERE g.id = NEW.group_id), '') || ' ' ||
			COALESCE((SELECT group_concat(name || ' ' || normalized_name, ' ') FROM media_item_people WHERE item_id = NEW.id), '') || ' ' ||
			COALESCE((SELECT group_concat(genre_name || ' ' || genre_key, ' ') FROM media_item_genres WHERE item_id = NEW.id), ''))
	);
END;
--> statement-breakpoint
CREATE TRIGGER catalog_search_items_ad AFTER DELETE ON media_items
WHEN NOT EXISTS (SELECT 1 FROM catalog_search_defer)
BEGIN
	DELETE FROM catalog_search WHERE entity_id = OLD.id AND entity_kind = 'item';
END;
--> statement-breakpoint
CREATE TRIGGER catalog_search_people_ai AFTER INSERT ON media_item_people
WHEN NOT EXISTS (SELECT 1 FROM catalog_search_defer)
BEGIN
	DELETE FROM catalog_search WHERE entity_id = NEW.item_id AND entity_kind = 'item';
	INSERT INTO catalog_search(library_id, entity_id, entity_kind, body)
	SELECT i.library_id, i.id, 'item', trim(
		i.title || ' ' || COALESCE(i.plot, '') || ' ' ||
		COALESCE((SELECT title FROM media_groups WHERE id = i.group_id), '') || ' ' ||
		COALESCE((SELECT parent.title FROM media_groups g JOIN media_groups parent ON parent.id = g.parent_id WHERE g.id = i.group_id), '') || ' ' ||
		COALESCE((SELECT group_concat(name || ' ' || normalized_name, ' ') FROM media_item_people WHERE item_id = i.id), '') || ' ' ||
		COALESCE((SELECT group_concat(genre_name || ' ' || genre_key, ' ') FROM media_item_genres WHERE item_id = i.id), '')
	)
	FROM media_items i WHERE i.id = NEW.item_id;
END;
--> statement-breakpoint
CREATE TRIGGER catalog_search_people_ad AFTER DELETE ON media_item_people
WHEN NOT EXISTS (SELECT 1 FROM catalog_search_defer)
BEGIN
	DELETE FROM catalog_search WHERE entity_id = OLD.item_id AND entity_kind = 'item';
	INSERT INTO catalog_search(library_id, entity_id, entity_kind, body)
	SELECT i.library_id, i.id, 'item', trim(
		i.title || ' ' || COALESCE(i.plot, '') || ' ' ||
		COALESCE((SELECT title FROM media_groups WHERE id = i.group_id), '') || ' ' ||
		COALESCE((SELECT parent.title FROM media_groups g JOIN media_groups parent ON parent.id = g.parent_id WHERE g.id = i.group_id), '') || ' ' ||
		COALESCE((SELECT group_concat(name || ' ' || normalized_name, ' ') FROM media_item_people WHERE item_id = i.id), '') || ' ' ||
		COALESCE((SELECT group_concat(genre_name || ' ' || genre_key, ' ') FROM media_item_genres WHERE item_id = i.id), '')
	)
	FROM media_items i WHERE i.id = OLD.item_id;
END;
--> statement-breakpoint
CREATE TRIGGER catalog_search_genres_ai AFTER INSERT ON media_item_genres
WHEN NOT EXISTS (SELECT 1 FROM catalog_search_defer)
BEGIN
	DELETE FROM catalog_search WHERE entity_id = NEW.item_id AND entity_kind = 'item';
	INSERT INTO catalog_search(library_id, entity_id, entity_kind, body)
	SELECT i.library_id, i.id, 'item', trim(
		i.title || ' ' || COALESCE(i.plot, '') || ' ' ||
		COALESCE((SELECT title FROM media_groups WHERE id = i.group_id), '') || ' ' ||
		COALESCE((SELECT parent.title FROM media_groups g JOIN media_groups parent ON parent.id = g.parent_id WHERE g.id = i.group_id), '') || ' ' ||
		COALESCE((SELECT group_concat(name || ' ' || normalized_name, ' ') FROM media_item_people WHERE item_id = i.id), '') || ' ' ||
		COALESCE((SELECT group_concat(genre_name || ' ' || genre_key, ' ') FROM media_item_genres WHERE item_id = i.id), '')
	)
	FROM media_items i WHERE i.id = NEW.item_id;
END;
--> statement-breakpoint
CREATE TRIGGER catalog_search_genres_ad AFTER DELETE ON media_item_genres
WHEN NOT EXISTS (SELECT 1 FROM catalog_search_defer)
BEGIN
	DELETE FROM catalog_search WHERE entity_id = OLD.item_id AND entity_kind = 'item';
	INSERT INTO catalog_search(library_id, entity_id, entity_kind, body)
	SELECT i.library_id, i.id, 'item', trim(
		i.title || ' ' || COALESCE(i.plot, '') || ' ' ||
		COALESCE((SELECT title FROM media_groups WHERE id = i.group_id), '') || ' ' ||
		COALESCE((SELECT parent.title FROM media_groups g JOIN media_groups parent ON parent.id = g.parent_id WHERE g.id = i.group_id), '') || ' ' ||
		COALESCE((SELECT group_concat(name || ' ' || normalized_name, ' ') FROM media_item_people WHERE item_id = i.id), '') || ' ' ||
		COALESCE((SELECT group_concat(genre_name || ' ' || genre_key, ' ') FROM media_item_genres WHERE item_id = i.id), '')
	)
	FROM media_items i WHERE i.id = OLD.item_id;
END;
