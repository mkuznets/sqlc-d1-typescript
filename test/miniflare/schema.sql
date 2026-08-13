create table feeds
(
    id                     text primary key not null check (substring(id, 1, 5) = 'feed_'),
    user_id                text             not null,
    type                   text             not null,
    title                  text             not null,
    link                   text             not null,
    authors                text             not null,
    description            text             not null,
    created_at             integer          not null check (created_at > 0),
    updated_at             integer          not null check (updated_at > 0),
    deleted_at             integer check (deleted_at is null or deleted_at > 0)
) strict;

create index feeds_user_id_idx on feeds (user_id);

create table items
(
    id           text primary key           not null check (substring(id, 1, 5) = 'item_'),
    feed_id      text                       not null,
    user_id      text                       not null,
    file_id      text                       not null,
    title        text                       not null,
    description  text                       not null,
    link         text                       not null,
    authors      text                       not null,
    created_at   integer                    not null check (created_at > 0),
    updated_at   integer                    not null check (updated_at > 0),
    deleted_at   integer check (deleted_at is null or deleted_at > 0),
    published_at integer                    not null check (published_at is null or published_at > 0)
) strict;

create index items_feed_id_user_id_idx on items (feed_id, user_id) where deleted_at is null;

create table files
(
    id         text primary key not null check (substring(id, 1, 5) = 'file_'),
    user_id    text             not null,
    item_id    text,
    size       integer          not null check (size > 0),
    mime_type  text             not null,
    hash       text             not null,
    upload_url text             not null,
    created_at integer          not null check (created_at > 0),
    updated_at integer          not null check (updated_at > 0),
    deleted_at integer check (deleted_at is null or deleted_at > 0)
) strict;

-- Deliberately non-strict: STRICT tables only permit INT/INTEGER/REAL/TEXT/BLOB/ANY,
-- so the declared types this table exercises require an ordinary table.
create table samples
(
    id         integer primary key autoincrement not null,
    int_value  INTEGER                           not null,
    int_null   UNSIGNED BIG INT,
    num_value  DECIMAL(10, 2)                    not null,
    num_null   REAL,
    text_value VARCHAR(255)                      not null,
    text_null  DATETIME,
    bool_value BOOLEAN                           not null,
    bool_null  BOOLEAN,
    blob_value BLOB                              not null,
    blob_null  BLOB,
    json_value JSON                              not null,
    json_null  JSONB,
    any_value  ULID                              not null,
    any_null   ULID
);

-- flag defaults to a value no BOOLEAN column may hold, so RETURNING it fails
-- mapping after the write has already committed.
create table quirks
(
    id   integer primary key autoincrement not null,
    flag BOOLEAN                           not null default 2
);

-- Every column nullable, so a LEFT JOIN embed of a row that does not exist maps to an
-- object whose fields are all null rather than failing row mapping.
create table item_notes
(
    item_id text,
    note    text,
    rating  integer
) strict;
