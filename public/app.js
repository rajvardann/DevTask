// DevTask front end
//
// One page, no framework. `state` holds everything the screen needs and render() redraws the
// page from it. Every action goes the same way: call the API, update state, render() again.
// It is not the fastest way to do it, but the screen and the data can't drift apart.

const app = document.getElementById('app');

const freshState = () => ({
  user: null,
  page: 'dashboard',
  projects: [],
  tasks: [],
  parking: [],
  dashboard: null,
  plan: null,         // the saved plan for today, or null
  previewPlan: null,  // task ids from "Generate plan" that have not been saved yet
  previewMinutes: null
});
let state = freshState();

// Everything that comes from a user goes through esc() before it lands in innerHTML. Don't skip it.
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const emptyState = message => `<div class="empty">${esc(message)}</div>`;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// ---------------------------------------------------------------------------
// Talking to the server
// ---------------------------------------------------------------------------

// Thin fetch wrapper. On a failed request it throws an Error carrying the server's message,
// so callers can just catch it and show it.
async function api(url, opt = {}) {
  const res = await fetch(url, { headers: { 'Content-Type': 'application/json', ...(opt.headers || {}) }, ...opt });
  let body = {};
  try { body = await res.json(); } catch { /* empty or non-JSON body, nothing to read */ }

  if (!res.ok) {
    // A 401 while we think we are logged in means the session is gone (data reset, cookie
    // cleared...). Go back to the login screen instead of leaving a page that does nothing.
    if (res.status === 401 && state.user) {
      state = freshState();
      render();
      throw new Error('Your session has expired. Please log in again.');
    }
    throw new Error(body.error || 'Request failed');
  }
  return body;
}

// Fetches everything the screens need in one go, then redraws.
async function load() {
  const [projects, tasks, parking, dashboard, plan] = await Promise.all([
    api('/api/projects'), api('/api/tasks'), api('/api/parking'), api('/api/dashboard'), api('/api/plan')
  ]);
  Object.assign(state, { projects, tasks, parking, dashboard, plan });
  // Any change (status, delete...) can make an unsaved preview wrong, so throw it away.
  state.previewPlan = null;
  state.previewMinutes = null;
  render();
}

// For click handlers that call the API: show the error instead of failing silently.
function safely(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (err) {
      alert(err.message || 'Something went wrong.');
    }
  };
}

// ---------------------------------------------------------------------------
// Layout, login and registration
// ---------------------------------------------------------------------------

const goTo = page => { state.page = page; render(); };

function shell(content) {
  const links = [['dashboard', 'Dashboard'], ['projects', 'Projects'], ['tasks', 'Task Board'], ['today', 'Today'], ['parking', 'Parking Lot']];
  return `<div class="shell">
    <aside class="sidebar">
      <div class="brand">Dev<span>Task</span></div>
      <nav class="nav">${links.map(([key, label]) =>
        `<button class="${state.page === key ? 'active' : ''}" data-page="${key}">${label}</button>`).join('')}</nav>
      <button id="logout" class="btn logout">Log out</button>
    </aside>
    <main class="main">${content}</main>
  </div>`;
}

function render() {
  if (!state.user) return renderAuth();
  app.innerHTML = shell(pages[state.page]());
  document.querySelectorAll('[data-page]').forEach(b => { b.onclick = () => goTo(b.dataset.page); });
  document.getElementById('logout').onclick = safely(async () => {
    await api('/api/logout', { method: 'POST' });
    state = freshState(); // don't keep the previous user's data around in memory
    render();
  });
  bindPage();
}

function renderAuth() {
  app.innerHTML = `<div class="auth"><div class="authbox">
    <div class="eyebrow">Personal developer workspace</div>
    <h1>DevTask</h1>
    <p class="muted">Organize development work. Remember where you left off. Plan today. Park distractions.</p>
    <div class="actions"><button class="btn primary" id="showLogin">Login</button><button class="btn" id="showReg">Create account</button></div>
    <div id="authForm" style="margin-top:18px"></div>
  </div></div>`;
  showLogin();
  document.getElementById('showLogin').onclick = showLogin;
  document.getElementById('showReg').onclick = showReg;
}

