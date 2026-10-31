const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const db = require('./database');

const app = express();

app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: 'change-this-to-something-random-later',
  resave: false,
  saveUninitialized: false
}));

function requireLogin(req, res, next) {
  if (!req.session.userId) {
    return res.redirect('/login');
  }
  next();
}

const VACCINE_SCHEDULE = [
  { name: 'BCG', monthsAfterBirth: 0 },
  { name: 'DPT 1 + OPV 1 + Hepatitis B1', monthsAfterBirth: 2 },
  { name: 'DPT 2 + OPV 2 + Hepatitis B2', monthsAfterBirth: 4 },
  { name: 'DPT 3 + OPV 3 + Hepatitis B3', monthsAfterBirth: 6 },
  { name: 'Measles + Vitamin A', monthsAfterBirth: 9 },
  { name: 'DPT 4 + OPV 4 + Vitamin A', monthsAfterBirth: 18 },
  { name: 'Measles & Rubella + Vitamin A', monthsAfterBirth: 36 },
  { name: 'DT + OPV 5', monthsAfterBirth: 60 },
  { name: 'Rubella + atd (Girls)', monthsAfterBirth: 144 }
];

function addMonths(dateStr, months) {
  const date = new Date(dateStr);
  date.setMonth(date.getMonth() + months);
  return date.toISOString().split('T')[0];
}

// Shared vaccine SELECT — includes who recorded/completed it and who reported any side effect
const VACCINE_SELECT = `
  SELECT vaccines.*,
         recorder.name AS recorded_by_name,
         recorder.slmc_number AS recorded_by_slmc,
         completer.name AS completed_by_name,
         completer.slmc_number AS completed_by_slmc,
         side_reporter.name AS side_effect_reporter_name,
         side_reporter.slmc_number AS side_effect_reporter_slmc
  FROM vaccines
  LEFT JOIN users recorder ON vaccines.recorded_by = recorder.id
  LEFT JOIN users completer ON vaccines.completed_by = completer.id
  LEFT JOIN users side_reporter ON vaccines.side_effect_recorded_by = side_reporter.id
  WHERE child_id = ? ORDER BY due_date ASC
`;

app.get('/', (req, res) => {
  res.send('E-Clinic server is running!');
});

app.get('/signup', (req, res) => {
  res.render('signup', { error: null });
});

app.post('/signup', async (req, res) => {
  const { name, email, password, role, nic, slmcNumber } = req.body;

  if (!nic || nic.trim() === '') {
    return res.render('signup', {
      error: role === 'worker'
        ? 'NIC Number is required for health worker accounts.'
        : 'NIC Number is required for parent accounts.'
    });
  }
  if (role === 'worker' && (!slmcNumber || slmcNumber.trim() === '')) {
    return res.render('signup', { error: 'SLMC Registration Number is required for health worker accounts.' });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const insertUser = db.prepare(
      'INSERT INTO users (name, email, password, role, nic, slmc_number) VALUES (?, ?, ?, ?, ?, ?)'
    );
    insertUser.run(
      name,
      email,
      hashedPassword,
      role,
      nic,
      role === 'worker' ? slmcNumber : null
    );
    res.redirect('/login');
  } catch (err) {
    console.log(err);
    res.render('signup', { error: 'That email, NIC, or SLMC number is already registered.' });
  }
});

app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);

  if (!user) {
    return res.render('login', { error: 'No account with that email.' });
  }

  const passwordMatches = await bcrypt.compare(password, user.password);
  if (!passwordMatches) {
    return res.render('login', { error: 'Incorrect password.' });
  }

  req.session.userId = user.id;
  req.session.userRole = user.role;
  req.session.userName = user.name;

  res.redirect('/dashboard');
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

