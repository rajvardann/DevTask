// DevTask server
//
// Plain Node, nothing to install. It does two jobs: serve the files in /public and answer a
// small JSON API under /api. All the data lives in a single data.json next to this file.
//
//   node server.js   ->   http://localhost:3000

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;

// Localhost only, on purpose. This is a personal tool and anyone who can reach the port can
// register an account, so there is no reason to open it to the whole network.
// Start with HOST=0.0.0.0 if you really do want that (a hosted demo, for example).
const HOST = process.env.HOST || '127.0.0.1';

const PUBLIC = path.join(__dirname, 'public');
const DATA_FILE = path.join(__dirname, 'data.json');

const STATUSES = ['TODO', 'IN PROGRESS', 'DONE'];
const PRIORITIES = ['HIGH', 'MEDIUM', 'LOW'];
const COLLECTIONS = ['users', 'projects', 'tasks', 'contexts', 'parking', 'plans'];
const MAX_SESSIONS_PER_USER = 10;
const EMAIL_RE = /^\S+@\S+\.\S+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function emptyStore() {
  return { users: [], projects: [], tasks: [], contexts: [], parking: [], plans: [], sessions: {} };
}

// Write to a temp file first and then rename it over data.json. A rename is atomic, so if the
// process dies halfway through we still have the previous complete file instead of half of a new one.
function writeJson(obj) {
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

function loadData() {
  let raw;
  try {
    raw = fs.readFileSync(DATA_FILE, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
    // first run, there is nothing to load yet
    const fresh = emptyStore();
    writeJson(fresh);
    return fresh;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // The file exists but is not valid JSON (crash while writing, hand edit gone wrong...).
    // Do not just overwrite it with an empty store, that would quietly throw the data away.
    // Keep a copy next to it and say so loudly.
    const backup = `${DATA_FILE}.corrupt-${Date.now()}`;
    fs.copyFileSync(DATA_FILE, backup);
    console.error(`data.json could not be read. A copy was kept as ${path.basename(backup)}. Starting with an empty store.`);
    return emptyStore();
  }

  // Older files may be missing a collection, make sure every one exists.
  for (const key of COLLECTIONS) {
    if (!Array.isArray(parsed[key])) parsed[key] = [];
  }
  if (!parsed.sessions || typeof parsed.sessions !== 'object') parsed.sessions = {};

  // BLOCKED was removed in v0.2. A leftover task with that status would not show up in any
  // board column, so move anything unknown back to TODO / MEDIUM.
  for (const task of parsed.tasks) {
    if (!STATUSES.includes(task.status)) task.status = 'TODO';
    if (!PRIORITIES.includes(task.priority)) task.priority = 'MEDIUM';
  }
  return parsed;
}

let data = loadData();

function save() {
  writeJson(data);
}

// Ids are just "highest existing id + 1", counted per collection.
const nextIds = {};
for (const key of COLLECTIONS) {
  nextIds[key] = data[key].reduce((max, row) => Math.max(max, row.id || 0), 0) + 1;
}
const nextId = key => nextIds[key]++;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const now = () => new Date().toISOString();
const isText = v => typeof v === 'string';
const newestFirst = (a, b) => b.created_at.localeCompare(a.created_at);

// Today as YYYY-MM-DD in the machine's own timezone. toISOString() would give the UTC date,
// which is the wrong day for a few hours every night in places like India (UTC+5:30).
function todayStr() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function isDateStr(s) {
  if (!isText(s) || !DATE_RE.test(s)) return false;
  // round trip through Date so something like 2026-02-31 gets rejected
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

const notFound = (res, message) => send(res, 404, { error: message });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 1e6) req.destroy(); // nobody needs a megabyte of JSON here
    });
    req.on('end', () => {
      try {
        const parsed = raw ? JSON.parse(raw) : {};
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        // bad JSON is treated like an empty body, the validation further down will complain
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Sessions and passwords
// ---------------------------------------------------------------------------

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(rest.join('='));
    } catch {
      // malformed cookie value, ignore it instead of failing the whole request
    }
  }
  return out;
}

function currentUser(req) {
  const userId = data.sessions[parseCookies(req).sid];
  return data.users.find(u => u.id === userId) || null;
}