// Login and register differ only in the fields and the endpoint, so they share this.
function authForm({ id, fields, button, endpoint }) {
  document.getElementById('authForm').innerHTML = `<form class="form" id="${id}">${fields}
    <button class="btn primary">${button}</button><div id="authMsg"></div></form>`;
  document.getElementById(id).onsubmit = async e => {
    e.preventDefault();
    try {
      const values = Object.fromEntries(new FormData(e.target));
      await api(endpoint, { method: 'POST', body: JSON.stringify(values) });
      state.user = (await api('/api/me')).user;
      await load();
    } catch (err) {
      document.getElementById('authMsg').innerHTML = `<div class="error">${esc(err.message)}</div>`;
    }
  };
}

const showLogin = () => authForm({
  id: 'loginForm', button: 'Login', endpoint: '/api/login',
  fields: `<div class="field"><label>Email</label><input name="email" type="email" autocomplete="email" required></div>
           <div class="field"><label>Password</label><input name="password" type="password" autocomplete="current-password" required></div>`
});

const showReg = () => authForm({
  id: 'regForm', button: 'Create account', endpoint: '/api/register',
  fields: `<div class="field"><label>Name</label><input name="name" autocomplete="name" required></div>
           <div class="field"><label>Email</label><input name="email" type="email" autocomplete="email" required></div>
           <div class="field"><label>Password</label><input name="password" type="password" minlength="6" autocomplete="new-password" required></div>`
});

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

