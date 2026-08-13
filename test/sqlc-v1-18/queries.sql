-- name: GetRecord :one
SELECT id, name FROM records WHERE id = ?;

-- name: ListRecords :many
SELECT id, name FROM records ORDER BY id;

-- name: InsertRecord :exec
INSERT INTO records (name) VALUES (?);

-- name: RenameRecord :execrows
UPDATE records SET name = ? WHERE id = ?;

-- name: AddRecord :execlastid
INSERT INTO records (name) VALUES (?);

-- name: DeleteRecord :execresult
DELETE FROM records WHERE id = ?;
