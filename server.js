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

// Every health-worker page and write operation must be authorized on the server.
// Look up the current role instead of trusting a potentially stale session role.
function requireWorker(req, res, next) {
  if (!req.session.userId) return res.redirect('/login');
  const account = db.prepare('SELECT role FROM users WHERE id = ?').get(req.session.userId);
  if (!account || account.role !== 'worker') {
    return res.status(403).send('Health worker access required.');
  }
  next();
}

function isValidDateOnly(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

// Basic input validation used by forms as well as direct HTTP requests.
function validId(value) {
  return typeof value === 'string' && /^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value));
}

function textField(value, maxLength) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length <= maxLength ? trimmed : '';
}

function todayDate() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function isValidPastOrToday(value) {
  return isValidDateOnly(value) && value <= todayDate();
}

function showChildError(res, message, code = 400) {
  return res.status(code).render('register-child', { parent: null, error: message, success: null });
}

function showGrowthError(res, message, code = 400) {
  return res.status(code).render('add-growth', { parent: null, children: null, error: message, success: null });
}

function renderVaccineList(res, childId, message, isError = false) {
  const selectedChild = db.prepare('SELECT * FROM children WHERE id = ?').get(childId);
  if (!selectedChild) return res.status(404).send('Child not found.');
  const vaccines = db.prepare(VACCINE_SELECT).all(childId);
  return res.status(isError ? 400 : 200).render('manage-vaccines', {
    parent: null, children: null, selectedChild, vaccines,
    error: isError ? message : null,
    success: isError ? null : message
  });
}

// Validate optional reaction details even when requests bypass the browser form.
function parseVaccineReaction(body, required = false) {
  const input = body.sideEffects;
  if (input !== undefined && typeof input !== 'string') {
    return { error: 'Reaction details must be text.' };
  }
  const description = (input || '').trim();
  if (description.length > 1000) {
    return { error: 'Reaction details must be 1000 characters or fewer.' };
  }
  if (required && !description) {
    return { error: 'Enter a reaction description.' };
  }
  if (description && !['mild', 'moderate', 'severe'].includes(body.severity)) {
    return { error: 'Choose a valid reaction severity.' };
  }
  return {
    description: description || null,
    severity: description ? body.severity : null
  };
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
  const { password, role } = req.body;
  const name = textField(req.body.name, 100);
  const email = textField(req.body.email, 254).toLowerCase();
  const nic = textField(req.body.nic, 12).toUpperCase();

  // Never allow an unverified health worker account through public signup.
  if (role !== 'parent') {
    return res.status(403).render('signup', {
      error: 'Health worker accounts cannot be created using public signup.'
    });
  }
  if (!name || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).render('signup', { error: 'Enter a valid full name and email address.' });
  }
  if (typeof password !== 'string' || Buffer.byteLength(password, 'utf8') < 8 || Buffer.byteLength(password, 'utf8') > 72) {
    return res.status(400).render('signup', { error: 'Password must be between 8 and 72 bytes long.' });
  }
  if (!/^(?:\d{12}|\d{9}[VX])$/.test(nic)) {
    return res.status(400).render('signup', { error: 'Enter a valid 12-digit NIC or old 9-digit NIC followed by V/X.' });
  }

  try {
    // Older accounts may have mixed-case email addresses; prevent duplicates.
    if (db.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE').get(email)) {
      return res.status(409).render('signup', { error: 'That email or NIC is already registered.' });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    db.prepare(
      'INSERT INTO users (name, email, password, role, nic, slmc_number) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(name, email, hashedPassword, 'parent', nic, null);
    return res.redirect('/login');
  } catch (err) {
    if (err.code && err.code.startsWith('SQLITE_CONSTRAINT')) {
      return res.status(409).render('signup', { error: 'That email or NIC is already registered.' });
    }
    console.error('Signup failed:', err);
    return res.status(500).render('signup', { error: 'Could not create the account. Please try again.' });
  }
});

app.get('/login', (req, res) => {
  res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
  const { password } = req.body;
  const email = textField(req.body.email, 254).toLowerCase();
  if (!email || typeof password !== 'string' || !password) {
    return res.status(400).render('login', { error: 'Enter your email and password.' });
  }
  const user = db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(email);

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
  } else if (req.session.userRole === 'worker') {
    res.render('worker-dashboard', { userName: req.session.userName });
  } else {
    res.status(403).send('Unknown account role.');
  }
});

