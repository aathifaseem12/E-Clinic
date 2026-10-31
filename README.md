# E-Clinic — Child Health Development Record

E-Clinic is a web application for keeping a child's growth measurements and vaccination records in one place. It has separate views for parents and health workers. It was developed as a mini project for **EC4307 — Web Application Development**.

## Main features

**Parent account**
- Sign up with a name, email, password, and NIC, then log in.
- View registered children, growth records, and vaccination schedules.
- View growth charts and recorded vaccine reactions.

**Health-worker account**
- Log in using an existing health-worker account. Public sign-up **does not** create health-worker accounts.
- Find a parent using their NIC and register a child.
- Record a child's weight and height.
- View and update vaccination records and report reactions for completed doses.
- Add, view, edit and delete **pending custom vaccine records**. Standard scheduled and completed records are protected from this delete operation.
- Search vaccine names, filter by status, and sort records by due date or name.

## Technology stack

| Layer | Technology |
| --- | --- |
| Server | Node.js, Express |
| Templates | EJS (server-rendered HTML) |
| Styling | CSS (in `public/style.css` and some page styles) |
| Database | SQLite with `better-sqlite3` |
| Password hashing | bcrypt |
| Login sessions | express-session |

The application does not use React or a separate REST API. Express routes render EJS pages and process HTML forms.

## Requirements

- A supported Node.js version and npm (install a current LTS version if needed).
- A local computer with permission to install native Node.js dependencies.
- A web browser.

## Running locally (Windows PowerShell)

1. Clone the repository and open the folder:

   ```powershell
   git clone https://github.com/aathifaseem12/E-Clinic.git
   cd E-Clinic
   ```

2. Install dependencies:

   ```powershell
   npm ci
   ```

3. Optionally configure a stable local session secret. Use a private random value of at least 32 characters; **never commit it to Git**:

   ```powershell
   $env:ECLINIC_SESSION_SECRET = node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))"
   ```

   Without this variable in development, a temporary secret is created when the server starts, which signs users out on restart.

4. Start the application:

   ```powershell
   node server.js
   ```

5. Open <http://localhost:3000/>. When logged out, it redirects to `/login`.

On first run, the application creates an `eclinic.db` SQLite file and the required tables. This local file is **excluded from Git**. A fresh clone starts with an empty database; existing health-worker accounts are not generated automatically. Ask the project owner for a safe, authorized demonstration-account setup process. Do not enable public health-worker registration just for the demo.

To stop the server, press **Ctrl+C** in its terminal.

### Common issues

- **Port 3000 already used:** Stop the old `node server.js` process before restarting. Multiple copies can produce confusing results.
- **Login logs out after restart:** A temporary development session secret is regenerated. A private `ECLINIC_SESSION_SECRET` avoids that.
- **Native SQLite module fails to load:** Run `npm ci` on the target operating system rather than copying another computer's `node_modules` folder.
- **No records on fresh clone:** `eclinic.db` is intentionally excluded. Use fictitious data for demonstrations.

## Database and system design

- [Database ER diagram](docs/database-erd.md)
- [PNG diagram (use in the report)](docs/eclinic-erd.png)
- [User and request flow](docs/system-flow.md)
- [Screenshot checklist](docs/screenshots/README.md)

The database has four principal tables: `users`, `children`, `growth_records` and `vaccines`. Keys and relationships are documented in the ER diagram. SQLite foreign-key enforcement is enabled for the application's connection.

## Security and limitations

- Parent signup is public; health-worker signup is not.
- Health-worker routes have server-side role checks.
- Form submissions use CSRF tokens. Passwords are stored as bcrypt hashes.
- Production deployment requires HTTPS and a private `ECLINIC_SESSION_SECRET` of at least 32 characters. The sample setup above is for local demonstration only.
- There is **no built-in administrator interface for provisioning new health-worker accounts**. Existing worker accounts can log in.
- Existing standard vaccine schedules are demonstration application data; **do not treat them as official medical guidance**.
- No comprehensive automated test suite is included in the current repository. Run the manual checks below before demonstrating the application.

**Privacy:** Do not commit real patient information, NICs, passwords, session secrets, or the SQLite database. Capture screenshots with fictitious test data only.

## Manual demo checklist

- [ ] Parent can sign up, log in and see their dashboard.
- [ ] Parent cannot access the health-worker routes.
- [ ] Health worker can find a registered parent by NIC and register a child.
- [ ] Child records remain visible after refresh and server restart.
- [ ] Health worker can add valid growth records and invalid measurements are rejected.
- [ ] Health worker can create, view, edit and delete a *pending custom vaccine*.
- [ ] Standard and completed vaccine records cannot be deleted through the custom-vaccine route.
- [ ] Vaccine name search, status filters and due-date/name sorting work.
- [ ] Reaction reporting works for a completed test vaccine.
- [ ] Dashboard and tables are usable on mobile widths.

## Project structure

```text
E-Clinic/
├── server.js               # Express routes, sessions, validation, CRUD
├── database.js             # SQLite schema, indexes and database connection
├── package.json
├── package-lock.json
├── public/
│   └── style.css
├── views/                  # EJS login, signup and dashboard pages
├── docs/
│   ├── database-erd.md
│   ├── eclinic-erd.png
│   ├── system-flow.md
│   └── screenshots/README.md
└── README.md
```

The `eclinic.db` file and `node_modules` are created locally and should not be committed.

## Source repository

<https://github.com/aathifaseem12/E-Clinic>
