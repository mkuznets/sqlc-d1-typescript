-- name: GetUser :one
SELECT id, name, nickname FROM users WHERE id = ?;

-- name: ListUsers :many
SELECT id, name, nickname FROM users ORDER BY id;

-- name: RenameUser :one
UPDATE users SET name = ? WHERE id = ? RETURNING id, name, nickname;
