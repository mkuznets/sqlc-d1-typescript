-- name: CreateFeed :one
INSERT INTO feeds
(id, user_id, type, title, link, authors, description, created_at, updated_at, deleted_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
RETURNING *;

-- name: GetFeedById :one
SELECT *
FROM feeds
WHERE id = ?
  AND deleted_at IS NULL;

-- name: UpdateFeedUpdatedAt :exec
UPDATE feeds
SET updated_at = ?
WHERE id = ?;

-- name: CreateItem :one
INSERT INTO items
(id, feed_id, user_id, file_id, title, description, link, authors, published_at, created_at, updated_at, deleted_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
RETURNING *;

-- name: GetItemsByFeedId :many
SELECT *
FROM items
WHERE feed_id = ?
  AND deleted_at IS NULL;

-- name: CreateFile :one
INSERT INTO files
(id, user_id, item_id, size, mime_type, hash, upload_url, created_at, updated_at, deleted_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
RETURNING *;

-- name: UpdateFileItemId :exec
UPDATE files
SET item_id = ?
WHERE id = ?;

-- name: GetFileById :one
SELECT *
FROM files
WHERE id = ?
  AND deleted_at IS NULL;

-- name: ListFiles :many
SELECT *
FROM files
WHERE deleted_at IS NULL
ORDER BY created_at DESC;

-- name: GetFileByIdForUser :one
SELECT *
FROM files
WHERE id = ?
  AND user_id = ?
  AND deleted_at IS NULL;


-- name: GetItemsWithFilesByFeedId :many
SELECT i.id          as item_id,
       i.feed_id,
       i.user_id,
       i.file_id,
       i.title       as item_title,
       i.description as item_description,
       i.link        as item_link,
       i.authors     as item_authors,
       i.published_at,
       i.created_at  as item_created_at,
       i.updated_at  as item_updated_at,
       f.id          as joined_file_id,
       f.size        as file_size,
       f.mime_type,
       f.upload_url
FROM items i
         JOIN files f ON i.file_id = f.id
WHERE i.feed_id = ?
  AND i.deleted_at IS NULL
  AND f.deleted_at IS NULL
ORDER BY i.published_at DESC;

-- name: GetItemWithFileById :one
SELECT i.id          as item_id,
       i.feed_id,
       i.user_id,
       i.file_id,
       i.title       as item_title,
       i.description as item_description,
       i.link        as item_link,
       i.authors     as item_authors,
       i.published_at,
       i.created_at  as item_created_at,
       i.updated_at  as item_updated_at,
       f.size        as file_size,
       f.mime_type,
       f.upload_url
FROM items i
         JOIN files f ON i.file_id = f.id
WHERE i.id = ?
  AND i.deleted_at IS NULL
  AND f.deleted_at IS NULL;

-- name: GetItemById :one
SELECT *
FROM items
WHERE id = ?
  AND feed_id = ?
  AND deleted_at IS NULL;

-- name: GetFeedUserById :one
SELECT user_id
FROM feeds
WHERE id = ?
  AND deleted_at IS NULL;

-- name: UpdateItemById :exec
UPDATE items
SET title        = ?,
    description  = ?,
    link         = ?,
    authors      = ?,
    published_at = ?,
    updated_at   = ?
WHERE id = ?
  AND feed_id = ?;

-- name: CreateSample :one
INSERT INTO samples
(int_value, int_null, num_value, num_null, text_value, text_null, bool_value, bool_null, blob_value, blob_null,
 json_value, json_null, any_value, any_null)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
RETURNING *;

-- name: GetSampleById :one
SELECT *
FROM samples
WHERE id = ?;

-- name: ListSamples :many
SELECT *
FROM samples
ORDER BY id;

-- name: CreateQuirk :one
INSERT INTO quirks (id)
VALUES (?)
RETURNING *;

-- name: DeleteFeedsByUser :execrows
DELETE
FROM feeds
WHERE user_id = ?;

-- name: InsertSampleId :execlastid
INSERT INTO samples
(int_value, int_null, num_value, num_null, text_value, text_null, bool_value, bool_null, blob_value, blob_null,
 json_value, json_null, any_value, any_null)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?);

-- name: DeleteSamplesResult :execresult
DELETE
FROM samples
WHERE text_value = ?
RETURNING *;

-- name: RenameFeedsReturning :one
UPDATE feeds
SET title = ?
WHERE user_id = ?
  AND deleted_at IS NULL
RETURNING *;

-- name: DeleteSamplesReturning :many
DELETE
FROM samples
WHERE text_value = ?
RETURNING *;

-- name: GetFeedByIdAndUser :one
SELECT *
FROM feeds
WHERE id = sqlc.arg(id)
  AND (user_id = sqlc.arg(user_id) OR sqlc.arg(user_id) = '');

-- name: ListFeedsByOptionalTitle :many
SELECT *
FROM feeds
WHERE title = sqlc.narg(title)
   OR sqlc.narg(title) IS NULL
ORDER BY id;

-- name: ListFeedsByIds :many
SELECT *
FROM feeds
WHERE id IN (sqlc.slice(ids))
ORDER BY id;

-- name: GetFirstFeedByIds :one
SELECT *
FROM feeds
WHERE id IN (sqlc.slice(ids))
ORDER BY id
LIMIT 1;

-- name: TouchFeedsByIds :exec
UPDATE feeds
SET updated_at = ?
WHERE id IN (sqlc.slice(ids));

-- name: DeleteFeedsByIdsForUser :execrows
DELETE
FROM feeds
WHERE user_id = ?
  AND id IN (sqlc.slice(ids));

-- name: DeleteSamplesByTextValues :execresult
DELETE
FROM samples
WHERE text_value IN (sqlc.slice(values))
RETURNING *;

-- name: CopySampleForTextValues :execlastid
INSERT INTO samples
(int_value, int_null, num_value, num_null, text_value, text_null, bool_value, bool_null, blob_value, blob_null,
 json_value, json_null, any_value, any_null)
SELECT s.int_value,
       s.int_null,
       s.num_value,
       s.num_null,
       ?,
       s.text_null,
       s.bool_value,
       s.bool_null,
       s.blob_value,
       s.blob_null,
       s.json_value,
       s.json_null,
       s.any_value,
       s.any_null
FROM samples s
WHERE s.text_value IN (sqlc.slice(values))
ORDER BY s.id
LIMIT 1;

-- name: GetFeedAndItemEmbed :one
SELECT sqlc.embed(f), sqlc.embed(i)
FROM feeds f
         JOIN items i ON i.feed_id = f.id
WHERE i.id = ?;

-- name: ListItemsWithNotes :many
SELECT i.id AS item_id, sqlc.embed(n)
FROM items i
         LEFT JOIN item_notes n ON n.item_id = i.id
WHERE i.feed_id = ?
ORDER BY i.id;

-- name: ListItemsWithFilesByIds :many
SELECT sqlc.embed(i), sqlc.embed(fl)
FROM items i
         JOIN files fl ON i.file_id = fl.id
WHERE i.id IN (sqlc.slice(ids))
ORDER BY i.id;