const pages = {
  dashboard() {
    const d = state.dashboard;
    const plan = state.plan;
    const hasPlan = plan && plan.tasks.length > 0;
    return `<div class="top">
      <div><div class="eyebrow">Dashboard</div><h1 class="title">Good to see you, ${esc(state.user.name)}</h1></div>
      <button class="btn primary" id="quickTask">+ New task</button>
    </div>
    <div class="grid grid3">
      <div class="card"><div class="muted">Active tasks</div><div class="metric">${(d.counts.todo || 0) + (d.counts.progress || 0)}</div></div>
      <div class="card"><div class="muted">Completed</div><div class="metric">${d.counts.done || 0}</div></div>
      <div class="card"><div class="muted">Parking lot</div><div class="metric">${d.ideas}</div></div>
    </div>
    <div class="card" style="margin-top:16px">
      <div class="row"><h2>Projects</h2><button class="btn small" id="dashNewProject">+ New project</button></div>
      ${state.projects.length
        ? `<div class="grid grid2" style="margin-top:12px">${state.projects.slice(0, 4).map(p => `<button class="project-mini" data-view-project>
            <div class="row"><h3>${esc(p.name)}</h3><span class="muted">${plural(p.task_count || 0, 'task')}</span></div>
            <p class="muted">${esc(p.description || 'No description')}</p>
            <p class="muted small">${p.done_count || 0} completed</p>
          </button>`).join('')}</div>
          ${state.projects.length > 4 ? `<div class="actions" style="margin-top:12px"><button class="btn small" id="viewAllProjects">View all ${state.projects.length} projects</button></div>` : ''}`
        : `<div class="empty-block" style="margin-top:10px"><p class="muted">No projects yet. Create your first one to start planning tasks.</p><button class="btn primary" id="dashNewProjectEmpty">+ Create a project</button></div>`}
    </div>
    <div class="grid grid2" style="margin-top:16px">
      <div class="card">
        <div class="row"><h2>Today's work</h2>${hasPlan ? `<button class="btn small" id="goToday">Open Today</button>` : ''}</div>
        ${hasPlan
          ? `<p class="muted small">${plural(plan.tasks.length, 'task')} planned · ${plan.available_minutes} minutes budgeted</p><div class="stack">${plan.tasks.map(taskMini).join('')}</div>`
          : `<div class="empty-block"><p class="muted">Nothing planned yet.</p><button class="btn primary" id="planMyDay">Plan my day</button></div>`}
      </div>
      <div class="card">
        <h2>Last work context</h2>
        ${d.latest ? `<div class="context">
            <b>${esc(d.latest.title)}</b>
            <p><b>Doing:</b> ${esc(d.latest.what_doing)}</p>
            <p><b>Discovered:</b> ${esc(d.latest.discovered)}</p>
            <p><b>Next:</b> ${esc(d.latest.next_action)}</p>
            <button class="btn small" data-open-task="${d.latest.task_id}">Open task</button>
          </div>` : emptyState('Save a context on a task and it will appear here.')}
      </div>
    </div>`;
  },

  projects() {
    return `<div class="top">
      <div><div class="eyebrow">Projects</div><h1 class="title">My projects</h1></div>
      <button class="btn primary" id="newProject">+ New project</button>
    </div>
    <div class="grid grid2">${state.projects.length ? state.projects.map(p => `<div class="card">
        <div class="row"><div><h2>${esc(p.name)}</h2><p class="muted">${esc(p.description || 'No description')}</p></div>
        <button class="btn danger small" data-delete-project="${p.id}">Delete</button></div>
        <p class="muted">${plural(p.task_count || 0, 'task')} · ${p.done_count || 0} completed</p>
      </div>`).join('') : `<div class="card empty-block"><p class="muted">Create your first development project.</p><button class="btn primary" id="newProjectEmpty">+ New project</button></div>`}</div>`;
  },

  tasks() {
    const columns = [['TODO', 'To do'], ['IN PROGRESS', 'In progress'], ['DONE', 'Done']];
    return `<div class="top">
      <div><div class="eyebrow">Task Board</div><h1 class="title">Development tasks</h1></div>
      <button class="btn primary" id="newTask">+ New task</button>
    </div>
    <div class="task-grid">${columns.map(([status, label]) => {
      const items = state.tasks.filter(t => t.status === status);
      return `<section class="column">
        <div class="column-head"><h3>${label}</h3><span class="count-badge">${items.length}</span></div>
        <div class="column-body">${items.length ? items.map(taskCard).join('') : emptyState('No tasks here yet.')}</div>
      </section>`;
    }).join('')}</div>`;
  },

  today() {
    const saved = state.plan;
    // the preview only stores ids, look the tasks up again in case one was deleted meanwhile
    const previewTasks = state.previewPlan
      ? state.previewPlan.map(id => state.tasks.find(t => t.id === id)).filter(Boolean)
      : null;
    const defaultHours = state.previewMinutes
      ? state.previewMinutes / 60
      : (saved?.available_minutes ? saved.available_minutes / 60 : 5);

    let previewHtml;
    if (previewTasks === null) previewHtml = emptyState('Enter your available hours and generate a plan.');
    else if (!previewTasks.length) previewHtml = emptyState('No tasks fit in that time window.');
    else previewHtml = previewTasks.map(planItem).join('') + `<button class="btn primary" id="savePlan" style="margin-top:6px">Save as today's plan</button>`;

    return `<div class="top"><div><div class="eyebrow">Today</div><h1 class="title">What should I work on?</h1></div></div>
    <div class="card">
      <h2>Plan your day</h2>
      <p class="muted">Set your available time. Tasks are ranked by priority, then deadline, then by what fits your budget.</p>
      <div class="actions">
        <div class="field-inline"><label for="available">Hours available</label><input id="available" type="number" min="1" max="24" step="0.5" value="${defaultHours}"></div>
        <button class="btn primary" id="generatePlan">Generate plan</button>
      </div>
      <div class="stack" style="margin-top:16px">${previewHtml}</div>
    </div>
    <div class="card" style="margin-top:16px">
      <div class="row"><h2>Today's saved plan</h2>${saved ? `<button class="btn danger small" id="clearPlan">Clear plan</button>` : ''}</div>
      ${saved && saved.tasks.length
        ? `<p class="muted small">${plural(saved.tasks.length, 'task')} · ${saved.available_minutes} minutes budgeted</p><div class="stack">${saved.tasks.map(planItem).join('')}</div>`
        : emptyState('No plan saved for today yet. Generate one above and save it.')}
    </div>`;
  },

  parking() {
    return `<div class="top">
      <div><div class="eyebrow">Parking Lot</div><h1 class="title">Ideas without interruptions</h1></div>
      <button class="btn primary" id="newIdea">+ Park idea</button>
    </div>
    <div class="stack">${state.parking.length ? state.parking.map(idea => `<div class="idea">
        <div class="row"><div><h3>${esc(idea.title)}</h3><p class="muted">${esc(idea.description || '')}</p></div>
        <div class="actions"><button class="btn small" data-convert="${idea.id}">Convert to task</button><button class="btn danger small" data-delete-idea="${idea.id}">Delete</button></div></div>
      </div>`).join('') : `<div class="card empty-block"><p class="muted">Your parking lot is empty. Anything that pops into your head mid-task can go here.</p></div>`}</div>`;
  }
};