app.get('/register-child', requireWorker, (req, res) => {
  res.render('register-child', { parent: null, error: null, success: null });
});

app.post('/register-child/search', requireWorker, (req, res) => {
  const { nic } = req.body;
  const parent = db.prepare('SELECT * FROM users WHERE nic = ? AND role = ?').get(nic, 'parent');

  if (!parent) {
    return res.render('register-child', { parent: null, error: 'No parent found with that NIC.', success: null });
  }

  res.render('register-child', { parent, error: null, success: null });
});

app.post('/register-child/save', requireWorker, (req, res) => {
  const { parentId, dob, sex } = req.body;
  const childName = textField(req.body.childName, 100);

  if (!validId(parentId) || !childName || !isValidPastOrToday(dob) || !['male', 'female'].includes(sex)) {
    return showChildError(res, 'Enter a valid parent, child name, birth date and sex. Future birth dates are not allowed.');
  }
  const parent = db.prepare('SELECT id FROM users WHERE id = ? AND role = ?').get(parentId, 'parent');
  if (!parent) return showChildError(res, 'The selected parent no longer exists.', 404);

  // Register the child and their schedule together; errors roll back all inserts.
  const registerChild = db.transaction(() => {
    const countResult = db.prepare('SELECT COUNT(*) AS count FROM children WHERE parent_id = ?').get(parentId);
    const birthOrder = countResult.count + 1;
    const result = db.prepare(
      'INSERT INTO children (name, date_of_birth, parent_id, birth_order, sex, registered_by) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(childName, dob, parentId, birthOrder, sex, req.session.userId);
    const insertVaccine = db.prepare(
      'INSERT INTO vaccines (child_id, vaccine_name, due_date, completed, recorded_by) VALUES (?, ?, ?, 0, ?)'
    );
    const schedule = sex === 'female'
      ? VACCINE_SCHEDULE : VACCINE_SCHEDULE.filter(v => !v.name.includes('Girls'));
    schedule.forEach(v => {
      insertVaccine.run(result.lastInsertRowid, v.name, addMonths(dob, v.monthsAfterBirth), req.session.userId);
    });
    return birthOrder;
  });

  try {
    const birthOrder = registerChild();
    return res.render('register-child', {
      parent: null, error: null,
      success: `${childName} registered successfully as child #${birthOrder}! EPI vaccine schedule created.`
    });
  } catch (err) {
    console.error('Child registration failed:', err);
    return showChildError(res, 'Could not register the child. No partial schedule was saved.', 500);
  }
});

app.get('/add-growth', requireWorker, (req, res) => {
  res.render('add-growth', { parent: null, children: null, error: null, success: null });
});

app.post('/add-growth/search', requireWorker, (req, res) => {
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

app.post('/add-growth/save', requireWorker, (req, res) => {
  const { childId, date, weight, height } = req.body;
  const weightValue = typeof weight === 'string' && weight.trim() !== '' ? Number(weight) : NaN;
  const heightValue = typeof height === 'string' && height.trim() !== '' ? Number(height) : NaN;
  if (!validId(childId) || !isValidPastOrToday(date) ||
      !Number.isFinite(weightValue) || weightValue <= 0 || weightValue > 400 ||
      !Number.isFinite(heightValue) || heightValue <= 0 || heightValue > 300) {
    return showGrowthError(res, 'Choose a valid child, a date no later than today, and positive weight/height measurements.');
  }
  const child = db.prepare('SELECT id, date_of_birth FROM children WHERE id = ?').get(childId);
  if (!child) return showGrowthError(res, 'Child not found.', 404);
  if (date < child.date_of_birth) {
    return showGrowthError(res, 'Measurement date cannot be before the child was born.');
  }

  try {
    db.prepare(
      'INSERT INTO growth_records (child_id, date, weight_kg, height_cm, recorded_by) VALUES (?, ?, ?, ?, ?)'
    ).run(childId, date, weightValue, heightValue, req.session.userId);
    return res.render('add-growth', {
      parent: null, children: null, error: null, success: 'Growth record added successfully!'
    });
  } catch (err) {
    console.error('Growth record save failed:', err);
    return showGrowthError(res, 'Could not save the growth record. Please try again.', 500);
  }
});

app.get('/manage-vaccines', requireWorker, (req, res) => {
  res.render('manage-vaccines', { parent: null, children: null, selectedChild: null, vaccines: null, error: null, success: null });
});

app.post('/manage-vaccines/search', requireWorker, (req, res) => {
  const nic = typeof req.body?.nic === 'string' ? req.body.nic.trim().toUpperCase() : '';
  if (!nic || nic.length > 12) {
    return res.status(400).render('manage-vaccines', {
      parent: null, children: null, selectedChild: null, vaccines: null,
      error: 'Enter a valid parent NIC number.', success: null
    });
  }
  const parent = db.prepare('SELECT * FROM users WHERE nic = ? COLLATE NOCASE AND role = ?').get(nic, 'parent');
  if (!parent) {
    return res.render('manage-vaccines', {
      parent: null, children: null, selectedChild: null, vaccines: null,
      error: 'No parent found with that NIC.', success: null
    });
  }
  const children = db.prepare('SELECT * FROM children WHERE parent_id = ?').all(parent.id);
  if (children.length === 0) {
    return res.render('manage-vaccines', {
      parent: null, children: null, selectedChild: null, vaccines: null,
      error: 'This parent has no registered children yet.', success: null
    });
  }
  return res.render('manage-vaccines', {
    parent, children, selectedChild: null, vaccines: null, error: null, success: null
  });
});

app.post('/manage-vaccines/select-child', requireWorker, (req, res) => {
  const { childId } = req.body || {};
  if (!validId(childId)) return res.status(400).send('Invalid child ID.');
  const selectedChild = db.prepare('SELECT * FROM children WHERE id = ?').get(childId);
  if (!selectedChild) return res.status(404).send('Child not found.');
  const vaccines = db.prepare(VACCINE_SELECT).all(childId);
  return res.render('manage-vaccines', {
    parent: null, children: null, selectedChild, vaccines, error: null, success: null
  });
});

app.post('/manage-vaccines/complete', requireWorker, (req, res) => {
  const { vaccineId, childId } = req.body || {};
  if (!validId(vaccineId) || !validId(childId)) {
    return res.status(400).send('Invalid vaccine or child ID.');
  }
  // Both identifiers must refer to the same record; never trust hidden form fields.
  const vaccine = db.prepare('SELECT completed FROM vaccines WHERE id = ? AND child_id = ?').get(vaccineId, childId);
  if (!vaccine) return res.status(404).send('Vaccine not found for this child.');
  if (vaccine.completed) return renderVaccineList(res, childId, 'This vaccine is already completed.', true);
  const reaction = parseVaccineReaction(req.body || {});
  if (reaction.error) return renderVaccineList(res, childId, reaction.error, true);

  try {
    const today = todayDate();
    const result = db.prepare(`
      UPDATE vaccines
      SET completed = 1, completed_date = ?, completed_by = ?,
          side_effects = ?, side_effect_severity = ?, side_effect_recorded_by = ?, side_effect_date = ?
      WHERE id = ? AND child_id = ? AND completed = 0
    `).run(
      today, req.session.userId,
      reaction.description, reaction.severity,
      reaction.description ? req.session.userId : null,
      reaction.description ? today : null,
      vaccineId, childId
    );
    if (result.changes !== 1) return renderVaccineList(res, childId, 'This vaccine could not be marked completed.', true);
    return renderVaccineList(res, childId, 'Vaccine marked as completed.');
  } catch (err) {
    console.error('Vaccine completion failed:', err);
    return res.status(500).send('Unable to update the vaccination record.');
  }
});

// Reactions can only be reported for an existing completed dose belonging to the selected child.
app.post('/manage-vaccines/report-reaction', requireWorker, (req, res) => {
  const { vaccineId, childId } = req.body || {};
  if (!validId(vaccineId) || !validId(childId)) {
    return res.status(400).send('Invalid vaccine or child ID.');
  }
  const vaccine = db.prepare('SELECT completed FROM vaccines WHERE id = ? AND child_id = ?').get(vaccineId, childId);
  if (!vaccine) return res.status(404).send('Vaccine not found for this child.');
  if (!vaccine.completed) return renderVaccineList(res, childId, 'Mark this vaccine completed before reporting a reaction.', true);
  const reaction = parseVaccineReaction(req.body || {}, true);
  if (reaction.error) return renderVaccineList(res, childId, reaction.error, true);

  try {
    const result = db.prepare(`
      UPDATE vaccines
      SET side_effects = ?, side_effect_severity = ?, side_effect_recorded_by = ?, side_effect_date = ?
      WHERE id = ? AND child_id = ? AND completed = 1
    `).run(reaction.description, reaction.severity, req.session.userId, todayDate(), vaccineId, childId);
    if (result.changes !== 1) return renderVaccineList(res, childId, 'Reaction could not be saved.', true);
    return renderVaccineList(res, childId, 'Reaction report saved.');
  } catch (err) {
    console.error('Vaccine reaction update failed:', err);
    return res.status(500).send('Unable to update the reaction report.');
  }
});

app.post('/manage-vaccines/add-custom', requireWorker, (req, res) => {
  const { childId, vaccineName, dueDate } = req.body || {};
  const name = typeof vaccineName === 'string' ? vaccineName.trim() : '';
  if (!validId(childId)) return res.status(400).send('Invalid child ID.');
  if (!db.prepare('SELECT id FROM children WHERE id = ?').get(childId)) {
    return res.status(404).send('Child not found.');
  }
  if (!name || name.length > 150 || !isValidDateOnly(dueDate)) {
    return renderVaccineList(res, childId, 'Enter a vaccine name (1–150 characters) and a valid due date.', true);
  }
  try {
    db.prepare(
      'INSERT INTO vaccines (child_id, vaccine_name, due_date, completed, is_custom, recorded_by) VALUES (?, ?, ?, 0, 1, ?)'
    ).run(childId, name, dueDate, req.session.userId);
    return renderVaccineList(res, childId, 'Custom vaccine added.');
  } catch (err) {
    console.error('Custom vaccine creation failed:', err);
    return res.status(500).send('Unable to add the custom vaccine.');
  }
});

// Edit or delete only pending CUSTOM vaccine entries, never generated or completed doses.
app.post('/manage-vaccines/edit-custom', requireWorker, (req, res) => {
  const { childId, vaccineId, vaccineName, dueDate } = req.body || {};
  const name = typeof vaccineName === 'string' ? vaccineName.trim() : '';
  if (!validId(childId) || !validId(vaccineId)) {
    return res.status(400).send('Invalid record ID.');
  }
  const record = db.prepare(
    'SELECT id FROM vaccines WHERE id = ? AND child_id = ? AND is_custom = 1 AND completed = 0'
  ).get(vaccineId, childId);
  if (!record) return res.status(404).send('Editable custom vaccine not found.');
  if (!name || name.length > 150 || !isValidDateOnly(dueDate)) {
    return renderVaccineList(res, childId, 'Enter a vaccine name (1–150 characters) and a valid due date.', true);
  }
  try {
    const result = db.prepare(
      'UPDATE vaccines SET vaccine_name = ?, due_date = ? WHERE id = ? AND child_id = ? AND is_custom = 1 AND completed = 0'
    ).run(name, dueDate, vaccineId, childId);
    if (result.changes !== 1) return res.status(404).send('Editable custom vaccine not found.');
    return renderVaccineList(res, childId, 'Custom vaccine updated.');
  } catch (err) {
    console.error('Custom vaccine update failed:', err);
    return res.status(500).send('Unable to edit the custom vaccine.');
  }
});

app.post('/manage-vaccines/delete-custom', requireWorker, (req, res) => {
  const { childId, vaccineId } = req.body || {};
  if (!validId(childId) || !validId(vaccineId)) {
    return res.status(400).send('Invalid record ID.');
  }
  try {
    const result = db.prepare(
      'DELETE FROM vaccines WHERE id = ? AND child_id = ? AND is_custom = 1 AND completed = 0'
    ).run(vaccineId, childId);
    if (result.changes === 0) return res.status(404).send('Deletable custom vaccine not found.');
    return renderVaccineList(res, childId, 'Custom vaccine deleted.');
  } catch (err) {
    console.error('Custom vaccine deletion failed:', err);
    return res.status(500).send('Unable to delete the custom vaccine.');
  }
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log(`Server started on http://localhost:${PORT}`);
});