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