// ---------------------------------------------------------------------------
// Task markup shared by several pages
// ---------------------------------------------------------------------------

const overdueTag = () => `<span class="overdue-tag">Overdue</span>`;

// compact version for the dashboard
function taskMini(t) {
  return `<div class="task ${t.overdue ? 'overdue' : ''}">
    <div class="row"><div>
      <div class="task-title">${esc(t.title)}</div>
      <div class="muted small">${esc(t.project_name)} · ${t.estimate_minutes}m${t.deadline ? ' · due ' + esc(t.deadline) : ''}</div>
    </div>
    <div class="stack-right">${t.overdue ? overdueTag() : ''}<span class="pill ${t.priority.toLowerCase()}">${t.priority}</span></div></div>
  </div>`;
}

// card on the board, with the status dropdown
function taskCard(t) {
  const statusOptions = ['TODO', 'IN PROGRESS', 'DONE']
    .map(s => `<option value="${s}" ${t.status === s ? 'selected' : ''}>${s}</option>`).join('');
  return `<div class="task ${t.overdue ? 'overdue' : ''}">
    <div class="task-title">${esc(t.title)}</div>
    <p class="muted small">${esc(t.project_name)}</p>
    <div class="actions">
      <span class="pill ${t.priority.toLowerCase()}">${t.priority}</span>
      ${t.overdue ? overdueTag() : ''}
      ${t.deadline ? `<span class="muted small">${esc(t.deadline)}</span>` : ''}
    </div>
    <div class="actions" style="margin-top:10px">
      <button class="btn small" data-open-task="${t.id}">Open</button>
      <select class="btn small" data-status="${t.id}">${statusOptions}</select>
    </div>
  </div>`;
}

// row in a plan (preview and saved)
function planItem(t, i) {
  return `<div class="task ${t.overdue ? 'overdue' : ''}">
    <div class="row"><b>${i + 1}. ${esc(t.title)}</b>${t.overdue ? overdueTag() : ''}</div>
    <span class="muted small">${esc(t.project_name || '')} · ${t.estimate_minutes}m · ${t.priority} priority${t.deadline ? ' · due ' + esc(t.deadline) : ''}</span>
  </div>`;
}

// ---------------------------------------------------------------------------
// Daily plan logic
// ---------------------------------------------------------------------------

// Order for the plan: higher priority first, then the earlier deadline (no deadline goes last),
// then the shorter task so more of them fit into the day.
// Don't try to be clever and squeeze this into one subtraction. An earlier version did and
// a HIGH task without a deadline ended up below a LOW one.
function byPriorityThenDeadline(a, b) {
  const rank = { HIGH: 1, MEDIUM: 2, LOW: 3 };
  if (rank[a.priority] !== rank[b.priority]) return rank[a.priority] - rank[b.priority];

  const da = a.deadline || '';
  const db = b.deadline || '';
  if (da !== db) {
    if (!da) return 1;
    if (!db) return -1;
    return da.localeCompare(db); // YYYY-MM-DD sorts correctly as plain text
  }
  return a.estimate_minutes - b.estimate_minutes;
}