function startSession(res, userId) {
  const sid = crypto.randomBytes(24).toString('hex');
  data.sessions[sid] = userId;

  // Sessions never expire by themselves, so cap how many one user can pile up. Keys come back
  // in insertion order, which means the oldest ones are first.
  const mine = Object.keys(data.sessions).filter(key => data.sessions[key] === userId);
  for (const old of mine.slice(0, Math.max(0, mine.length - MAX_SESSIONS_PER_USER))) {
    delete data.sessions[old];
  }

  save();
  res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; SameSite=Lax; Path=/`);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const [salt, hash] = stored.split(':');
    const actual = crypto.scryptSync(password, salt, 64);
    // timingSafeEqual so the response time does not hint at how much of the hash matched
    return crypto.timingSafeEqual(actual, Buffer.from(hash, 'hex'));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Data helpers (ownership, serializing)
// ---------------------------------------------------------------------------

const ownsProject = (user, projectId) =>
  data.projects.find(p => p.id === Number(projectId) && p.user_id === user.id);

// A task belongs to a user through its project.
function ownsTask(user, taskId) {
  const task = data.tasks.find(t => t.id === Number(taskId));
  return task && ownsProject(user, task.project_id) ? task : null;
}

const projectName = projectId => data.projects.find(p => p.id === projectId)?.name || '';

// Overdue is worked out every time a task is read and never stored. Storing it would mean
// something has to flip the flag at midnight, and a DONE task must never count as overdue.
const isOverdue = task => !!task.deadline && task.status !== 'DONE' && task.deadline < todayStr();

const serializeTask = task => ({
  ...task,
  project_name: projectName(task.project_id),
  overdue: isOverdue(task)
});

function serializePlan(plan) {
  const tasks = plan.task_ids
    .map(id => data.tasks.find(t => t.id === id))
    .filter(Boolean) // the task may have been deleted since the plan was saved
    .map(serializeTask);
  return { id: plan.id, date: plan.date, available_minutes: plan.available_minutes, tasks };
}

// Checks only the task fields that were actually sent and returns a message for the first bad
// one, or null when everything is fine. Used for both create and edit.
function checkTaskFields(b) {
  if ('title' in b && !(isText(b.title) && b.title.trim())) return 'Task title is required.';
  if ('description' in b && !isText(b.description)) return 'Description has to be text.';
  if ('status' in b && !STATUSES.includes(b.status)) return 'Invalid status.';
  if ('priority' in b && !PRIORITIES.includes(b.priority)) return 'Invalid priority.';
  if ('deadline' in b && b.deadline && !isDateStr(b.deadline)) return 'Deadline must be a valid date (YYYY-MM-DD).';
  if ('estimate_minutes' in b) {
    const minutes = Number(b.estimate_minutes);
    if (!Number.isFinite(minutes) || minutes < 1) return 'Estimate must be at least 1 minute.';
  }
  return null;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function handleApi(req, res, url) {
  const method = req.method;
  const parts = url.pathname.split('/').filter(Boolean); // ['api', 'tasks', '5', 'context']
  const [, resource, rid, sub] = parts;

  // --- routes that work without being logged in ---

  if (url.pathname === '/api/me' && method === 'GET') {
    const u = currentUser(req);
    return send(res, 200, { user: u ? { id: u.id, name: u.name, email: u.email } : null });
  }

  if (url.pathname === '/api/register' && method === 'POST') {
    const b = await readBody(req);
    const name = isText(b.name) ? b.name.trim() : '';
    const email = isText(b.email) ? b.email.trim().toLowerCase() : '';
    if (!name || !EMAIL_RE.test(email) || !isText(b.password) || b.password.length < 6) {
      return send(res, 400, { error: 'Name, a valid email and a password of at least 6 characters are required.' });
    }
    if (data.users.some(u => u.email === email)) {
      return send(res, 400, { error: 'An account with that email already exists.' });
    }
    const newUser = { id: nextId('users'), name, email, password_hash: hashPassword(b.password), created_at: now() };
    data.users.push(newUser);
    startSession(res, newUser.id); // also saves
    return send(res, 200, { ok: true });
  }

  if (url.pathname === '/api/login' && method === 'POST') {
    const b = await readBody(req);
    const email = isText(b.email) ? b.email.trim().toLowerCase() : '';
    const found = data.users.find(u => u.email === email);
    // same message for "no such user" and "wrong password" so it does not reveal which emails exist
    if (!found || !verifyPassword(isText(b.password) ? b.password : '', found.password_hash)) {
      return send(res, 401, { error: 'Invalid email or password.' });
    }
    startSession(res, found.id);
    return send(res, 200, { ok: true });
  }

  if (url.pathname === '/api/logout' && method === 'POST') {
    const sid = parseCookies(req).sid;
    if (sid) {
      delete data.sessions[sid];
      save();
    }
    res.setHeader('Set-Cookie', 'sid=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/');
    return send(res, 200, { ok: true });
  }

  // --- everything below needs a logged in user ---

  const user = currentUser(req);
  if (!user) return send(res, 401, { error: 'Authentication required' });

  // Projects

  if (resource === 'projects' && parts.length === 2 && method === 'GET') {
    const projects = data.projects
      .filter(p => p.user_id === user.id)
      .map(p => ({
        ...p,
        task_count: data.tasks.filter(t => t.project_id === p.id).length,
        done_count: data.tasks.filter(t => t.project_id === p.id && t.status === 'DONE').length
      }));
    return send(res, 200, projects);
  }

  if (resource === 'projects' && parts.length === 2 && method === 'POST') {
    const b = await readBody(req);
    const name = isText(b.name) ? b.name.trim() : '';
    if (!name) return send(res, 400, { error: 'Project name is required.' });
    const project = {
      id: nextId('projects'),
      user_id: user.id,
      name,
      description: isText(b.description) ? b.description : '',
      created_at: now()
    };
    data.projects.push(project);
    save();
    return send(res, 200, project);
  }

  if (resource === 'projects' && parts.length === 3 && method === 'DELETE') {
    const projectId = Number(rid);
    if (!ownsProject(user, projectId)) return notFound(res, 'Project not found.');

    // The project takes its tasks with it, and so do the contexts and plan entries of those tasks.
    const removed = new Set(data.tasks.filter(t => t.project_id === projectId).map(t => t.id));
    data.tasks = data.tasks.filter(t => !removed.has(t.id));
    data.contexts = data.contexts.filter(c => !removed.has(c.task_id));
    data.plans.forEach(plan => { plan.task_ids = plan.task_ids.filter(id => !removed.has(id)); });
    data.projects = data.projects.filter(p => p.id !== projectId);
    save();
    return send(res, 200, { ok: true });
  }

  // Tasks

  if (resource === 'tasks' && parts.length === 2 && method === 'GET') {
    const rank = { HIGH: 1, MEDIUM: 2, LOW: 3 };
    const tasks = data.tasks
      .filter(t => ownsProject(user, t.project_id))
      .map(serializeTask)
      .sort((a, b) =>
        (rank[a.priority] - rank[b.priority]) ||
        String(a.deadline || '9999').localeCompare(String(b.deadline || '9999')));
    return send(res, 200, tasks);
  }

  if (resource === 'tasks' && parts.length === 2 && method === 'POST') {
    const b = await readBody(req);
    if (!ownsProject(user, b.project_id)) return send(res, 400, { error: 'Choose a valid project for this task.' });

    // the form sends an empty estimate when the field is blank, treat that as "use the default"
    if (b.estimate_minutes === '' || b.estimate_minutes == null) delete b.estimate_minutes;

    // { title: '' } first so a missing title fails the same check as a blank one
    const problem = checkTaskFields({ title: '', ...b });
    if (problem) return send(res, 400, { error: problem });

    const task = {
      id: nextId('tasks'),
      project_id: Number(b.project_id),
      title: b.title.trim(),
      description: b.description || '',
      status: b.status || 'TODO',
      priority: b.priority || 'MEDIUM',
      deadline: b.deadline || null,
      estimate_minutes: b.estimate_minutes ? Math.round(Number(b.estimate_minutes)) : 60,
      created_at: now(),
      updated_at: now()
    };
    data.tasks.push(task);
    save();
    return send(res, 200, serializeTask(task));
  }

  if (resource === 'tasks' && parts.length === 3 && method === 'PATCH') {
    const task = ownsTask(user, rid);
    if (!task) return notFound(res, 'Task not found.');

    const b = await readBody(req);
    const problem = checkTaskFields(b);
    if (problem) return send(res, 400, { error: problem });

    // only these fields can be edited. Moving a task to another project is not supported.
    if ('title' in b) task.title = b.title.trim();
    if ('description' in b) task.description = b.description;
    if ('status' in b) task.status = b.status;
    if ('priority' in b) task.priority = b.priority;
    if ('deadline' in b) task.deadline = b.deadline || null; // the date input sends '' when cleared
    if ('estimate_minutes' in b) task.estimate_minutes = Math.round(Number(b.estimate_minutes));
    task.updated_at = now();
    save();
    return send(res, 200, serializeTask(task));
  }

  if (resource === 'tasks' && parts.length === 3 && method === 'DELETE') {
    const task = ownsTask(user, rid);
    if (!task) return notFound(res, 'Task not found.');
    data.tasks = data.tasks.filter(t => t.id !== task.id);
    data.contexts = data.contexts.filter(c => c.task_id !== task.id);
    data.plans.forEach(plan => { plan.task_ids = plan.task_ids.filter(id => id !== task.id); });
    save();
    return send(res, 200, { ok: true });
  }

  // Work context. A task can have several over time, the newest one is the one that matters.

  if (resource === 'tasks' && sub === 'context' && parts.length === 4 && method === 'GET') {
    const task = ownsTask(user, rid);
    if (!task) return notFound(res, 'Task not found.');
    const latest = data.contexts.filter(c => c.task_id === task.id).sort(newestFirst)[0] || null;
    return send(res, 200, latest);
  }

  if (resource === 'tasks' && sub === 'context' && parts.length === 4 && method === 'POST') {
    const task = ownsTask(user, rid);
    if (!task) return notFound(res, 'Task not found.');
    const b = await readBody(req);
    const text = v => (isText(v) ? v : '');
    const context = {
      id: nextId('contexts'),
      task_id: task.id,
      what_doing: text(b.what_doing),
      discovered: text(b.discovered),
      next_action: text(b.next_action),
      resources: text(b.resources),
      created_at: now()
    };
    data.contexts.push(context);
    save();
    return send(res, 200, context);
  }

  // Daily plan. One per user per date, which is why an old plan never shows up as today's.

  if (resource === 'plan' && parts.length === 2) {
    if (method === 'GET' || method === 'DELETE') {
      const date = url.searchParams.get('date') || todayStr();
      if (!isDateStr(date)) return send(res, 400, { error: 'date must look like YYYY-MM-DD.' });

      if (method === 'GET') {
        const plan = data.plans.find(p => p.user_id === user.id && p.date === date);
        return send(res, 200, plan ? serializePlan(plan) : null);
      }
      data.plans = data.plans.filter(p => !(p.user_id === user.id && p.date === date));
      save();
      return send(res, 200, { ok: true });
    }

    if (method === 'POST') {
      const b = await readBody(req);
      const date = b.date || todayStr();
      if (!isDateStr(date)) return send(res, 400, { error: 'date must look like YYYY-MM-DD.' });
      if (!Array.isArray(b.task_ids)) return send(res, 400, { error: 'task_ids must be a list.' });

      // quietly drop ids that are not this user's tasks, and any duplicates
      const taskIds = [...new Set(b.task_ids.map(Number))].filter(id => ownsTask(user, id));
      const availableMinutes = Math.max(0, Number(b.available_minutes) || 0);

      // saving again for the same date replaces the earlier plan
      let plan = data.plans.find(p => p.user_id === user.id && p.date === date);
      if (plan) {
        plan.task_ids = taskIds;
        plan.available_minutes = availableMinutes;
        plan.updated_at = now();
      } else {
        plan = {
          id: nextId('plans'),
          user_id: user.id,
          date,
          task_ids: taskIds,
          available_minutes: availableMinutes,
          created_at: now(),
          updated_at: now()
        };
        data.plans.push(plan);
      }
      save();
      return send(res, 200, serializePlan(plan));
    }
  }

  // Parking lot

  if (resource === 'parking' && parts.length === 2 && method === 'GET') {
    const ideas = data.parking.filter(i => i.user_id === user.id).sort(newestFirst);
    return send(res, 200, ideas);
  }

  if (resource === 'parking' && parts.length === 2 && method === 'POST') {
    const b = await readBody(req);
    const title = isText(b.title) ? b.title.trim() : '';
    if (!title) return send(res, 400, { error: 'Idea title is required.' });
    const idea = {
      id: nextId('parking'),
      user_id: user.id,
      title,
      description: isText(b.description) ? b.description : '',
      created_at: now()
    };
    data.parking.push(idea);
    save();
    return send(res, 200, idea);
  }

  if (resource === 'parking' && parts.length === 3 && method === 'DELETE') {
    const idea = data.parking.find(i => i.id === Number(rid) && i.user_id === user.id);
    if (!idea) return notFound(res, 'Idea not found.');
    data.parking = data.parking.filter(i => i.id !== idea.id);
    save();
    return send(res, 200, { ok: true });
  }

  if (resource === 'parking' && sub === 'convert' && parts.length === 4 && method === 'POST') {
    const idea = data.parking.find(i => i.id === Number(rid) && i.user_id === user.id);
    if (!idea) return notFound(res, 'Idea not found.');
    const b = await readBody(req);

    // use the project the client asked for, otherwise fall back to the user's first one
    const project = ownsProject(user, b.project_id) || data.projects.find(p => p.user_id === user.id);
    if (!project) return send(res, 400, { error: 'Create a project first.' });

    const task = {
      id: nextId('tasks'),
      project_id: project.id,
      title: idea.title,
      description: idea.description,
      status: 'TODO',
      priority: 'MEDIUM',
      deadline: null,
      estimate_minutes: 60,
      created_at: now(),
      updated_at: now()
    };
    data.tasks.push(task);
    data.parking = data.parking.filter(i => i.id !== idea.id);
    save();
    return send(res, 200, serializeTask(task));
  }

  // Dashboard numbers

  if (resource === 'dashboard' && parts.length === 2 && method === 'GET') {
    const myTasks = data.tasks.filter(t => ownsProject(user, t.project_id));
    const count = status => myTasks.filter(t => t.status === status).length;

    // the most recent work context among this user's tasks
    const myTaskIds = new Set(myTasks.map(t => t.id));
    const latest = data.contexts.filter(c => myTaskIds.has(c.task_id)).sort(newestFirst)[0];
    let latestContext = null;
    if (latest) {
      const task = data.tasks.find(t => t.id === latest.task_id);
      latestContext = { ...latest, title: task.title, project_name: projectName(task.project_id) };
    }

    return send(res, 200, {
      counts: { todo: count('TODO'), progress: count('IN PROGRESS'), done: count('DONE') },
      latest: latestContext,
      ideas: data.parking.filter(i => i.user_id === user.id).length
    });
  }

  return send(res, 404, { error: 'API route not found' });
}

// ---------------------------------------------------------------------------
// Static files and the server itself
// ---------------------------------------------------------------------------

function serveStatic(url, res) {
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  let file = path.join(PUBLIC, requested);

  // Stay inside /public. The trailing separator matters, otherwise a folder called
  // "public-old" would pass the startsWith check.
  if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) {
    return send(res, 403, 'Forbidden', 'text/plain');
  }

  const exists = fs.existsSync(file) && fs.statSync(file).isFile();
  if (!exists) {
    // A missing .js or .css should be a real 404. Answering with the HTML page instead makes
    // the browser error very confusing. Extension-less paths fall back to the single page.
    if (path.extname(file)) return send(res, 404, 'Not found', 'text/plain');
    file = path.join(PUBLIC, 'index.html');
  }

  res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(url, res);
  } catch (err) {
    console.error(err);
    send(res, 500, { error: 'Server error' });
  }
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Stop the other process or set a different PORT and try again.`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => console.log(`DevTask running at http://localhost:${PORT}`));
