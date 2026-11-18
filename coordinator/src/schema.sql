PRAGMA application_id=1095911473;
PRAGMA user_version=1;
CREATE TABLE room (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  value TEXT NOT NULL
);
CREATE TABLE provider_ids (
  namespace TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('playlist','track')),
  provider TEXT NOT NULL,
  opaque TEXT NOT NULL UNIQUE,
  PRIMARY KEY(namespace,kind,provider)
);
CREATE TABLE pictures (
  id TEXT PRIMARY KEY,
  created INTEGER NOT NULL,
  width INTEGER NOT NULL CHECK(width BETWEEN 1 AND 1920),
  height INTEGER NOT NULL CHECK(height BETWEEN 1 AND 1920),
  jpeg BLOB NOT NULL
);