// Walks the sorted list and takes whatever still fits. A long task that doesn't fit is skipped,
// but a shorter one further down can still make it in.
function choosePlanTasks(sortedTasks, minutesBudget) {
  let used = 0;
  const chosen = [];
  for (const task of sortedTasks) {
    if (used + task.estimate_minutes <= minutesBudget) {
      chosen.push(task);
      used += task.estimate_minutes;
    }
  }
  return chosen;
}

// ---------------------------------------------------------------------------
// Wiring up the page after each render
// ---------------------------------------------------------------------------

function openNewTask() {
  // every task needs a project, so send people to create one first
  if (!state.projects.length) return noProjectsModal();
  taskModal();
}

function bindPage() {
  const on = (id, fn) => document.getElementById(id)?.addEventListener('click', fn);

  on('quickTask', openNewTask);
  on('newTask', openNewTask);
  ['newProject', 'newProjectEmpty', 'dashNewProject', 'dashNewProjectEmpty'].forEach(id => on(id, projectModal));
  on('newIdea', ideaModal);
  on('viewAllProjects', () => goTo('projects'));
  on('goToday', () => goTo('today'));
  on('planMyDay', () => goTo('today'));

  document.querySelectorAll('[data-view-project]').forEach(b => { b.onclick = () => goTo('projects'); });
  document.querySelectorAll('[data-open-task]').forEach(b => { b.onclick = () => taskModal(Number(b.dataset.openTask)); });

  document.querySelectorAll('[data-status]').forEach(select => {
    select.onchange = safely(async () => {
      await api(`/api/tasks/${select.dataset.status}`, { method: 'PATCH', body: JSON.stringify({ status: select.value }) });
      await load();
    });
  });

  document.querySelectorAll('[data-delete-project]').forEach(b => {
    b.onclick = safely(async () => {
      if (!confirm('Delete this project and its tasks?')) return;
      await api(`/api/projects/${b.dataset.deleteProject}`, { method: 'DELETE' });
      await load();
    });
  });

  document.querySelectorAll('[data-delete-idea]').forEach(b => {
    b.onclick = safely(async () => {
      await api(`/api/parking/${b.dataset.deleteIdea}`, { method: 'DELETE' });
      await load();
    });
  });

  document.querySelectorAll('[data-convert]').forEach(b => {
    b.onclick = safely(() => convertIdea(Number(b.dataset.convert)));
  });

  // Today page
  on('generatePlan', () => {
    const hours = Number(document.getElementById('available').value) || 0;
    const minutes = Math.max(0, Math.round(hours * 60));
    const open = state.tasks.filter(t => t.status !== 'DONE').sort(byPriorityThenDeadline);
    state.previewPlan = choosePlanTasks(open, minutes).map(t => t.id);
    state.previewMinutes = minutes;
    render();
  });

  document.getElementById('savePlan')?.addEventListener('click', safely(async () => {
    await api('/api/plan', { method: 'POST', body: JSON.stringify({ task_ids: state.previewPlan, available_minutes: state.previewMinutes }) });
    state.plan = await api('/api/plan');
    state.previewPlan = null;
    state.previewMinutes = null;
    render();
  }));

  document.getElementById('clearPlan')?.addEventListener('click', safely(async () => {
    if (!confirm("Clear today's saved plan?")) return;
    await api('/api/plan', { method: 'DELETE' });
    state.plan = null;
    render();
  }));
}

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------

function overlay(html) {
  const el = document.createElement('div');
  el.className = 'modal';
  el.innerHTML = `<div class="modal-box">${html}</div>`;
  document.body.appendChild(el);
  return el;
}

function showFormError(form, message) {
  form.querySelector('.error')?.remove(); // replace the old message, don't stack them
  form.insertAdjacentHTML('beforeend', `<div class="error">${esc(message)}</div>`);
}

