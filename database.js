const Database = require('better-sqlite3');
const db = new Database('eclinic.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    role TEXT NOT NULL,
    nic TEXT UNIQUE,
    slmc_number TEXT UNIQUE
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS children (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    date_of_birth TEXT NOT NULL,
    parent_id INTEGER NOT NULL,
    birth_order INTEGER NOT NULL,
    sex TEXT NOT NULL,
    registered_by INTEGER,
    FOREIGN KEY (parent_id) REFERENCES users(id),
    FOREIGN KEY (registered_by) REFERENCES users(id)
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS growth_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    child_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    weight_kg REAL NOT NULL,
    height_cm REAL NOT NULL,
    recorded_by INTEGER,
    FOREIGN KEY (child_id) REFERENCES children(id),
    FOREIGN KEY (recorded_by) REFERENCES users(id)
  )
`);

// Table 4: vaccines (now includes side-effect / AEFI tracking)
db.exec(`
  CREATE TABLE IF NOT EXISTS vaccines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    child_id INTEGER NOT NULL,
    vaccine_name TEXT NOT NULL,
    due_date TEXT NOT NULL,
    completed INTEGER NOT NULL DEFAULT 0,
    is_custom INTEGER NOT NULL DEFAULT 0,
    completed_date TEXT,
    recorded_by INTEGER,
    completed_by INTEGER,
    side_effects TEXT,
    side_effect_severity TEXT,
    side_effect_recorded_by INTEGER,
    side_effect_date TEXT,
    FOREIGN KEY (child_id) REFERENCES children(id),
    FOREIGN KEY (recorded_by) REFERENCES users(id),
    FOREIGN KEY (completed_by) REFERENCES users(id),
    FOREIGN KEY (side_effect_recorded_by) REFERENCES users(id)
  )
`);

// Existing databases need the new column as well as freshly-created databases.
// Old rows remain standard records because we cannot reliably infer whether they
// were created using the custom-vaccine form.
const vaccineColumns = db.prepare('PRAGMA table_info(vaccines)').all();
if (!vaccineColumns.some(column => column.name === 'is_custom')) {
  db.exec('ALTER TABLE vaccines ADD COLUMN is_custom INTEGER NOT NULL DEFAULT 0');
}

console.log('Database and tables created successfully!');

module.exports = db;