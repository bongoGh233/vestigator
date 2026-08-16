import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || `${__dirname}/data`;
mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(`${DATA_DIR}/vestigator.db`);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    email         TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until  INTEGER
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    csrf       TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    ip         TEXT,
    user_agent TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

  CREATE TABLE IF NOT EXISTS bookings (
    id           TEXT PRIMARY KEY,
    user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    share_token  TEXT NOT NULL,
    code         TEXT NOT NULL,
    person_name  TEXT NOT NULL,
    phone        TEXT NOT NULL DEFAULT '',
    note         TEXT NOT NULL DEFAULT '',
    pickup       TEXT,
    destination  TEXT,
    status       TEXT NOT NULL DEFAULT 'pending',
    created_at   INTEGER NOT NULL,
    person_online INTEGER NOT NULL DEFAULT 0,
    location     TEXT,
    path         TEXT NOT NULL DEFAULT '[]'
  );
  CREATE INDEX IF NOT EXISTS idx_bookings_user ON bookings(user_id);

  CREATE TABLE IF NOT EXISTS password_resets (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_resets_user ON password_resets(user_id);

  CREATE TABLE IF NOT EXISTS profiles (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    bio             TEXT NOT NULL DEFAULT '',
    skills          TEXT NOT NULL DEFAULT '[]',
    avatar          TEXT,
    phone           TEXT NOT NULL DEFAULT '',
    city            TEXT NOT NULL DEFAULT '',
    listed          INTEGER NOT NULL DEFAULT 1,
    is_active       INTEGER NOT NULL DEFAULT 1,
    track_code      TEXT NOT NULL,
    code_expires_at INTEGER NOT NULL,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_profiles_code ON profiles(track_code);
`);

const stmts = {
  insertUser: db.prepare(
    "INSERT INTO users (name, email, password_hash, created_at) VALUES (?, ?, ?, ?)"
  ),
  findUserByEmail: db.prepare("SELECT * FROM users WHERE email = ?"),
  findUserById: db.prepare("SELECT * FROM users WHERE id = ?"),
  updateUserAttempts: db.prepare(
    "UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?"
  ),
  insertSession: db.prepare(
    "INSERT INTO sessions (token_hash, user_id, csrf, created_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ),
  findSession: db.prepare("SELECT * FROM sessions WHERE token_hash = ?"),
  deleteSession: db.prepare("DELETE FROM sessions WHERE token_hash = ?"),
  deleteExpiredSessions: db.prepare("DELETE FROM sessions WHERE expires_at < ?"),
  insertBooking: db.prepare(
    "INSERT INTO bookings (id, user_id, share_token, code, person_name, phone, note, pickup, destination, status, created_at, person_online, location, path) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ),
  findBookingById: db.prepare("SELECT * FROM bookings WHERE id = ?"),
  findBookingByUser: db.prepare(
    "SELECT * FROM bookings WHERE id = ? AND user_id = ?"
  ),
  listBookingsByUser: db.prepare(
    "SELECT * FROM bookings WHERE user_id = ? ORDER BY created_at DESC"
  ),
  listBookingsByUserPage: db.prepare(
    "SELECT * FROM bookings WHERE user_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?"
  ),
  updateBooking: db.prepare(`
    UPDATE bookings SET
      person_name = ?, phone = ?, note = ?, pickup = ?, destination = ?,
      status = ?, person_online = ?, location = ?, path = ?
    WHERE id = ?
  `),
  deleteBooking: db.prepare("DELETE FROM bookings WHERE id = ?"),
  clearAllOnline: db.prepare("UPDATE bookings SET person_online = 0"),
  insertReset: db.prepare(
    "INSERT INTO password_resets (user_id, token_hash, created_at, expires_at) VALUES (?, ?, ?, ?)"
  ),
  findReset: db.prepare("SELECT * FROM password_resets WHERE token_hash = ?"),
  deleteReset: db.prepare("DELETE FROM password_resets WHERE token_hash = ?"),
  deleteResetsForUser: db.prepare("DELETE FROM password_resets WHERE user_id = ?"),
  updateUserPassword: db.prepare("UPDATE users SET password_hash = ? WHERE id = ?"),
  deleteAllSessions: db.prepare("DELETE FROM sessions WHERE user_id = ?"),
  insertProfile: db.prepare(`
    INSERT INTO profiles (user_id, name, bio, skills, avatar, phone, city, listed, is_active, track_code, code_expires_at, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  updateProfile: db.prepare(`
    UPDATE profiles SET name = ?, bio = ?, skills = ?, avatar = ?, phone = ?, city = ?, listed = ?, is_active = ?, updated_at = ? WHERE id = ?
  `),
  updateProfileCode: db.prepare(
    "UPDATE profiles SET track_code = ?, code_expires_at = ? WHERE id = ?"
  ),
  findProfileById: db.prepare("SELECT * FROM profiles WHERE id = ?"),
  findProfileByUser: db.prepare("SELECT * FROM profiles WHERE user_id = ?"),
  findProfileByCode: db.prepare("SELECT * FROM profiles WHERE track_code = ?"),
  listActiveProfiles: db.prepare(
    "SELECT * FROM profiles WHERE is_active = 1 AND listed = 1 AND user_id != ? ORDER BY created_at DESC"
  ),
  listActiveProfilesPage: db.prepare(
    "SELECT * FROM profiles WHERE is_active = 1 AND listed = 1 AND user_id != ? ORDER BY created_at DESC LIMIT ? OFFSET ?"
  ),
  listExpiredCodes: db.prepare("SELECT id FROM profiles WHERE code_expires_at < ?"),
};

export default stmts;