// Shared submit handling for the modal forms. It stops double clicks from sending the request
// twice (that used to create duplicate tasks) and shows any error inside the form.
function handleSubmit(form, work) {
  form.onsubmit = async e => {
    e.preventDefault();
    const button = form.querySelector('button:not([type=button])');
    button.disabled = true;
    try {
      await work(Object.fromEntries(new FormData(form)));
    } catch (err) {
      showFormError(form, err.message);
      button.disabled = false;
    }
  };
}

const postJson = (url, method, values) => api(url, { method, body: JSON.stringify(values) });

function noProjectsModal() {
  const m = overlay(`<div class="row"><h2>No projects yet</h2><button class="btn" data-close>Close</button></div>
    <div class="empty-block">
      <p class="muted">Every task needs to belong to a project, so create one first. It only takes a moment.</p>
      <button class="btn primary" id="createProjectFromNotice">+ Create your first project</button>
    </div>`);
  m.querySelector('[data-close]').onclick = () => m.remove();
  m.querySelector('#createProjectFromNotice').onclick = () => { m.remove(); projectModal(); };
}

function projectModal() {
  const m = overlay(`<div class="row"><h2>New project</h2><button class="btn" data-close>Close</button></div>
    <form class="form">
      <div class="field"><label>Name</label><input name="name" required></div>
      <div class="field"><label>Description</label><textarea name="description"></textarea></div>
      <button class="btn primary">Create project</button>
    </form>`);
  m.querySelector('[data-close]').onclick = () => m.remove();
  handleSubmit(m.querySelector('form'), async values => {
    await postJson('/api/projects', 'POST', values);
    m.remove();
    await load();
  });
}

// One modal for both creating a task (no id) and opening an existing one.
function taskModal(id) {
  if (!id && !state.projects.length) return noProjectsModal();
  const task = id ? state.tasks.find(t => t.id === id) : null;
  if (id && !task) return; // it was deleted while the page was open, nothing to show

  const m = overlay(`<div class="row"><h2>${task ? 'Task details' : 'New task'}</h2><button class="btn" data-close>Close</button></div>${task ? taskDetailForm(task) : taskCreateForm()}`);
  m.querySelector('[data-close]').onclick = () => m.remove();

  handleSubmit(m.querySelector('form'), async values => {
    if (task) await postJson(`/api/tasks/${task.id}`, 'PATCH', values);
    else await postJson('/api/tasks', 'POST', values);
    m.remove();
    await load();
  });

  m.querySelector('[data-save-context]')?.addEventListener('click', safely(() => contextModal(task)));
  m.querySelector('[data-delete-task]')?.addEventListener('click', safely(async () => {
    if (!confirm('Delete task?')) return;
    await api(`/api/tasks/${task.id}`, { method: 'DELETE' });
    m.remove();
    await load();
  }));
}

const projectOptions = selected => state.projects
  .map(p => `<option value="${p.id}" ${String(p.id) === String(selected) ? 'selected' : ''}>${esc(p.name)}</option>`).join('');

function taskCreateForm() {
  return `<form class="form">
    <div class="field"><label>Title</label><input name="title" required></div>
    <div class="field"><label>Project</label><select name="project_id" required>${projectOptions(state.projects[0]?.id)}</select></div>
    <div class="field"><label>Description</label><textarea name="description"></textarea></div>
    <div class="grid grid2">
      <div class="field"><label>Status</label><select name="status"><option>TODO</option><option>IN PROGRESS</option><option>DONE</option></select></div>
      <div class="field"><label>Priority</label><select name="priority"><option>HIGH</option><option selected>MEDIUM</option><option>LOW</option></select></div>
    </div>
    <div class="grid grid2">
      <div class="field"><label>Deadline</label><input type="date" name="deadline"></div>
      <div class="field"><label>Estimate (minutes)</label><input type="number" name="estimate_minutes" min="1" value="60" required></div>
    </div>
    <button class="btn primary">Create task</button>
  </form>`;
}