app.get('/dashboard', requireLogin, (req, res) => {
  if (req.session.userRole === 'parent') {
    const children = db.prepare(`
      SELECT children.*, 
             registrar.name AS registered_by_name, 
             registrar.slmc_number AS registered_by_slmc
      FROM children
      LEFT JOIN users registrar ON children.registered_by = registrar.id
      WHERE children.parent_id = ?
    `).all(req.session.userId);

    const childrenWithData = children.map(child => {
      const growthRecords = db.prepare(`
        SELECT growth_records.*, 
               recorder.name AS recorded_by_name, 
               recorder.slmc_number AS recorded_by_slmc
        FROM growth_records
        LEFT JOIN users recorder ON growth_records.recorded_by = recorder.id
        WHERE child_id = ? ORDER BY date ASC
      `).all(child.id);

      const vaccines = db.prepare(VACCINE_SELECT).all(child.id);

      return { ...child, growthRecords, vaccines };
    });

    res.render('parent-dashboard', { children: childrenWithData, userName: req.session.userName });
  } else {
    res.render('worker-dashboard', { userName: req.session.userName });
  }
});

app.get('/register-child', requireLogin, (req, res) => {
  res.render('register-child', { parent: null, error: null, success: null });
});

app.post('/register-child/search', requireLogin, (req, res) => {
  const { nic } = req.body;
  const parent = db.prepare('SELECT * FROM users WHERE nic = ? AND role = ?').get(nic, 'parent');

  if (!parent) {
    return res.render('register-child', { parent: null, error: 'No parent found with that NIC.', success: null });
  }

  res.render('register-child', { parent, error: null, success: null });
});

