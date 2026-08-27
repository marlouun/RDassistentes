CREATE TABLE IF NOT EXISTS rd_contact_cache (
  rd_contact_id TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  wallet_name TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  last_message_json TEXT,
  synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_rd_contact_cache_wallet
  ON rd_contact_cache(wallet_name);

CREATE INDEX IF NOT EXISTS idx_rd_contact_cache_phone
  ON rd_contact_cache(phone);

CREATE TABLE IF NOT EXISTS rd_contact_sync_state (
  seller_id INTEGER PRIMARY KEY,
  next_page INTEGER NOT NULL DEFAULT 1,
  next_index INTEGER NOT NULL DEFAULT 0,
  reached_end INTEGER NOT NULL DEFAULT 0,
  last_sync_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (seller_id) REFERENCES sellers(id) ON DELETE CASCADE
);
