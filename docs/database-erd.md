# E-Clinic database ER diagram

The application stores data in four SQLite tables. Each table's `id` is its primary key (`PK`). Linked IDs are foreign keys (`FK`). A health worker is a row in `users` with `role = 'worker'`; a parent has `role = 'parent'`.

![E-Clinic ER diagram](eclinic-erd.png)

```mermaid
erDiagram
    users ||--o{ children : "parent_id"
    users o|--o{ children : "registered_by"
    children ||--o{ growth_records : "child_id"
    users o|--o{ growth_records : "recorded_by"
    children ||--o{ vaccines : "child_id"
    users o|--o{ vaccines : "recorded_by / completed_by / side_effect_recorded_by"

    users {
      INTEGER id PK
      TEXT name
      TEXT email UK
      TEXT password
      TEXT role
      TEXT nic UK
      TEXT slmc_number UK
    }
    children {
      INTEGER id PK
      TEXT name
      TEXT date_of_birth
      INTEGER parent_id FK
      INTEGER birth_order
      TEXT sex
      INTEGER registered_by FK
    }
    growth_records {
      INTEGER id PK
      INTEGER child_id FK
      TEXT date
      REAL weight_kg
      REAL height_cm
      INTEGER recorded_by FK
    }
    vaccines {
      INTEGER id PK
      INTEGER child_id FK
      TEXT vaccine_name
      TEXT due_date
      INTEGER completed
      INTEGER is_custom
      TEXT completed_date
      INTEGER recorded_by FK
      INTEGER completed_by FK
      TEXT side_effects
      TEXT side_effect_severity
      INTEGER side_effect_recorded_by FK
      TEXT side_effect_date
    }
```

## Relationships

- One **parent** can have many children (`children.parent_id` references `users.id`).
- One **child** can have many growth records and many vaccine entries.
- A **health worker** can be associated with children as registrar, with growth records as recorder, and with vaccine entries as recorder/completer/reaction reporter. These worker attribution fields may be empty.
- SQLite stores dates as text in `YYYY-MM-DD` format. Measurements use `REAL` for numeric values.
- Uniqueness is defined on user email, NIC, and SLMC number. The schema contains foreign keys but no automatic cascading deletion rule.
- Custom-vaccine CRUD is limited by application logic to `is_custom = 1` and `completed = 0` for edits/deletions.

**Note:** A `FK` by itself does not guarantee a linked user is a health worker; the application's role checks enforce the workflow. For a future enhancement, role-specific integrity checks could be added at the data layer too.