app.post('/register-child/save', requireLogin, (req, res) => {
  const { parentId, childName, dob, sex } = req.body;
  const countResult = db.prepare('SELECT COUNT(*) AS count FROM children WHERE parent_id = ?').get(parentId);
  const birthOrder = countResult.count + 1;

  const result = db.prepare(
    'INSERT INTO children (name, date_of_birth, parent_id, birth_order, sex, registered_by) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(childName, dob, parentId, birthOrder, sex, req.session.userId);

  const newChildId = result.lastInsertRowid;

  const insertVaccine = db.prepare(
    'INSERT INTO vaccines (child_id, vaccine_name, due_date, completed, recorded_by) VALUES (?, ?, ?, 0, ?)'
  );

  const scheduleToUse = sex === 'female'
    ? VACCINE_SCHEDULE
    : VACCINE_SCHEDULE.filter(v => !v.name.includes('Girls'));

  scheduleToUse.forEach(v => {
    const dueDate = addMonths(dob, v.monthsAfterBirth);
    insertVaccine.run(newChildId, v.name, dueDate, req.session.userId);
  });

  res.render('register-child', { parent: null, error: null, success: `${childName} registered successfully as child #${birthOrder}! EPI vaccine schedule created.` });
});

app.get('/add-growth', requireLogin, (req, res) => {
  res.render('add-growth', { parent: null, children: null, error: null, success: null });
});

app.post('/add-growth/search', requireLogin, (req, res) => {
  const { nic } = req.body;
  const parent = db.prepare('SELECT * FROM users WHERE nic = ? AND role = ?').get(nic, 'parent');

  if (!parent) {
    return res.render('add-growth', { parent: null, children: null, error: 'No parent found with that NIC.', success: null });
  }

  const children = db.prepare('SELECT * FROM children WHERE parent_id = ?').all(parent.id);

  if (children.length === 0) {
    return res.render('add-growth', { parent: null, children: null, error: 'This parent has no registered children yet.', success: null });
  }

  res.render('add-growth', { parent, children, error: null, success: null });
});

app.post('/add-growth/save', requireLogin, (req, res) => {
  const { childId, date, weight, height } = req.body;

  db.prepare(
    'INSERT INTO growth_records (child_id, date, weight_kg, height_cm, recorded_by) VALUES (?, ?, ?, ?, ?)'
  ).run(childId, date, weight, height, req.session.userId);

  res.render('add-growth', { parent: null, children: null, error: null, success: 'Growth record added successfully!' });
});

app.get('/manage-vaccines', requireLogin, (req, res) => {
  res.render('manage-vaccines', { parent: null, children: null, selectedChild: null, vaccines: null, error: null, success: null });
});

app.post('/manage-vaccines/search', requireLogin, (req, res) => {
  const { nic } = req.body;
  const parent = db.prepare('SELECT * FROM users WHERE nic = ? AND role = ?').get(nic, 'parent');

  if (!parent) {
    return res.render('manage-vaccines', { parent: null, children: null, selectedChild: null, vaccines: null, error: 'No parent found with that NIC.', success: null });
  }

  const children = db.prepare('SELECT * FROM children WHERE parent_id = ?').all(parent.id);

  if (children.length === 0) {
    return res.render('manage-vaccines', { parent: null, children: null, selectedChild: null, vaccines: null, error: 'This parent has no registered children yet.', success: null });
  }

  res.render('manage-vaccines', { parent, children, selectedChild: null, vaccines: null, error: null, success: null });
});

app.post('/manage-vaccines/select-child', requireLogin, (req, res) => {
  const { childId } = req.body;
  const selectedChild = db.prepare('SELECT * FROM children WHERE id = ?').get(childId);
  const vaccines = db.prepare(VACCINE_SELECT).all(childId);

  res.render('manage-vaccines', { parent: null, children: null, selectedChild, vaccines, error: null, success: null });
});

app.post('/manage-vaccines/complete', requireLogin, (req, res) => {
  const { vaccineId, childId, sideEffects, severity } = req.body;
  const today = new Date().toISOString().split('T')[0];
  const hasSideEffect = sideEffects && sideEffects.trim() !== '';

  db.prepare(`
    UPDATE vaccines
    SET completed = 1, completed_date = ?, completed_by = ?,
        side_effects = ?, side_effect_severity = ?, side_effect_recorded_by = ?, side_effect_date = ?
    WHERE id = ?
  `).run(
    today, req.session.userId,
    hasSideEffect ? sideEffects.trim() : null,
    hasSideEffect ? severity : null,
    hasSideEffect ? req.session.userId : null,
    hasSideEffect ? today : null,
    vaccineId
  );

  const selectedChild = db.prepare('SELECT * FROM children WHERE id = ?').get(childId);
  const vaccines = db.prepare(VACCINE_SELECT).all(childId);

  res.render('manage-vaccines', { parent: null, children: null, selectedChild, vaccines, error: null, success: 'Vaccine marked as completed.' });
});

// Report (or update) a side effect on a vaccine that was already completed —
// covers reactions that only show up days after the dose was given.
app.post('/manage-vaccines/report-reaction', requireLogin, (req, res) => {
  const { vaccineId, childId, sideEffects, severity } = req.body;
  const today = new Date().toISOString().split('T')[0];

  db.prepare(`
    UPDATE vaccines
    SET side_effects = ?, side_effect_severity = ?, side_effect_recorded_by = ?, side_effect_date = ?
    WHERE id = ?
  `).run(sideEffects.trim(), severity, req.session.userId, today, vaccineId);

  const selectedChild = db.prepare('SELECT * FROM children WHERE id = ?').get(childId);
  const vaccines = db.prepare(VACCINE_SELECT).all(childId);

  res.render('manage-vaccines', { parent: null, children: null, selectedChild, vaccines, error: null, success: 'Side effect recorded. This will be visible to any worker who views this child\'s record.' });
});

app.post('/manage-vaccines/add-custom', requireLogin, (req, res) => {
  const { childId, vaccineName, dueDate } = req.body;

  db.prepare(
    'INSERT INTO vaccines (child_id, vaccine_name, due_date, completed, recorded_by) VALUES (?, ?, ?, 0, ?)'
  ).run(childId, vaccineName, dueDate, req.session.userId);

  const selectedChild = db.prepare('SELECT * FROM children WHERE id = ?').get(childId);
  const vaccines = db.prepare(VACCINE_SELECT).all(childId);

  res.render('manage-vaccines', { parent: null, children: null, selectedChild, vaccines, error: null, success: 'Custom vaccine added.' });
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server started on http://localhost:${PORT}`);
});