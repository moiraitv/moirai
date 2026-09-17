CREATE VIRTUAL TABLE `catalog_search` USING fts5(
	library_id UNINDEXED,
	entity_id UNINDEXED,
	entity_kind UNINDEXED,
	body,
	tokenize = 'unicode61 remove_diacritics 2'
);
--> statement-breakpoint
INSERT INTO catalog_search(library_id, entity_id, entity_kind, body)
SELECT library_id, id, 'group', trim(title || ' ' || COALESCE(plot, ''))
FROM media_groups;
--> statement-breakpoint
INSERT INTO catalog_search(library_id, entity_id, entity_kind, body)
SELECT i.library_id, i.id, 'item', trim(
	i.title || ' ' || COALESCE(i.plot, '') || ' ' ||
	COALESCE((SELECT title FROM media_groups WHERE id = i.group_id), '') || ' ' ||
	COALESCE((SELECT parent.title FROM media_groups g JOIN media_groups parent ON parent.id = g.parent_id WHERE g.id = i.group_id), '') || ' ' ||
	COALESCE((SELECT group_concat(name || ' ' || normalized_name, ' ') FROM media_item_people WHERE item_id = i.id), '') || ' ' ||
	COALESCE((SELECT group_concat(genre_name || ' ' || genre_key, ' ') FROM media_item_genres WHERE item_id = i.id), '')
)
FROM media_items i;
--> statement-breakpoint
CREATE TRIGGER catalog_search_groups_ai AFTER INSERT ON media_groups BEGIN
	INSERT INTO catalog_search(library_id, entity_id, entity_kind, body)
	VALUES (NEW.library_id, NEW.id, 'group', trim(NEW.title || ' ' || COALESCE(NEW.plot, '')));
END;
--> statement-breakpoint
CREATE TRIGGER catalog_search_groups_au AFTER UPDATE ON media_groups BEGIN
	DELETE FROM catalog_search WHERE entity_id = OLD.id AND entity_kind = 'group';
	INSERT INTO catalog_search(library_id, entity_id, entity_kind, body)
	VALUES (NEW.library_id, NEW.id, 'group', trim(NEW.title || ' ' || COALESCE(NEW.plot, '')));
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
CREATE TRIGGER catalog_search_groups_ad AFTER DELETE ON media_groups BEGIN
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
CREATE TRIGGER catalog_search_items_ai AFTER INSERT ON media_items BEGIN
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
CREATE TRIGGER catalog_search_items_au AFTER UPDATE ON media_items BEGIN
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
CREATE TRIGGER catalog_search_items_ad AFTER DELETE ON media_items BEGIN
	DELETE FROM catalog_search WHERE entity_id = OLD.id AND entity_kind = 'item';
END;
--> statement-breakpoint
CREATE TRIGGER catalog_search_people_ai AFTER INSERT ON media_item_people BEGIN
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
CREATE TRIGGER catalog_search_people_ad AFTER DELETE ON media_item_people BEGIN
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
CREATE TRIGGER catalog_search_genres_ai AFTER INSERT ON media_item_genres BEGIN
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
CREATE TRIGGER catalog_search_genres_ad AFTER DELETE ON media_item_genres BEGIN
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