function taskDetailForm(t) {
  const option = (value, current) => `<option ${value === current ? 'selected' : ''}>${value}</option>`;
  return `<form class="form">
    ${t.overdue ? `<div class="overdue-banner">This task is overdue.</div>` : ''}
    <div class="field"><label>Title</label><input name="title" value="${esc(t.title)}" required></div>
    <div class="field"><label>Project</label><select name="project_id" disabled>${projectOptions(t.project_id)}</select></div>
    <div class="field"><label>Description</label><textarea name="description">${esc(t.description)}</textarea></div>
    <div class="grid grid2">
      <div class="field"><label>Status</label><select name="status">${['TODO', 'IN PROGRESS', 'DONE'].map(s => option(s, t.status)).join('')}</select></div>
      <div class="field"><label>Priority</label><select name="priority">${['HIGH', 'MEDIUM', 'LOW'].map(s => option(s, t.priority)).join('')}</select></div>
    </div>
    <div class="grid grid2">
      <div class="field"><label>Deadline</label><input type="date" name="deadline" value="${esc(t.deadline || '')}"></div>
      <div class="field"><label>Estimate (minutes)</label><input type="number" name="estimate_minutes" min="1" value="${t.estimate_minutes}" required></div>
    </div>
    <div class="actions">
      <button class="btn primary">Save task</button>
      <button type="button" class="btn" data-save-context>Update context</button>
      <button type="button" class="btn danger" data-delete-task>Delete</button>
    </div>
  </form>`;
}

// Where you note down what you were doing before getting pulled away.
// It also covers "I'm stuck", which is why there is no BLOCKED status.
async function contextModal(task) {
  const previous = await api(`/api/tasks/${task.id}/context`); // null if there is none yet
  const m = overlay(`<div class="row"><h2>Save work context</h2><button class="btn" data-close>Close</button></div>
    <p class="muted">This is the core "where did I leave off?" feature.</p>
    <form class="form">
      <div class="field"><label>What were you doing?</label><textarea name="what_doing">${esc(previous?.what_doing || '')}</textarea></div>
      <div class="field"><label>What did you discover?</label><textarea name="discovered">${esc(previous?.discovered || '')}</textarea></div>
      <div class="field"><label>What is the next action?</label><textarea name="next_action">${esc(previous?.next_action || '')}</textarea></div>
      <div class="field"><label>Relevant files / links</label><textarea name="resources">${esc(previous?.resources || '')}</textarea></div>
      <button class="btn primary">Save context</button>
    </form>`);
  m.querySelector('[data-close]').onclick = () => m.remove();
  handleSubmit(m.querySelector('form'), async values => {
    await postJson(`/api/tasks/${task.id}/context`, 'POST', values);
    m.remove();
    await load();
  });
}

function ideaModal() {
  const m = overlay(`<div class="row"><h2>Park an idea</h2><button class="btn" data-close>Close</button></div>
    <form class="form">
      <div class="field"><label>Idea</label><input name="title" required placeholder="e.g. Add Google Login"></div>
      <div class="field"><label>Notes</label><textarea name="description"></textarea></div>
      <button class="btn primary">Save to parking lot</button>
    </form>`);
  m.querySelector('[data-close]').onclick = () => m.remove();
  handleSubmit(m.querySelector('form'), async values => {
    await postJson('/api/parking', 'POST', values);
    m.remove();
    await load();
  });
}

// TODO: let the user pick the project. For now the idea goes into the first project in the list.
async function convertIdea(id) {
  if (!state.projects.length) return noProjectsModal();
  await postJson(`/api/parking/${id}/convert`, 'POST', { project_id: state.projects[0].id });
  await load();
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

(async () => {
  try {
    state.user = (await api('/api/me')).user;
    if (state.user) await load();
    else render();
  } catch {
    app.innerHTML = '<div class="boot-loading">Could not reach the DevTask server. Is it running?</div>';
  }
})();
