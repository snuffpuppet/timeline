/* ══════════════════════════════════════════════════════════════
   Gantt Planner — app.js
   ══════════════════════════════════════════════════════════════ */

// ── Constants ────────────────────────────────────────────────
const FALLBACK_COLORS = [
  '#4a7cf8','#10b981','#f59e0b','#8b5cf6','#ec4899',
  '#06b6d4','#ef4444','#84cc16','#f97316','#6366f1'
];
const DEFAULT_TEAM_COLORS = [
  '#4a7cf8','#10b981','#f59e0b','#8b5cf6','#ec4899',
  '#06b6d4','#ef4444','#f97316','#6366f1','#84cc16'
];
const GANTT_HEADER_H = 56;
const ROW_H = 40;
const BAR_H = 24;
const BAR_TOP = (ROW_H - BAR_H) / 2;

const ACTIVITY_TYPES = [
  { id: 'discovery',    label: 'Discovery',    color: '#0d9488' },
  { id: 'design',       label: 'Design',       color: '#7c3aed' },
  { id: 'build',        label: 'Build',        color: '#2563eb' },
  { id: 'int-test',     label: 'Int. Test',    color: '#d97706' },
  { id: 'uat',          label: 'UAT',          color: '#ea580c' },
  { id: 'data-cleanse', label: 'Data Cleanse', color: '#059669' },
  { id: 'migration',    label: 'Migration',    color: '#0891b2' },
  { id: 'release',      label: 'Release',      color: '#dc2626' },
  { id: 'milestone',    label: 'Milestone',    color: '#475569' },
];

const CARD_W = 210;
const CARD_H = 86;
const CANVAS_COL_GAP = 290;
const CANVAS_ROW_GAP = 100;

const DEP_TYPES = ['FS', 'FF', 'SS'];

// ── State ────────────────────────────────────────────────────
let state = {
  projects: [],
  currentId: null,
  view: 'table',
  zoom: 'week',
  dirty: false,
  teamFilter: null, // team ID to highlight, or null for all
};

let saveTimer = null;
let activePopoverTaskId = null;
let dragDep = null; // { fromId, fromX, fromY } — active Gantt drag state

let canvasState = { pan: { x: 60, y: 60 }, zoom: 1 };
let collapsedDeliverables = new Set(); // deliverable IDs collapsed in Gantt view
let collapsedStreams = new Set();      // stream IDs collapsed in Gantt view
let collapsedGroups = new Set();       // task group IDs collapsed in Gantt view
let canvasDepDrag = null;
let _taskRowMap = {}; // taskId → 1-based index in p.tasks[], rebuilt by renderTable

// ── Helpers ──────────────────────────────────────────────────
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function fmt(date) {
  if (!date) return '';
  return date.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function daysBetween(a, b) {
  return Math.round((b - a) / 86400000);
}

function currentProject() {
  return state.projects.find(p => p.id === state.currentId) || null;
}

function colorForIndex(i) {
  return FALLBACK_COLORS[i % FALLBACK_COLORS.length];
}

function actTypeInfo(id) {
  return ACTIVITY_TYPES.find(t => t.id === id) || null;
}

function actTypeOrder(id) {
  const i = ACTIVITY_TYPES.findIndex(t => t.id === id);
  return i === -1 ? 99 : i;
}

// Normalize deps: supports legacy string[] and new {id,type}[] formats
function normalizeDeps(deps) {
  return (deps || []).map(d => typeof d === 'string' ? { id: d, type: 'FS' } : d);
}

// ── Schedule Computation ─────────────────────────────────────
function computeSchedule(project) {
  const tasks = project.tasks;
  if (!tasks.length) return {};

  const byId = {};
  tasks.forEach(t => { byId[t.id] = t; });

  const inDeg = {};
  const adj = {}; // pred → [{succId, type}]
  tasks.forEach(t => { inDeg[t.id] = 0; adj[t.id] = []; });

  for (const t of tasks) {
    for (const dep of normalizeDeps(t.dependencies)) {
      if (byId[dep.id]) {
        adj[dep.id].push({ succId: t.id, type: dep.type });
        inDeg[t.id]++;
      }
    }
  }

  const queue = tasks.filter(t => inDeg[t.id] === 0).map(t => t.id);
  const order = [];

  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    for (const { succId } of adj[id]) {
      if (--inDeg[succId] === 0) queue.push(succId);
    }
  }

  if (order.length !== tasks.length) return null; // cycle

  const earlyStart = {};
  const earlyEnd = {};
  for (const id of order) {
    const t = byId[id];
    const dur = t.duration || 1;
    const normDeps = normalizeDeps(t.dependencies).filter(d => byId[d.id]);
    let start = 0;
    if (normDeps.length) {
      start = Math.max(0, Math.max(...normDeps.map(dep => {
        if (dep.type === 'FF') return (earlyEnd[dep.id] || 0) - dur;
        if (dep.type === 'SS') return earlyStart[dep.id] || 0;
        return earlyEnd[dep.id] || 0; // FS (default)
      })));
    }
    earlyStart[id] = start;
    earlyEnd[id] = start + dur;
  }

  const projectDuration = Math.max(...Object.values(earlyEnd));
  const lateEnd = {};
  const lateStart = {};

  for (const id of [...order].reverse()) {
    const dur = byId[id].duration || 1;
    let lateE = projectDuration;
    for (const { succId, type } of adj[id]) {
      if (!byId[succId]) continue;
      if (type === 'FF') lateE = Math.min(lateE, lateEnd[succId]);
      else if (type === 'SS') lateE = Math.min(lateE, lateStart[succId] + dur);
      else lateE = Math.min(lateE, lateStart[succId]); // FS
    }
    lateEnd[id] = lateE;
    lateStart[id] = lateE - dur;
  }

  const result = {};
  for (const id of order) {
    result[id] = {
      startDay: earlyStart[id],
      endDay: earlyEnd[id] - 1,
      isCritical: (lateStart[id] - earlyStart[id]) === 0,
    };
  }
  return result;
}

// ── Data Load / Save ─────────────────────────────────────────
async function loadData() {
  try {
    const res = await fetch('/api/data');
    const data = await res.json();
    state.projects = data.projects || [];
  } catch {
    state.projects = [];
  }
  if (state.projects.length) state.currentId = state.projects[0].id;
  renderAll();
}

async function saveData() {
  state.dirty = false;
  updateSaveIndicator();
  try {
    await fetch('/api/data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projects: state.projects }),
    });
  } catch { console.error('Save failed'); }
}

function markDirty() {
  state.dirty = true;
  updateSaveIndicator();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveData, 1200);
}

function updateSaveIndicator() {
  const el = document.getElementById('save-indicator');
  if (state.dirty) {
    el.textContent = 'Unsaved changes';
    el.classList.add('unsaved');
  } else {
    el.textContent = 'Saved';
    el.classList.remove('unsaved');
  }
}

// ── Project Operations ───────────────────────────────────────
function newProject() {
  const today = new Date().toISOString().slice(0, 10);
  const p = { id: uid(), name: 'New Project', startDate: today, streams: [], teams: [], deliverables: [], taskGroups: [], tasks: [] };
  state.projects.push(p);
  state.currentId = p.id;
  state.teamFilter = null;
  markDirty();
  renderAll();
  setTimeout(() => { const el = document.getElementById('project-name'); el.focus(); el.select(); }, 50);
}

function deleteProject(id) {
  state.projects = state.projects.filter(p => p.id !== id);
  if (state.currentId === id) state.currentId = state.projects.length ? state.projects[0].id : null;
  state.teamFilter = null;
  markDirty();
  renderAll();
}

function selectProject(id) {
  state.currentId = id;
  state.teamFilter = null;
  renderAll();
}

// ── Team Operations ──────────────────────────────────────────
function getTeams() {
  return currentProject()?.teams || [];
}

function addTeam() {
  const p = currentProject();
  if (!p) return;
  if (!p.teams) p.teams = [];
  const color = DEFAULT_TEAM_COLORS[p.teams.length % DEFAULT_TEAM_COLORS.length];
  const team = { id: uid(), name: 'New Team', color };
  p.teams.push(team);
  markDirty();
  renderTeamsModal();
}

function deleteTeam(teamId) {
  const p = currentProject();
  if (!p) return;
  p.teams = (p.teams || []).filter(t => t.id !== teamId);
  // Remove from tasks
  p.tasks.forEach(t => {
    t.teams = (t.teams || []).filter(id => id !== teamId);
  });
  if (state.teamFilter === teamId) state.teamFilter = null;
  markDirty();
  renderTeamsModal();
  renderAll();
}

function updateTeam(teamId, field, value) {
  const p = currentProject();
  if (!p) return;
  const team = (p.teams || []).find(t => t.id === teamId);
  if (!team) return;
  team[field] = value;
  markDirty();
  // Re-render table teams cells and gantt
  renderAll();
}

// ── Deliverable Operations ────────────────────────────────────
function addDeliverable() {
  const p = currentProject(); if (!p) return;
  if (!p.deliverables) p.deliverables = [];
  const color = DEFAULT_TEAM_COLORS[p.deliverables.length % DEFAULT_TEAM_COLORS.length];
  p.deliverables.push({ id: uid(), name: 'New Deliverable', color });
  markDirty();
  renderDeliverablesModal();
  renderAll();
}

function deleteDeliverable(delivId) {
  const p = currentProject(); if (!p) return;
  const groupIds = new Set((p.taskGroups || []).filter(g => g.deliverableId === delivId).map(g => g.id));
  p.deliverables = (p.deliverables || []).filter(d => d.id !== delivId);
  p.taskGroups = (p.taskGroups || []).filter(g => g.deliverableId !== delivId);
  p.tasks.forEach(t => {
    if (t.deliverableId === delivId) { t.deliverableId = null; t.groupId = null; }
  });
  markDirty();
  renderDeliverablesModal();
  renderAll();
}

function updateDeliverable(delivId, field, value) {
  const p = currentProject(); if (!p) return;
  const d = (p.deliverables || []).find(d => d.id === delivId);
  if (d) { d[field] = value; markDirty(); renderAll(); }
}

// ── TaskGroup (Task) Operations ───────────────────────────────
// ── Streams ───────────────────────────────────────────────────
function addStream() {
  const p = currentProject(); if (!p) return;
  if (!p.streams) p.streams = [];
  const color = DEFAULT_TEAM_COLORS[p.streams.length % DEFAULT_TEAM_COLORS.length];
  p.streams.push({ id: uid(), name: 'New Stream', color });
  markDirty();
  renderStreamsModal();
  renderAll();
}

function deleteStream(streamId) {
  const p = currentProject(); if (!p) return;
  p.streams = (p.streams || []).filter(s => s.id !== streamId);
  (p.deliverables || []).forEach(d => { if (d.streamId === streamId) d.streamId = null; });
  markDirty();
  renderStreamsModal();
  renderAll();
}

function updateStream(streamId, field, value) {
  const p = currentProject(); if (!p) return;
  const s = (p.streams || []).find(s => s.id === streamId);
  if (s) { s[field] = value; markDirty(); renderAll(); }
}

function openStreamsModal() {
  document.getElementById('streams-overlay').classList.remove('hidden');
  renderStreamsModal();
}

function closeStreamsModal() {
  document.getElementById('streams-overlay').classList.add('hidden');
}

function renderStreamsModal() {
  const p = currentProject();
  const list = document.getElementById('streams-list');
  list.innerHTML = '';
  if (!p) return;

  const streams = p.streams || [];
  if (!streams.length) {
    const empty = document.createElement('p');
    empty.style.cssText = 'text-align:center;color:#aaa;font-size:13px;padding:20px';
    empty.textContent = 'No streams yet. Add one below.';
    list.appendChild(empty);
    return;
  }

  streams.forEach(stream => {
    const row = document.createElement('div');
    row.className = 'team-row';

    const colorBtn = document.createElement('button');
    colorBtn.className = 'team-color-btn';
    colorBtn.style.background = stream.color;
    colorBtn.title = 'Change color';
    colorBtn.addEventListener('click', () => {
      const inp = document.createElement('input');
      inp.type = 'color'; inp.value = stream.color; inp.style.display = 'none';
      document.body.appendChild(inp); inp.click();
      inp.addEventListener('input', () => { colorBtn.style.background = inp.value; updateStream(stream.id, 'color', inp.value); });
      inp.addEventListener('change', () => document.body.removeChild(inp));
    });

    const nameInp = document.createElement('input');
    nameInp.type = 'text'; nameInp.className = 'team-name-input'; nameInp.value = stream.name;
    nameInp.addEventListener('change', () => updateStream(stream.id, 'name', nameInp.value));
    nameInp.addEventListener('keydown', e => { if (e.key === 'Enter') nameInp.blur(); });

    const delBtn = document.createElement('button');
    delBtn.className = 'team-del-btn'; delBtn.textContent = '×';
    delBtn.title = 'Delete stream';
    delBtn.addEventListener('click', () => showConfirm(
      `Delete stream "${stream.name}"? Deliverables will become unassigned.`,
      () => deleteStream(stream.id)
    ));

    row.appendChild(colorBtn); row.appendChild(nameInp); row.appendChild(delBtn);
    list.appendChild(row);
  });
}

function addTaskGroup(deliverableId, name) {
  const p = currentProject(); if (!p) return;
  if (!p.taskGroups) p.taskGroups = [];
  const groupId = uid();
  p.taskGroups.push({ id: groupId, name, deliverableId });

  const buildDur = 10;
  const designDur = Math.max(1, Math.round(buildDur * 0.2));
  const defs = [
    { type: 'design',       name: 'Design',       dur: designDur },
    { type: 'build',        name: 'Build',        dur: buildDur  },
    { type: 'int-test',     name: 'Int. Testing', dur: 5         },
    { type: 'uat',          name: 'UAT',          dur: 3         },
    { type: 'data-cleanse', name: 'Data Cleanse', dur: 2         },
    { type: 'migration',    name: 'Migration',    dur: 2         },
    { type: 'release',      name: 'Release',      dur: 1         },
  ];
  const ids = defs.map(() => uid());
  defs.forEach((def, i) => {
    p.tasks.push({
      id: ids[i],
      name: def.name,
      deliverableId,
      groupId,
      activityType: def.type,
      duration: def.dur,
      dependencies: i === 0 ? [] : [{ id: ids[i - 1], type: 'FS' }],
      teams: [],
      assignee: '',
      notes: '',
      color: actTypeInfo(def.type)?.color || colorForIndex(p.tasks.length),
    });
  });
  markDirty();
  renderAll();
}

function deleteTaskGroup(groupId) {
  const p = currentProject(); if (!p) return;
  const group = (p.taskGroups || []).find(g => g.id === groupId);
  const taskIds = new Set(p.tasks.filter(t => t.groupId === groupId).map(t => t.id));
  p.taskGroups = (p.taskGroups || []).filter(g => g.id !== groupId);
  p.tasks = p.tasks.filter(t => t.groupId !== groupId);
  p.tasks.forEach(t => { t.dependencies = normalizeDeps(t.dependencies).filter(d => !taskIds.has(d.id)); });
  markDirty();
  renderAll();
}

// ── Deliverables Modal ────────────────────────────────────────
function openDeliverablesModal() {
  document.getElementById('deliverables-overlay').classList.remove('hidden');
  renderDeliverablesModal();
}

function closeDeliverablesModal() {
  document.getElementById('deliverables-overlay').classList.add('hidden');
}

function renderDeliverablesModal() {
  const p = currentProject();
  const list = document.getElementById('deliverables-list');
  list.innerHTML = '';
  if (!p) return;

  const deliverables = p.deliverables || [];
  if (!deliverables.length) {
    const empty = document.createElement('p');
    empty.style.cssText = 'text-align:center;color:#aaa;font-size:13px;padding:20px';
    empty.textContent = 'No deliverables yet. Add one below.';
    list.appendChild(empty);
    return;
  }

  deliverables.forEach(deliv => {
    const row = document.createElement('div');
    row.className = 'team-row';

    const colorBtn = document.createElement('button');
    colorBtn.className = 'team-color-btn';
    colorBtn.style.background = deliv.color;
    colorBtn.title = 'Change color';
    colorBtn.addEventListener('click', () => {
      const inp = document.createElement('input');
      inp.type = 'color'; inp.value = deliv.color; inp.style.display = 'none';
      document.body.appendChild(inp); inp.click();
      inp.addEventListener('input', () => { colorBtn.style.background = inp.value; updateDeliverable(deliv.id, 'color', inp.value); });
      inp.addEventListener('change', () => document.body.removeChild(inp));
    });

    const nameInp = document.createElement('input');
    nameInp.type = 'text'; nameInp.className = 'team-name-input'; nameInp.value = deliv.name;
    nameInp.addEventListener('change', () => updateDeliverable(deliv.id, 'name', nameInp.value));
    nameInp.addEventListener('keydown', e => { if (e.key === 'Enter') nameInp.blur(); });

    const streams = p.streams || [];
    if (streams.length) {
      const streamSel = document.createElement('select');
      streamSel.className = 'stream-select';
      const noneOpt = document.createElement('option');
      noneOpt.value = ''; noneOpt.textContent = 'No stream';
      streamSel.appendChild(noneOpt);
      streams.forEach(s => {
        const opt = document.createElement('option');
        opt.value = s.id; opt.textContent = s.name;
        if (deliv.streamId === s.id) opt.selected = true;
        streamSel.appendChild(opt);
      });
      streamSel.addEventListener('change', () => updateDeliverable(deliv.id, 'streamId', streamSel.value || null));
      row.appendChild(streamSel);
    }

    const delBtn = document.createElement('button');
    delBtn.className = 'team-del-btn'; delBtn.textContent = '×';
    delBtn.title = 'Delete deliverable';
    delBtn.addEventListener('click', () => showConfirm(
      `Delete deliverable "${deliv.name}" and ungroup its tasks?`,
      () => deleteDeliverable(deliv.id)
    ));

    row.appendChild(colorBtn); row.appendChild(nameInp); row.appendChild(delBtn);
    list.appendChild(row);
  });
}

// ── Teams Modal ──────────────────────────────────────────────
function openTeamsModal() {
  document.getElementById('teams-overlay').classList.remove('hidden');
  renderTeamsModal();
}

function closeTeamsModal() {
  document.getElementById('teams-overlay').classList.add('hidden');
}

function renderTeamsModal() {
  const p = currentProject();
  const list = document.getElementById('teams-list');
  list.innerHTML = '';

  if (!p) return;

  const teams = p.teams || [];

  if (teams.length === 0) {
    const empty = document.createElement('p');
    empty.style.cssText = 'text-align:center;color:#aaa;font-size:13px;padding:20px';
    empty.textContent = 'No teams yet. Add one below.';
    list.appendChild(empty);
    return;
  }

  teams.forEach(team => {
    const row = document.createElement('div');
    row.className = 'team-row';

    // Color button
    const colorBtn = document.createElement('button');
    colorBtn.className = 'team-color-btn';
    colorBtn.style.background = team.color;
    colorBtn.title = 'Change color';
    colorBtn.addEventListener('click', () => {
      const inp = document.createElement('input');
      inp.type = 'color';
      inp.value = team.color;
      inp.style.display = 'none';
      document.body.appendChild(inp);
      inp.click();
      inp.addEventListener('input', () => {
        colorBtn.style.background = inp.value;
        updateTeam(team.id, 'color', inp.value);
      });
      inp.addEventListener('change', () => document.body.removeChild(inp));
    });

    // Name input
    const nameInp = document.createElement('input');
    nameInp.type = 'text';
    nameInp.className = 'team-name-input';
    nameInp.value = team.name;
    nameInp.addEventListener('change', () => updateTeam(team.id, 'name', nameInp.value));
    nameInp.addEventListener('keydown', e => { if (e.key === 'Enter') nameInp.blur(); });

    // Delete button
    const delBtn = document.createElement('button');
    delBtn.className = 'team-del-btn';
    delBtn.textContent = '×';
    delBtn.title = 'Remove team';
    delBtn.addEventListener('click', () => deleteTeam(team.id));

    row.appendChild(colorBtn);
    row.appendChild(nameInp);
    row.appendChild(delBtn);
    list.appendChild(row);
  });
}

// ── Team Selector Popover ────────────────────────────────────
function openTeamPopover(taskId, anchorEl) {
  const p = currentProject();
  if (!p) return;

  closeTeamPopover();
  activePopoverTaskId = taskId;

  const task = p.tasks.find(t => t.id === taskId);
  const teams = p.teams || [];
  const taskTeams = new Set(task?.teams || []);

  const popover = document.getElementById('team-popover');
  const inner = document.getElementById('team-popover-inner');
  inner.innerHTML = '';

  const title = document.createElement('div');
  title.className = 'team-popover-title';
  title.textContent = teams.length ? 'Assign teams' : 'No teams defined';
  inner.appendChild(title);

  teams.forEach(team => {
    const opt = document.createElement('label');
    opt.className = 'team-option';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = taskTeams.has(team.id);
    cb.addEventListener('change', () => {
      const t = p.tasks.find(t => t.id === taskId);
      if (!t) return;
      if (cb.checked) {
        t.teams = [...(t.teams || []), team.id];
      } else {
        t.teams = (t.teams || []).filter(id => id !== team.id);
      }
      markDirty();
      renderAll();
      // Keep popover open — re-render it in place
      openTeamPopover(taskId, anchorEl);
    });

    const swatch = document.createElement('span');
    swatch.className = 'team-option-swatch';
    swatch.style.background = team.color;

    const name = document.createElement('span');
    name.className = 'team-option-name';
    name.textContent = team.name;

    opt.appendChild(cb);
    opt.appendChild(swatch);
    opt.appendChild(name);
    inner.appendChild(opt);
  });

  if (teams.length === 0) {
    const footer = document.createElement('div');
    footer.className = 'team-popover-footer';
    const link = document.createElement('a');
    link.textContent = 'Define teams first →';
    link.addEventListener('click', () => { closeTeamPopover(); openTeamsModal(); });
    footer.appendChild(link);
    inner.appendChild(footer);
  }

  // Position popover near anchor
  popover.classList.remove('hidden');
  const rect = anchorEl.getBoundingClientRect();
  const pw = popover.offsetWidth || 220;
  const ph = popover.offsetHeight || 160;
  let left = rect.left;
  let top = rect.bottom + 4;
  if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
  if (top + ph > window.innerHeight - 8) top = rect.top - ph - 4;
  popover.style.left = left + 'px';
  popover.style.top = top + 'px';
}

function closeTeamPopover() {
  document.getElementById('team-popover').classList.add('hidden');
  activePopoverTaskId = null;
}

// ── Task Operations ──────────────────────────────────────────
function addTask(task) {
  const p = currentProject();
  if (!p) return;
  const idx = p.tasks.length;
  p.tasks.push({
    id: uid(),
    name: task.name || 'New Task',
    duration: task.duration || 1,
    dependencies: task.dependencies || [],
    teams: task.teams || [],
    assignee: task.assignee || '',
    notes: task.notes || '',
    color: task.color || colorForIndex(idx),
  });
  markDirty();
  renderAll();
}

function deleteTask(taskId) {
  const p = currentProject();
  if (!p) return;
  p.tasks = p.tasks.filter(t => t.id !== taskId);
  p.tasks.forEach(t => { t.dependencies = normalizeDeps(t.dependencies).filter(d => d.id !== taskId); });
  markDirty();
  renderAll();
}

function updateTask(taskId, field, value) {
  const p = currentProject();
  if (!p) return;
  const t = p.tasks.find(t => t.id === taskId);
  if (!t) return;
  t[field] = value;
  markDirty();
  renderDates();
  if (state.view === 'gantt') renderGantt();
}

// ── Quick-Add Parser ─────────────────────────────────────────
// Format: "Task name, 5d, deps: 1 2 3, teams: Frontend QA, assign: Alice, notes: text"
function parseQuickAdd(raw) {
  const p = currentProject();
  if (!p) return null;
  const text = raw.trim();
  if (!text) return null;

  const task = { name: '', duration: 1, dependencies: [], teams: [], assignee: '', notes: '' };
  const parts = text.split(',').map(s => s.trim());
  task.name = parts[0];

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i].trim();

    const durMatch = part.match(/^(\d+)\s*d(?:ays?)?$/i);
    if (durMatch) { task.duration = parseInt(durMatch[1], 10); continue; }
    if (/^\d+$/.test(part)) { task.duration = parseInt(part, 10); continue; }

    const depMatch = part.match(/^dep(?:s|endenc(?:y|ies))?\s*[:=]\s*(.+)$/i);
    if (depMatch) {
      const nums = depMatch[1].split(/[\s,]+/).map(n => parseInt(n, 10)).filter(n => !isNaN(n) && n >= 1);
      task.dependencies = nums.map(n => p.tasks[n - 1]?.id).filter(Boolean).map(id => ({ id, type: 'FS' }));
      continue;
    }

    // Teams: "teams: Frontend QA" — matches by partial team name
    const teamsMatch = part.match(/^teams?\s*[:=]\s*(.+)$/i);
    if (teamsMatch) {
      const names = teamsMatch[1].split(/\s+/);
      task.teams = names
        .map(name => (p.teams || []).find(t => t.name.toLowerCase().includes(name.toLowerCase())))
        .filter(Boolean)
        .map(t => t.id);
      continue;
    }

    const assignMatch = part.match(/^(?:assign(?:ee)?|owner)\s*[:=]\s*(.+)$/i);
    if (assignMatch) { task.assignee = assignMatch[1].trim(); continue; }

    const notesMatch = part.match(/^notes?\s*[:=]\s*(.+)$/i);
    if (notesMatch) { task.notes = notesMatch[1].trim(); continue; }
  }

  task.color = colorForIndex(p.tasks.length);
  return task;
}

// ── Render: All ──────────────────────────────────────────────
function renderAll() {
  renderSidebar();
  renderToolbar();
  if (state.view === 'table') renderTable();
  else if (state.view === 'gantt') renderGantt();
  else if (state.view === 'canvas') renderCanvas();
}

// ── Render: Sidebar ──────────────────────────────────────────
function renderSidebar() {
  const ul = document.getElementById('project-list');
  ul.innerHTML = '';
  for (const p of state.projects) {
    const li = document.createElement('li');
    li.className = p.id === state.currentId ? 'active' : '';
    li.dataset.id = p.id;

    const nameSpan = document.createElement('span');
    nameSpan.textContent = p.name || 'Unnamed Project';
    nameSpan.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';

    const delBtn = document.createElement('button');
    delBtn.className = 'proj-delete-btn';
    delBtn.textContent = '×';
    delBtn.title = 'Delete project';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      showConfirm(`Delete project "${p.name}"? This cannot be undone.`, () => deleteProject(p.id));
    });

    li.appendChild(nameSpan);
    li.appendChild(delBtn);
    li.addEventListener('click', () => selectProject(p.id));
    ul.appendChild(li);
  }
}

// ── Render: Toolbar ──────────────────────────────────────────
function renderToolbar() {
  const p = currentProject();
  const nameEl = document.getElementById('project-name');
  const startEl = document.getElementById('project-start');
  const teamsBtn = document.getElementById('teams-btn');

  const streamsBtn = document.getElementById('streams-btn');
  if (!p) {
    nameEl.value = ''; startEl.value = '';
    nameEl.disabled = startEl.disabled = true;
    teamsBtn.disabled = streamsBtn.disabled = true;
    document.getElementById('deliverables-btn').disabled = true;
    return;
  }
  nameEl.disabled = startEl.disabled = teamsBtn.disabled = streamsBtn.disabled = false;
  nameEl.value = p.name;
  startEl.value = p.startDate || new Date().toISOString().slice(0, 10);

  const streamCount = (p.streams || []).length;
  streamsBtn.textContent = streamCount ? `Streams (${streamCount})` : 'Streams...';
  const teamCount = (p.teams || []).length;
  teamsBtn.textContent = teamCount ? `Teams (${teamCount})` : 'Teams...';
  const delivBtn = document.getElementById('deliverables-btn');
  const delivCount = (p.deliverables || []).length;
  delivBtn.textContent = delivCount ? `Deliverables (${delivCount})` : 'Deliverables...';
  delivBtn.disabled = false;
}

// ── Render: Table ─────────────────────────────────────────────
function renderTable() {
  const p = currentProject();
  const tbody = document.getElementById('task-tbody');
  tbody.innerHTML = '';

  if (!p) { showEmptyState(); return; }
  hideEmptyState();

  const schedule = computeSchedule(p);
  const errEl = document.getElementById('dep-error');
  if (schedule === null) {
    errEl.textContent = 'Circular dependency detected — please fix dependencies.';
    errEl.classList.remove('hidden');
  } else {
    errEl.classList.add('hidden');
  }

  const startDate = p.startDate ? new Date(p.startDate) : new Date();
  const deliverables = p.deliverables || [];
  const taskGroups = p.taskGroups || [];

  // Row numbers = position in p.tasks[] (stable, used for dep chips)
  _taskRowMap = {};
  p.tasks.forEach((t, i) => { _taskRowMap[t.id] = i + 1; });

  function appendActivityRow(task, indented) {
    const s = schedule && schedule[task.id];
    const taskStart = s ? addDays(startDate, s.startDay) : null;
    const taskEnd   = s ? addDays(startDate, s.endDay)   : null;
    const rowNum = _taskRowMap[task.id] || 0;

    const tr = document.createElement('tr');
    if (s && s.isCritical) tr.classList.add('critical-row');
    tr.dataset.id = task.id;

    const numTd = document.createElement('td');
    numTd.className = 'num-cell';
    numTd.textContent = rowNum;
    tr.appendChild(numTd);

    const nameTd = makeEditCell(task.id, 'name', task.name, 'text', task.color);
    if (indented) nameTd.classList.add('activity-indent');
    tr.appendChild(nameTd);

    // Activity type select
    const typeTd = document.createElement('td');
    typeTd.className = 'type-cell';
    const sel = document.createElement('select');
    sel.className = 'type-select';
    const emptyOpt = document.createElement('option');
    emptyOpt.value = ''; emptyOpt.textContent = '—';
    sel.appendChild(emptyOpt);
    ACTIVITY_TYPES.forEach(at => {
      const opt = document.createElement('option');
      opt.value = at.id; opt.textContent = at.label;
      if (task.activityType === at.id) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener('change', () => {
      const info = actTypeInfo(sel.value);
      updateTask(task.id, 'activityType', sel.value || null);
      if (info) updateTask(task.id, 'color', info.color);
    });
    typeTd.appendChild(sel);
    tr.appendChild(typeTd);

    tr.appendChild(makeNumCell(task.id, 'duration', task.duration));
    tr.appendChild(makeDepsCell(task, p));
    tr.appendChild(makeTeamsCell(task, p));
    tr.appendChild(makeEditCell(task.id, 'assignee', task.assignee || '', 'text'));
    tr.appendChild(makeEditCell(task.id, 'notes', task.notes || '', 'text'));

    const startTd = document.createElement('td');
    startTd.className = 'date-cell'; startTd.dataset.for = task.id; startTd.dataset.which = 'start';
    startTd.textContent = taskStart ? fmt(taskStart) : '—';
    tr.appendChild(startTd);

    const endTd = document.createElement('td');
    endTd.className = 'date-cell'; endTd.dataset.for = task.id; endTd.dataset.which = 'end';
    endTd.textContent = taskEnd ? fmt(taskEnd) : '—';
    tr.appendChild(endTd);

    const delTd = document.createElement('td');
    const delBtn = document.createElement('button');
    delBtn.className = 'del-btn'; delBtn.textContent = '×';
    delBtn.title = 'Delete activity';
    delBtn.addEventListener('click', () => deleteTask(task.id));
    delTd.appendChild(delBtn);
    tr.appendChild(delTd);

    tbody.appendChild(tr);
  }

  // ── Helper: render one deliverable block ──
  function renderDeliverableBlock(deliv, indented) {
    const dGroups = taskGroups.filter(g => g.deliverableId === deliv.id);

    // Deliverable header
    const hTr = document.createElement('tr');
    hTr.className = 'deliverable-header-row';
    hTr.dataset.delivId = deliv.id;
    const hTd = document.createElement('td'); hTd.colSpan = 11;
    const hInner = document.createElement('div'); hInner.className = 'deliv-row-inner';
    if (indented) hInner.style.paddingLeft = '28px';
    const dot = document.createElement('span'); dot.className = 'deliv-dot'; dot.style.background = deliv.color;
    const dName = document.createElement('span'); dName.className = 'deliv-name'; dName.textContent = deliv.name;
    const addBtn = document.createElement('button'); addBtn.className = 'add-task-btn'; addBtn.textContent = '+ Add Task';
    addBtn.addEventListener('click', () => showAddTaskGroupInput(deliv.id));
    hInner.appendChild(dot); hInner.appendChild(dName); hInner.appendChild(addBtn);
    hTd.appendChild(hInner); hTr.appendChild(hTd); tbody.appendChild(hTr);

    // Task groups
    dGroups.forEach(group => {
      const gTasks = p.tasks
        .filter(t => t.groupId === group.id)
        .sort((a, b) => actTypeOrder(a.activityType) - actTypeOrder(b.activityType));

      const gTr = document.createElement('tr');
      gTr.className = 'task-group-header-row'; gTr.dataset.groupId = group.id;
      const gTd = document.createElement('td'); gTd.colSpan = 11;
      const gInner = document.createElement('div'); gInner.className = 'group-row-inner';
      const gName = document.createElement('span'); gName.className = 'group-row-name'; gName.textContent = group.name;
      const gDel = document.createElement('button'); gDel.className = 'group-del-btn'; gDel.textContent = '×';
      gDel.title = `Delete task "${group.name}"`;
      gDel.addEventListener('click', () => showConfirm(`Delete task "${group.name}" and all its activities?`, () => deleteTaskGroup(group.id)));
      gInner.appendChild(gName); gInner.appendChild(gDel);
      gTd.appendChild(gInner); gTr.appendChild(gTd); tbody.appendChild(gTr);

      gTasks.forEach(t => appendActivityRow(t, true));
    });

    // Ungrouped tasks within this deliverable
    p.tasks.filter(t => t.deliverableId === deliv.id && !t.groupId).forEach(t => appendActivityRow(t, false));

    // Spacer row for "+ Add Task" input insertion
    const sTr = document.createElement('tr');
    sTr.className = 'add-group-row'; sTr.dataset.delivId = deliv.id;
    const sTd = document.createElement('td'); sTd.colSpan = 11;
    sTr.appendChild(sTd); tbody.appendChild(sTr);
  }

  // ── Stream sections ──
  const streams = p.streams || [];
  const streamIds = new Set(streams.map(s => s.id));

  streams.forEach(stream => {
    const streamDelivs = deliverables.filter(d => d.streamId === stream.id);
    if (!streamDelivs.length) return;

    const sTr = document.createElement('tr');
    sTr.className = 'stream-header-row';
    const sTd = document.createElement('td'); sTd.colSpan = 11;
    const sInner = document.createElement('div'); sInner.className = 'stream-row-inner';
    sInner.style.borderLeft = `4px solid ${stream.color}`;
    const sDot = document.createElement('span'); sDot.className = 'deliv-dot'; sDot.style.background = stream.color;
    const sName = document.createElement('span'); sName.className = 'stream-row-name'; sName.textContent = stream.name;
    sInner.appendChild(sDot); sInner.appendChild(sName);
    sTd.appendChild(sInner); sTr.appendChild(sTd); tbody.appendChild(sTr);

    streamDelivs.forEach(deliv => renderDeliverableBlock(deliv, true));
  });

  // ── Deliverables not assigned to any stream ──
  deliverables.filter(d => !d.streamId || !streamIds.has(d.streamId)).forEach(deliv => {
    renderDeliverableBlock(deliv, false);
  });

  // ── Ungrouped tasks (no deliverable) ──
  const ungrouped = p.tasks.filter(t => !t.deliverableId);
  if (ungrouped.length) {
    if (deliverables.length || streams.length) {
      const uTr = document.createElement('tr'); uTr.className = 'deliverable-header-row ungrouped-header';
      const uTd = document.createElement('td'); uTd.colSpan = 11;
      const uInner = document.createElement('div'); uInner.className = 'deliv-row-inner';
      uInner.textContent = 'Ungrouped Tasks';
      uTd.appendChild(uInner); uTr.appendChild(uTd); tbody.appendChild(uTr);
    }
    ungrouped.forEach(t => appendActivityRow(t, false));
  }
}

function showAddTaskGroupInput(delivId) {
  const tbody = document.getElementById('task-tbody');
  const old = tbody.querySelector('.new-group-input-row');
  if (old) old.remove();

  const anchor = tbody.querySelector(`.add-group-row[data-deliv-id="${delivId}"]`);

  const tr = document.createElement('tr'); tr.className = 'new-group-input-row';
  const td = document.createElement('td'); td.colSpan = 11;
  const inner = document.createElement('div'); inner.className = 'new-group-inner';

  const inp = document.createElement('input');
  inp.type = 'text'; inp.className = 'new-group-input';
  inp.placeholder = 'Task name (e.g. Core Service, CRM Integration)…';

  const addBtn = document.createElement('button'); addBtn.className = 'btn-sm'; addBtn.textContent = 'Add';
  const cancelBtn = document.createElement('button'); cancelBtn.className = 'btn-sm btn-ghost'; cancelBtn.textContent = 'Cancel';

  const doAdd = () => { const name = inp.value.trim(); if (name) addTaskGroup(delivId, name); tr.remove(); };
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') doAdd(); if (e.key === 'Escape') tr.remove(); });
  addBtn.addEventListener('click', doAdd);
  cancelBtn.addEventListener('click', () => tr.remove());

  inner.appendChild(inp); inner.appendChild(addBtn); inner.appendChild(cancelBtn);
  td.appendChild(inner); tr.appendChild(td);

  if (anchor) tbody.insertBefore(tr, anchor);
  else tbody.appendChild(tr);
  inp.focus();
}

function makeEditCell(taskId, field, value, type, swatchColor) {
  const td = document.createElement('td');
  if (swatchColor !== undefined) {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;align-items:center;gap:6px;padding-left:6px';

    const swatch = document.createElement('span');
    swatch.className = 'color-swatch';
    swatch.style.background = swatchColor;
    swatch.title = 'Click to change color';
    swatch.addEventListener('click', (e) => { e.stopPropagation(); openColorPicker(taskId, swatch); });

    const inp = document.createElement('input');
    inp.type = type || 'text';
    inp.className = 'cell-edit';
    inp.value = value;
    inp.style.paddingLeft = '0';
    attachCellEditListeners(inp, taskId, field);

    wrap.appendChild(swatch);
    wrap.appendChild(inp);
    td.appendChild(wrap);
  } else {
    const inp = document.createElement('input');
    inp.type = type || 'text';
    inp.className = 'cell-edit';
    inp.value = value;
    attachCellEditListeners(inp, taskId, field);
    td.appendChild(inp);
  }
  return td;
}

function makeNumCell(taskId, field, value) {
  const td = document.createElement('td');
  const inp = document.createElement('input');
  inp.type = 'number'; inp.min = 1;
  inp.className = 'cell-edit'; inp.value = value;
  attachCellEditListeners(inp, taskId, field, true);
  td.appendChild(inp);
  return td;
}

function makeDepsCell(task, project) {
  const td = document.createElement('td');
  td.className = 'deps-cell';

  const wrap = document.createElement('div');
  wrap.className = 'dep-chips-wrap';

  const normDeps = normalizeDeps(task.dependencies);

  normDeps.forEach(dep => {
    const depTask = project.tasks.find(t => t.id === dep.id);
    if (!depTask) return;
    const idx = project.tasks.indexOf(depTask);

    const chip = document.createElement('span');
    chip.className = 'dep-chip';
    chip.title = depTask.name;

    const num = document.createElement('span');
    num.textContent = idx + 1;

    const typeBadge = document.createElement('span');
    typeBadge.className = 'dep-type-badge';
    typeBadge.textContent = dep.type || 'FS';
    typeBadge.title = 'Click to change type (FS→FF→SS)';
    typeBadge.addEventListener('click', (e) => {
      e.stopPropagation();
      const deps = normalizeDeps(task.dependencies);
      const d = deps.find(d => d.id === dep.id);
      if (d) {
        d.type = DEP_TYPES[(DEP_TYPES.indexOf(d.type) + 1) % DEP_TYPES.length];
        task.dependencies = deps;
        markDirty();
        renderAll();
      }
    });

    const rm = document.createElement('button');
    rm.className = 'dep-chip-remove';
    rm.textContent = '×';
    rm.addEventListener('click', (e) => {
      e.stopPropagation();
      task.dependencies = normalizeDeps(task.dependencies).filter(d => d.id !== dep.id);
      markDirty();
      renderAll();
    });

    chip.appendChild(num);
    chip.appendChild(typeBadge);
    chip.appendChild(rm);
    wrap.appendChild(chip);
  });

  // Add-dependency button (only shown when there are other tasks)
  const others = project.tasks.filter(t => t.id !== task.id);
  if (others.length) {
    const addBtn = document.createElement('button');
    addBtn.className = 'dep-add-btn';
    addBtn.textContent = normDeps.length ? '+' : '+ dep';
    addBtn.title = 'Add dependency';
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openDepPopover(task.id, td);
    });
    wrap.appendChild(addBtn);
  }

  td.appendChild(wrap);
  return td;
}

function makeTeamsCell(task, project) {
  const td = document.createElement('td');
  td.className = 'teams-cell';

  const wrap = document.createElement('div');
  wrap.className = 'team-pills-wrap';

  const teams = project.teams || [];
  const taskTeamIds = task.teams || [];
  const assignedTeams = taskTeamIds.map(id => teams.find(t => t.id === id)).filter(Boolean);

  if (assignedTeams.length === 0) {
    const placeholder = document.createElement('span');
    placeholder.className = 'team-placeholder';
    placeholder.textContent = teams.length ? '+ assign' : '+ team';
    wrap.appendChild(placeholder);
  } else {
    assignedTeams.forEach(team => {
      const pill = document.createElement('span');
      pill.className = 'team-pill';
      pill.style.background = team.color;
      pill.textContent = team.name;
      wrap.appendChild(pill);
    });
  }

  td.appendChild(wrap);
  td.addEventListener('click', (e) => { e.stopPropagation(); openTeamPopover(task.id, td); });
  return td;
}

function attachCellEditListeners(inp, taskId, field, isNum) {
  inp.addEventListener('change', () => {
    const val = isNum ? Math.max(1, parseInt(inp.value, 10) || 1) : inp.value;
    updateTask(taskId, field, val);
    if (isNum) inp.value = val;
  });
  inp.addEventListener('keydown', handleCellKeydown);
}

function handleCellKeydown(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    const rowInputs = [...e.target.closest('tr').querySelectorAll('input.cell-edit')];
    const colIdx = rowInputs.indexOf(e.target);
    const rows = [...document.querySelectorAll('#task-tbody tr')];
    const rowIdx = rows.indexOf(e.target.closest('tr'));
    if (rowIdx < rows.length - 1) {
      const nextInputs = [...rows[rowIdx + 1].querySelectorAll('input.cell-edit')];
      if (nextInputs[colIdx]) nextInputs[colIdx].focus();
    } else {
      addTask({});
    }
  }
}

function renderDates() {
  const p = currentProject();
  if (!p) return;
  const schedule = computeSchedule(p);
  if (!schedule) return;
  const startDate = p.startDate ? new Date(p.startDate) : new Date();

  document.querySelectorAll('[data-for][data-which]').forEach(el => {
    const s = schedule[el.dataset.for];
    if (!s) return;
    const d = el.dataset.which === 'start' ? addDays(startDate, s.startDay) : addDays(startDate, s.endDay);
    el.textContent = fmt(d);
  });

  document.querySelectorAll('#task-tbody tr[data-id]').forEach(tr => {
    const s = schedule[tr.dataset.id];
    tr.classList.toggle('critical-row', !!(s && s.isCritical));
  });
}

function openColorPicker(taskId, swatchEl) {
  const p = currentProject();
  const t = p && p.tasks.find(t => t.id === taskId);
  const inp = document.createElement('input');
  inp.type = 'color';
  if (t) inp.value = t.color;
  inp.style.display = 'none';
  document.body.appendChild(inp);
  inp.click();
  inp.addEventListener('input', () => {
    swatchEl.style.background = inp.value;
    updateTask(taskId, 'color', inp.value);
  });
  inp.addEventListener('change', () => { document.body.removeChild(inp); renderTable(); });
}

// ── Gantt Chart (SVG) ────────────────────────────────────────
function getBarFill(task, defs) {
  const p = currentProject();
  const teams = p?.teams || [];
  const taskTeams = (task.teams || []).map(id => teams.find(t => t.id === id)).filter(Boolean);

  if (taskTeams.length === 0) return { fill: task.color, opacity: 0.9 };
  if (taskTeams.length === 1) return { fill: taskTeams[0].color, opacity: 1 };

  // Multi-team: diagonal stripe pattern
  const colors = taskTeams.map(t => t.color);
  const patternId = 'stripe-' + colors.map(c => c.replace('#', '')).join('-');

  if (!defs.querySelector(`#${patternId}`)) {
    const segW = 8;
    const totalW = segW * colors.length;
    const pat = makeSVGEl('pattern', {
      id: patternId, patternUnits: 'userSpaceOnUse',
      width: totalW, height: totalW, patternTransform: 'rotate(45)',
    });
    colors.forEach((color, i) => {
      pat.appendChild(makeSVGEl('rect', { x: i * segW, y: 0, width: segW, height: totalW * 2, fill: color }));
    });
    defs.appendChild(pat);
  }

  return { fill: `url(#${patternId})`, opacity: 1 };
}

function isTaskDimmed(task) {
  if (!state.teamFilter) return false;
  return !(task.teams || []).includes(state.teamFilter);
}

function renderGantt() {
  const p = currentProject();
  const labelsBody = document.getElementById('gantt-labels-body');
  const svg = document.getElementById('gantt-svg');

  // Clean up any active drag listeners from the previous render
  if (svg._cleanupDrag) { svg._cleanupDrag(); svg._cleanupDrag = null; }

  labelsBody.innerHTML = '';
  svg.innerHTML = '';

  // Rebuild legend footer
  let footer = document.getElementById('gantt-labels-footer');
  if (footer) footer.remove();

  if (!p || !p.tasks.length) {
    svg.style.width = '400px'; svg.style.height = '200px';
    const msg = makeSVGEl('text', { x: 200, y: 100, 'text-anchor': 'middle', fill: '#aaa', 'font-size': 14 });
    msg.textContent = 'Add tasks to see the Gantt chart';
    svg.appendChild(msg);
    return;
  }

  const schedule = computeSchedule(p);
  if (!schedule) {
    svg.style.width = '400px'; svg.style.height = '80px';
    const msg = makeSVGEl('text', { x: 200, y: 40, 'text-anchor': 'middle', fill: '#d94f4f', 'font-size': 14 });
    msg.textContent = 'Circular dependency — fix before viewing Gantt.';
    svg.appendChild(msg);
    return;
  }

  const deliverables = p.deliverables || [];

  // Build ordered row list: deliverable header rows interleaved with task rows
  // taskIndexMap preserves original 1-based row numbers from p.tasks
  const taskIndexMap = {};
  p.tasks.forEach((t, i) => { taskIndexMap[t.id] = i + 1; });

  const streams = p.streams || [];
  const streamIds = new Set(streams.map(s => s.id));
  const rows = [];

  // Streams → their deliverables → tasks
  streams.forEach(stream => {
    const streamDelivs = deliverables.filter(d => d.streamId === stream.id);
    const allStreamTasks = p.tasks.filter(t => streamDelivs.some(d => d.id === t.deliverableId));
    if (!streamDelivs.length && !allStreamTasks.length) return;
    const streamCollapsed = collapsedStreams.has(stream.id);
    rows.push({ type: 'stream-header', stream, allStreamTasks, collapsed: streamCollapsed });
    if (!streamCollapsed) {
      streamDelivs.forEach(deliv => {
        const delivTasks = p.tasks.filter(t => t.deliverableId === deliv.id);
        if (!delivTasks.length) return;
        const delivCollapsed = collapsedDeliverables.has(deliv.id);
        rows.push({ type: 'deliv-header', deliv, delivTasks, collapsed: delivCollapsed, withinStream: true });
        if (!delivCollapsed) {
          (p.taskGroups || []).filter(g => g.deliverableId === deliv.id).forEach(group => {
            const gTasks = delivTasks.filter(t => t.groupId === group.id)
              .sort((a, b) => actTypeOrder(a.activityType) - actTypeOrder(b.activityType));
            if (!gTasks.length) return;
            const groupCollapsed = collapsedGroups.has(group.id);
            rows.push({ type: 'group-header', group, gTasks, collapsed: groupCollapsed });
            if (!groupCollapsed) gTasks.forEach(t => rows.push({ type: 'task', task: t }));
          });
          delivTasks.filter(t => !t.groupId).forEach(t => rows.push({ type: 'task', task: t }));
        }
      });
    }
  });

  // Deliverables not assigned to any stream
  deliverables.filter(d => !d.streamId || !streamIds.has(d.streamId)).forEach(deliv => {
    const delivTasks = p.tasks.filter(t => t.deliverableId === deliv.id);
    if (!delivTasks.length) return;
    const collapsed = collapsedDeliverables.has(deliv.id);
    rows.push({ type: 'deliv-header', deliv, delivTasks, collapsed });
    if (!collapsed) {
      (p.taskGroups || []).filter(g => g.deliverableId === deliv.id).forEach(group => {
        const gTasks = delivTasks.filter(t => t.groupId === group.id)
          .sort((a, b) => actTypeOrder(a.activityType) - actTypeOrder(b.activityType));
        if (!gTasks.length) return;
        const groupCollapsed = collapsedGroups.has(group.id);
        rows.push({ type: 'group-header', group, gTasks, collapsed: groupCollapsed });
        if (!groupCollapsed) gTasks.forEach(t => rows.push({ type: 'task', task: t }));
      });
      delivTasks.filter(t => !t.groupId).forEach(t => rows.push({ type: 'task', task: t }));
    }
  });

  p.tasks.filter(t => !t.deliverableId).forEach(task => rows.push({ type: 'task', task }));

  const startDate = p.startDate ? new Date(p.startDate) : new Date();
  startDate.setHours(0,0,0,0);
  const today = new Date(); today.setHours(0,0,0,0);

  let maxDay = 0;
  for (const id in schedule) {
    if (schedule[id].endDay > maxDay) maxDay = schedule[id].endDay;
  }
  maxDay += 7;

  const dayW = { day: 36, week: 18, month: 6 }[state.zoom] || 18;
  const totalW = maxDay * dayW;
  const totalH = GANTT_HEADER_H + rows.length * ROW_H;

  svg.style.width = totalW + 'px';
  svg.style.height = totalH + 'px';
  svg.setAttribute('width', totalW);
  svg.setAttribute('height', totalH);
  svg.setAttribute('viewBox', `0 0 ${totalW} ${totalH}`);

  // Defs
  const defs = makeSVGEl('defs');
  const marker = makeSVGEl('marker', { id: 'arrow', viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse' });
  marker.appendChild(makeSVGEl('path', { d: 'M 0 0 L 8 4 L 0 8 z', fill: '#888' }));
  defs.appendChild(marker);
  svg.appendChild(defs);

  // Swim-lane bands: one rect per row
  const swimG = makeSVGEl('g');
  rows.forEach((row, i) => {
    const rowY = GANTT_HEADER_H + i * ROW_H;
    if (row.type === 'stream-header') {
      swimG.appendChild(makeSVGEl('rect', { x: 0, y: rowY, width: totalW, height: ROW_H, fill: row.stream.color + '20' }));
      swimG.appendChild(makeSVGEl('rect', { x: 0, y: rowY, width: 4, height: ROW_H, fill: row.stream.color }));
    } else if (row.type === 'deliv-header') {
      const indent = row.withinStream ? 14 : 0;
      swimG.appendChild(makeSVGEl('rect', { x: 0, y: rowY, width: totalW, height: ROW_H, fill: row.deliv.color + '1a' }));
      swimG.appendChild(makeSVGEl('rect', { x: indent, y: rowY, width: 3, height: ROW_H, fill: row.deliv.color }));
    } else if (row.type === 'group-header') {
      swimG.appendChild(makeSVGEl('rect', { x: 0, y: rowY, width: totalW, height: ROW_H, fill: '#f1f3f5' }));
    } else if (row.task && row.task.deliverableId) {
      const deliv = deliverables.find(d => d.id === row.task.deliverableId);
      if (deliv) {
        const indent = (deliv.streamId && streamIds.has(deliv.streamId)) ? 14 : 0;
        swimG.appendChild(makeSVGEl('rect', { x: 0, y: rowY, width: totalW, height: ROW_H, fill: deliv.color + '0a' }));
        swimG.appendChild(makeSVGEl('rect', { x: indent, y: rowY, width: 3, height: ROW_H, fill: deliv.color }));
      }
    }
  });
  svg.appendChild(swimG);

  // Alternating week column backgrounds
  const bg = makeSVGEl('g');
  for (let day = 0, col = 0; day < maxDay; day += 7, col++) {
    if (col % 2 === 1) {
      bg.appendChild(makeSVGEl('rect', { x: day * dayW, y: GANTT_HEADER_H, width: Math.min(7 * dayW, totalW - day * dayW), height: totalH - GANTT_HEADER_H, fill: '#f5f6f8' }));
    }
  }
  svg.appendChild(bg);

  drawHeader(svg, startDate, maxDay, dayW, totalW);

  // Grid lines
  const grid = makeSVGEl('g');
  for (let day = 0; day <= maxDay; day += 7) {
    grid.appendChild(makeSVGEl('line', { x1: day * dayW, y1: GANTT_HEADER_H, x2: day * dayW, y2: totalH, stroke: '#e2e5ec', 'stroke-width': 1 }));
  }
  for (let i = 0; i <= rows.length; i++) {
    grid.appendChild(makeSVGEl('line', { x1: 0, y1: GANTT_HEADER_H + i * ROW_H, x2: totalW, y2: GANTT_HEADER_H + i * ROW_H, stroke: '#e2e5ec', 'stroke-width': 1 }));
  }
  svg.appendChild(grid);

  // Today line
  const todayDay = daysBetween(startDate, today);
  if (todayDay >= 0 && todayDay <= maxDay) {
    const x = todayDay * dayW;
    svg.appendChild(makeSVGEl('line', { x1: x, y1: GANTT_HEADER_H, x2: x, y2: totalH, stroke: '#ef4444', 'stroke-width': 1.5, 'stroke-dasharray': '4 3' }));
    const todayLabel = makeSVGEl('text', { x: x + 3, y: GANTT_HEADER_H - 4, fill: '#ef4444', 'font-size': 10, 'font-weight': 600 });
    todayLabel.textContent = 'Today';
    svg.appendChild(todayLabel);
  }

  // Bars + label rows
  const barsG = makeSVGEl('g');
  const barPositions = {};

  rows.forEach((row, rowIdx) => {
    const rowY = GANTT_HEADER_H + rowIdx * ROW_H;

    if (row.type === 'stream-header') {
      const { stream, allStreamTasks, collapsed } = row;

      // Summary bar spanning full stream range
      const scheduled = allStreamTasks.filter(t => schedule[t.id]);
      if (scheduled.length) {
        const minStart = Math.min(...scheduled.map(t => schedule[t.id].startDay));
        const maxEnd   = Math.max(...scheduled.map(t => schedule[t.id].endDay));
        const x = minStart * dayW;
        const w = Math.max((maxEnd - minStart + 1) * dayW, 4);
        const y = rowY + BAR_TOP;
        const bar = makeSVGEl('rect', { x, y, width: w, height: BAR_H,
          fill: stream.color, rx: 4, ry: 4, opacity: collapsed ? 0.65 : 0.18 });
        barsG.appendChild(bar);
        if (collapsed && w > 50) {
          const lbl = makeSVGEl('text', { x: x + 7, y: y + BAR_H / 2 + 4,
            fill: '#fff', 'font-size': 11, 'font-weight': 700 });
          lbl.textContent = truncate(stream.name + ' (' + scheduled.length + ')', Math.floor(w / 7));
          barsG.appendChild(lbl);
        }
      }

      // Label panel stream header row
      const streamRow = document.createElement('div');
      streamRow.className = 'gantt-stream-header-row';
      streamRow.style.borderLeft = `4px solid ${stream.color}`;
      streamRow.style.background = stream.color + '1a';

      const sToggle = document.createElement('span');
      sToggle.className = 'gantt-deliv-toggle';
      sToggle.textContent = collapsed ? '▶' : '▼';

      const sName = document.createElement('span');
      sName.className = 'gantt-stream-header-name';
      sName.textContent = stream.name;

      const sCount = document.createElement('span');
      sCount.className = 'gantt-deliv-header-count';
      sCount.textContent = allStreamTasks.length + (allStreamTasks.length === 1 ? ' task' : ' tasks');

      streamRow.appendChild(sToggle);
      streamRow.appendChild(sName);
      streamRow.appendChild(sCount);

      streamRow.addEventListener('click', () => {
        if (collapsedStreams.has(stream.id)) collapsedStreams.delete(stream.id);
        else collapsedStreams.add(stream.id);
        renderGantt();
      });

      labelsBody.appendChild(streamRow);

    } else if (row.type === 'deliv-header') {
      const { deliv, delivTasks, collapsed } = row;

      // Summary bar spanning the full deliverable date range (shown when collapsed;
      // shown faintly when expanded so you can see the overall envelope)
      const scheduled = delivTasks.filter(t => schedule[t.id]);
      if (scheduled.length) {
        const minStart = Math.min(...scheduled.map(t => schedule[t.id].startDay));
        const maxEnd   = Math.max(...scheduled.map(t => schedule[t.id].endDay));
        const x = minStart * dayW;
        const w = Math.max((maxEnd - minStart + 1) * dayW, 4);
        const y = rowY + BAR_TOP;
        const bar = makeSVGEl('rect', { x, y, width: w, height: BAR_H,
          fill: deliv.color, rx: 4, ry: 4, opacity: collapsed ? 0.6 : 0.25 });
        barsG.appendChild(bar);
        if (collapsed && w > 50) {
          const lbl = makeSVGEl('text', { x: x + 7, y: y + BAR_H / 2 + 4,
            fill: '#fff', 'font-size': 11, 'font-weight': 600 });
          lbl.textContent = truncate(deliv.name + ' (' + scheduled.length + ')', Math.floor(w / 7));
          barsG.appendChild(lbl);
        }
      }

      // Label panel header row
      const headerRow = document.createElement('div');
      headerRow.className = 'gantt-deliv-header-row' + (row.withinStream ? ' within-stream' : '');
      headerRow.style.borderLeft = `3px solid ${deliv.color}`;
      headerRow.style.background = deliv.color + '18';

      const toggle = document.createElement('span');
      toggle.className = 'gantt-deliv-toggle';
      toggle.textContent = collapsed ? '▶' : '▼';

      const nameEl = document.createElement('span');
      nameEl.className = 'gantt-deliv-header-name';
      nameEl.textContent = deliv.name;

      const countEl = document.createElement('span');
      countEl.className = 'gantt-deliv-header-count';
      countEl.textContent = delivTasks.length + (delivTasks.length === 1 ? ' task' : ' tasks');

      headerRow.appendChild(toggle);
      headerRow.appendChild(nameEl);
      headerRow.appendChild(countEl);

      headerRow.addEventListener('click', () => {
        if (collapsedDeliverables.has(deliv.id)) collapsedDeliverables.delete(deliv.id);
        else collapsedDeliverables.add(deliv.id);
        renderGantt();
      });

      labelsBody.appendChild(headerRow);

    } else if (row.type === 'group-header') {
      const { group, gTasks, collapsed } = row;

      // Summary bar for collapsed group
      const scheduled = gTasks.filter(t => schedule[t.id]);
      if (scheduled.length) {
        const minStart = Math.min(...scheduled.map(t => schedule[t.id].startDay));
        const maxEnd   = Math.max(...scheduled.map(t => schedule[t.id].endDay));
        const x = minStart * dayW;
        const w = Math.max((maxEnd - minStart + 1) * dayW, 4);
        const y = rowY + BAR_TOP;
        const bar = makeSVGEl('rect', { x, y, width: w, height: BAR_H,
          fill: '#6b7280', rx: 4, ry: 4, opacity: collapsed ? 0.55 : 0.15 });
        barsG.appendChild(bar);
        if (collapsed && w > 40) {
          const lbl = makeSVGEl('text', { x: x + 7, y: y + BAR_H / 2 + 4,
            fill: '#fff', 'font-size': 11, 'font-weight': 600 });
          lbl.textContent = truncate(group.name + ' (' + scheduled.length + ')', Math.floor(w / 7));
          barsG.appendChild(lbl);
        }
      }

      const groupRow = document.createElement('div');
      groupRow.className = 'gantt-group-header-row';

      const gToggle = document.createElement('span');
      gToggle.className = 'gantt-deliv-toggle';
      gToggle.textContent = collapsed ? '▶' : '▼';

      const gName = document.createElement('span');
      gName.className = 'gantt-group-header-name';
      gName.textContent = group.name;

      const gCount = document.createElement('span');
      gCount.className = 'gantt-deliv-header-count';
      gCount.textContent = gTasks.length + (gTasks.length === 1 ? ' activity' : ' activities');

      groupRow.appendChild(gToggle);
      groupRow.appendChild(gName);
      groupRow.appendChild(gCount);

      groupRow.addEventListener('click', () => {
        if (collapsedGroups.has(group.id)) collapsedGroups.delete(group.id);
        else collapsedGroups.add(group.id);
        renderGantt();
      });

      labelsBody.appendChild(groupRow);

    } else {
      // Task row
      const { task } = row;
      const s = schedule[task.id];
      if (!s) return;

      const x = s.startDay * dayW;
      const w = Math.max((s.endDay - s.startDay + 1) * dayW, 4);
      const y = rowY + BAR_TOP;
      barPositions[task.id] = { x, y: y + BAR_H / 2, w };

      const dimmed = isTaskDimmed(task);
      const { fill, opacity } = getBarFill(task, defs);

      const bar = makeSVGEl('rect', {
        x, y, width: w, height: BAR_H,
        fill,
        rx: 4, ry: 4,
        opacity: dimmed ? 0.15 : (s.isCritical ? opacity : opacity * 0.85),
      });
      if (s.isCritical && !dimmed) bar.setAttribute('stroke', '#c05020');
      barsG.appendChild(bar);

      if (w > 30 && !dimmed) {
        const label = makeSVGEl('text', { x: x + 6, y: y + BAR_H / 2 + 4, fill: '#fff', 'font-size': 11, 'font-weight': 500 });
        label.textContent = truncate(task.name, Math.floor(w / 7));
        barsG.appendChild(label);
      }

      // Left label panel row
      const labelRow = document.createElement('div');
      labelRow.className = 'gantt-label-row' + (s.isCritical ? ' critical-label' : '');
      if (dimmed) labelRow.style.opacity = '0.35';
      if (task.deliverableId && task.groupId) labelRow.style.paddingLeft = '20px';

      const numSpan = document.createElement('span');
      numSpan.className = 'gantt-label-num';
      numSpan.textContent = taskIndexMap[task.id];

      const nameSpan = document.createElement('span');
      nameSpan.className = 'gantt-label-name';
      nameSpan.textContent = task.name;
      nameSpan.title = task.name;

      const durSpan = document.createElement('span');
      durSpan.className = 'gantt-label-dur';
      durSpan.textContent = task.duration + 'd';

      labelRow.appendChild(numSpan);
      labelRow.appendChild(nameSpan);
      labelRow.appendChild(durSpan);
      labelsBody.appendChild(labelRow);
    }
  });

  svg.appendChild(barsG);

  // Dependency arrows (only between tasks with visible bar positions)
  const arrowsG = makeSVGEl('g');
  p.tasks.forEach(task => {
    const succ = barPositions[task.id];
    if (!succ) return;
    normalizeDeps(task.dependencies).forEach(dep => {
      const pred = barPositions[dep.id];
      if (!pred) return;
      if (dep.type === 'FF') {
        drawArrow(arrowsG, pred.x + pred.w, pred.y, succ.x + succ.w, succ.y, dayW);
      } else if (dep.type === 'SS') {
        drawArrow(arrowsG, pred.x, pred.y, succ.x, succ.y, dayW);
      } else {
        drawArrow(arrowsG, pred.x + pred.w, pred.y, succ.x, succ.y, dayW);
      }
    });
  });
  svg.appendChild(arrowsG);

  // Team legend footer in labels panel
  const teams = p.teams || [];
  if (teams.length) {
    const labelPanel = document.getElementById('gantt-labels-panel');
    const newFooter = document.createElement('div');
    newFooter.id = 'gantt-labels-footer';

    const legendTitle = document.createElement('div');
    legendTitle.className = 'team-legend-title';
    legendTitle.textContent = 'Teams  (click to filter)';
    newFooter.appendChild(legendTitle);

    const legendItems = document.createElement('div');
    legendItems.className = 'team-legend-items';

    teams.forEach(team => {
      const item = document.createElement('div');
      item.className = 'team-legend-item' + (state.teamFilter && state.teamFilter !== team.id ? ' dimmed' : '');

      const dot = document.createElement('span');
      dot.className = 'team-legend-dot';
      dot.style.background = team.color;

      const name = document.createElement('span');
      name.className = 'team-legend-name';
      name.textContent = team.name;

      item.appendChild(dot);
      item.appendChild(name);
      item.addEventListener('click', () => {
        state.teamFilter = (state.teamFilter === team.id) ? null : team.id;
        renderGantt();
      });

      legendItems.appendChild(item);
    });

    newFooter.appendChild(legendItems);
    labelPanel.appendChild(newFooter);
  }

  // Drag-to-connect (must come last so it renders on top)
  setupGanttDragConnect(svg, barPositions, p);

  // Drag hint in labels header
  const labelsHeader = document.getElementById('gantt-labels-header');
  if (!labelsHeader.querySelector('#gantt-drag-hint')) {
    const hint = document.createElement('small');
    hint.id = 'gantt-drag-hint';
    hint.textContent = 'drag → end of bar to link';
    labelsHeader.appendChild(hint);
  }

  // Sync scroll
  const chartPanel = document.getElementById('gantt-chart-panel');
  const labelsBodyEl = document.getElementById('gantt-labels-body');
  chartPanel.onscroll = () => { labelsBodyEl.scrollTop = chartPanel.scrollTop; };
}

function drawHeader(svg, startDate, maxDay, dayW, totalW) {
  const headerG = makeSVGEl('g');
  const months = {};
  for (let day = 0; day <= maxDay; day++) {
    const d = addDays(startDate, day);
    const key = `${d.getFullYear()}-${d.getMonth()}`;
    if (!months[key]) months[key] = { x: day * dayW, label: d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }) };
  }

  headerG.appendChild(makeSVGEl('rect', { x: 0, y: 0, width: totalW, height: GANTT_HEADER_H, fill: '#fff' }));
  headerG.appendChild(makeSVGEl('line', { x1: 0, y1: GANTT_HEADER_H, x2: totalW, y2: GANTT_HEADER_H, stroke: '#c8cfd9', 'stroke-width': 2 }));
  headerG.appendChild(makeSVGEl('line', { x1: 0, y1: 28, x2: totalW, y2: 28, stroke: '#e2e5ec', 'stroke-width': 1 }));

  const monthKeys = Object.keys(months).sort();
  monthKeys.forEach((key, i) => {
    const m = months[key];
    const nextX = monthKeys[i + 1] ? months[monthKeys[i + 1]].x : totalW;
    const mW = nextX - m.x;
    headerG.appendChild(makeSVGEl('line', { x1: m.x, y1: 0, x2: m.x, y2: 28, stroke: '#c8cfd9', 'stroke-width': 1 }));
    if (mW > 20) {
      const t = makeSVGEl('text', { x: m.x + mW / 2, y: 18, 'text-anchor': 'middle', 'font-size': 11, 'font-weight': 600, fill: '#374151' });
      t.textContent = m.label;
      headerG.appendChild(t);
    }
  });

  if (state.zoom === 'day') {
    for (let day = 0; day <= maxDay; day++) {
      const d = addDays(startDate, day);
      const x = day * dayW;
      if (dayW > 10) {
        const t = makeSVGEl('text', { x: x + dayW / 2, y: 46, 'text-anchor': 'middle', 'font-size': 9, fill: '#6b7280' });
        t.textContent = d.getDate();
        headerG.appendChild(t);
      }
      if (d.getDay() === 0 || day === 0) {
        headerG.appendChild(makeSVGEl('line', { x1: x, y1: 28, x2: x, y2: GANTT_HEADER_H, stroke: '#ddd', 'stroke-width': 1 }));
      }
    }
  } else {
    for (let day = 0; day < maxDay; day += 7) {
      const d = addDays(startDate, day);
      const x = day * dayW;
      const wW = Math.min(7 * dayW, totalW - x);
      headerG.appendChild(makeSVGEl('line', { x1: x, y1: 28, x2: x, y2: GANTT_HEADER_H, stroke: '#ddd', 'stroke-width': 1 }));
      if (wW > 16 && state.zoom !== 'month') {
        const t = makeSVGEl('text', { x: x + wW / 2, y: 46, 'text-anchor': 'middle', 'font-size': 10, fill: '#6b7280' });
        t.textContent = `W${getISOWeek(d)}`;
        headerG.appendChild(t);
      }
    }
  }

  svg.appendChild(headerG);
}

function getISOWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
}

function drawArrow(g, x1, y1, x2, y2, dayW) {
  const offset = Math.max(8, dayW * 0.5);
  const midX = x1 + offset;
  let d;
  if (x2 >= midX + 4) {
    d = `M ${x1} ${y1} H ${midX} V ${y2} H ${x2}`;
  } else {
    const loopX = x2 - offset;
    const topY = Math.min(y1, y2) - ROW_H * 0.6;
    d = `M ${x1} ${y1} H ${x1 + offset} V ${topY} H ${loopX} V ${y2} H ${x2}`;
  }
  g.appendChild(makeSVGEl('path', { d, stroke: '#94a3b8', 'stroke-width': 1.5, fill: 'none', 'marker-end': 'url(#arrow)' }));
}

function makeSVGEl(tag, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function truncate(str, maxChars) {
  if (!str) return '';
  return str.length <= maxChars ? str : str.slice(0, maxChars - 1) + '…';
}

// ── Canvas View ───────────────────────────────────────────────
function autoLayoutCanvas(p) {
  const tasks = p.tasks;
  if (!tasks.length) return;
  const needsLayout = tasks.some(t => t.canvasX === undefined || t.canvasY === undefined);
  if (!needsLayout) return;

  const byId = Object.fromEntries(tasks.map(t => [t.id, t]));

  // Compute depth level (longest dependency chain)
  const levels = {};
  function getLevel(id, visiting = new Set()) {
    if (levels[id] !== undefined) return levels[id];
    if (visiting.has(id)) return 0; // cycle guard
    visiting.add(id);
    const deps = normalizeDeps(byId[id]?.dependencies).map(d => d.id).filter(d => byId[d]);
    levels[id] = deps.length ? Math.max(...deps.map(d => getLevel(d, visiting))) + 1 : 0;
    return levels[id];
  }
  tasks.forEach(t => getLevel(t.id));

  // Group by level, sort within level by team for visual clustering
  const byLevel = {};
  tasks.forEach(t => {
    const lv = levels[t.id] || 0;
    (byLevel[lv] = byLevel[lv] || []).push(t);
  });
  Object.values(byLevel).forEach(col =>
    col.sort((a, b) => ((a.teams || [])[0] || '').localeCompare((b.teams || [])[0] || ''))
  );

  const PAD = 60;
  Object.keys(byLevel).sort((a, b) => +a - +b).forEach(lv => {
    byLevel[lv].forEach((t, row) => {
      if (t.canvasX === undefined) t.canvasX = PAD + +lv * CANVAS_COL_GAP;
      if (t.canvasY === undefined) t.canvasY = PAD + row * CANVAS_ROW_GAP;
    });
  });
}

function fitCanvas(p) {
  if (!p || !p.tasks.length) return;
  const view = document.getElementById('canvas-view');
  const panArea = document.getElementById('canvas-pan-area');
  if (!view || !panArea) return;

  const toolbarH = document.getElementById('canvas-inner-toolbar')?.offsetHeight || 0;
  const vW = view.offsetWidth;
  const vH = view.offsetHeight - toolbarH - 24;

  const minX = Math.min(...p.tasks.map(t => t.canvasX || 0));
  const minY = Math.min(...p.tasks.map(t => t.canvasY || 0));
  const maxX = Math.max(...p.tasks.map(t => (t.canvasX || 0) + CARD_W));
  const maxY = Math.max(...p.tasks.map(t => (t.canvasY || 0) + CARD_H));

  const pad = 80;
  const zoom = Math.min(1.5, Math.min(vW / (maxX - minX + pad * 2), vH / (maxY - minY + pad * 2)));
  canvasState.zoom = zoom;
  canvasState.pan.x = (vW - (maxX - minX) * zoom) / 2 - minX * zoom;
  canvasState.pan.y = toolbarH + 20 + (vH - (maxY - minY) * zoom) / 2 - minY * zoom;

  panArea.style.transform = `translate(${canvasState.pan.x}px,${canvasState.pan.y}px) scale(${canvasState.zoom})`;
}

function renderCanvas() {
  const p = currentProject();
  const view = document.getElementById('canvas-view');

  // Clean up old pan/zoom listeners
  if (view._cleanupCanvas) { view._cleanupCanvas(); view._cleanupCanvas = null; }

  // Remove old pan area (keep inner toolbar)
  const old = document.getElementById('canvas-pan-area');
  if (old) old.remove();

  if (!p || !p.tasks.length) return;

  autoLayoutCanvas(p);
  const schedule = computeSchedule(p);
  const byId = Object.fromEntries(p.tasks.map(t => [t.id, t]));

  // ── Pan area ──────────────────────────────────────
  const panArea = document.createElement('div');
  panArea.id = 'canvas-pan-area';
  panArea.style.cssText = `position:absolute;top:0;left:0;width:0;height:0;transform-origin:0 0`;
  panArea.style.transform = `translate(${canvasState.pan.x}px,${canvasState.pan.y}px) scale(${canvasState.zoom})`;
  view.appendChild(panArea);

  // ── SVG arrows layer ──────────────────────────────
  const arrowsSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  arrowsSvg.id = 'canvas-arrows-svg';
  arrowsSvg.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;overflow:visible;width:1px;height:1px';

  const defs = makeSVGEl('defs');
  const marker = makeSVGEl('marker', {
    id: 'canvas-arrow', viewBox: '0 0 8 8', refX: 7, refY: 4,
    markerWidth: 6, markerHeight: 6, orient: 'auto-start-reverse',
  });
  marker.appendChild(makeSVGEl('path', { d: 'M 0 0 L 8 4 L 0 8 z', fill: '#94a3b8' }));
  defs.appendChild(marker);
  arrowsSvg.appendChild(defs);

  const ghostLine = makeSVGEl('line', {
    id: 'canvas-ghost-line',
    stroke: '#5865f5', 'stroke-width': 2, 'stroke-dasharray': '6 4',
    opacity: 0, 'pointer-events': 'none',
  });
  arrowsSvg.appendChild(ghostLine);
  panArea.appendChild(arrowsSvg);

  // ── Cards ─────────────────────────────────────────
  p.tasks.forEach(task => {
    panArea.appendChild(makeCanvasCard(task, p, schedule, arrowsSvg));
  });

  drawCanvasArrows(arrowsSvg, p, byId);

  // ── Interactions ──────────────────────────────────
  setupCanvasPanZoom(view, panArea);
  setupCanvasDepConnect(view, panArea, arrowsSvg, p, byId);
}

function makeCanvasCard(task, p, schedule, arrowsSvg) {
  const s = schedule && schedule[task.id];
  const teams = p.teams || [];
  const taskTeams = (task.teams || []).map(id => teams.find(t => t.id === id)).filter(Boolean);
  const isCritical = !!(s && s.isCritical);

  const card = document.createElement('div');
  card.className = 'canvas-card' + (isCritical ? ' critical' : '');
  card.dataset.taskId = task.id;
  card.style.left = (task.canvasX || 0) + 'px';
  card.style.top  = (task.canvasY || 0) + 'px';

  // Left color bar
  const bar = document.createElement('div');
  bar.className = 'canvas-card-colorbar';
  if (taskTeams.length === 0) {
    bar.style.background = task.color;
  } else if (taskTeams.length === 1) {
    bar.style.background = taskTeams[0].color;
  } else {
    const stops = taskTeams.map((t, i) => {
      const p0 = Math.round(i * 100 / taskTeams.length);
      const p1 = Math.round((i + 1) * 100 / taskTeams.length);
      return `${t.color} ${p0}%, ${t.color} ${p1}%`;
    }).join(', ');
    bar.style.background = `linear-gradient(to bottom, ${stops})`;
  }
  card.appendChild(bar);

  // Body
  const body = document.createElement('div');
  body.className = 'canvas-card-body';

  // Context label (deliverable / group)
  const deliv = task.deliverableId ? (p.deliverables || []).find(d => d.id === task.deliverableId) : null;
  const grp = task.groupId ? (p.taskGroups || []).find(g => g.id === task.groupId) : null;
  if (deliv || grp) {
    const ctx = document.createElement('div');
    ctx.className = 'canvas-card-context';
    ctx.textContent = grp && deliv ? deliv.name + ' / ' + grp.name : deliv ? deliv.name : grp.name;
    body.appendChild(ctx);
  }

  const nameEl = document.createElement('div');
  nameEl.className = 'canvas-card-name';
  nameEl.textContent = task.name;
  nameEl.title = task.name;
  body.appendChild(nameEl);

  const meta = document.createElement('div');
  meta.className = 'canvas-card-meta';

  const dur = document.createElement('span');
  dur.className = 'canvas-card-dur';
  dur.textContent = task.duration + 'd';
  meta.appendChild(dur);

  if (task.assignee) {
    const sep = document.createElement('span');
    sep.className = 'canvas-meta-sep';
    sep.textContent = '·';
    meta.appendChild(sep);
    const asgn = document.createElement('span');
    asgn.className = 'canvas-card-assignee';
    asgn.textContent = task.assignee;
    meta.appendChild(asgn);
  }

  taskTeams.forEach(team => {
    const pill = document.createElement('span');
    pill.className = 'canvas-card-team-pill';
    pill.style.cssText = `background:${team.color}22;color:${team.color};border-color:${team.color}55`;
    pill.textContent = team.name;
    meta.appendChild(pill);
  });

  body.appendChild(meta);
  card.appendChild(body);

  // Drag handle (right edge)
  const handle = document.createElement('div');
  handle.className = 'canvas-card-handle';
  handle.dataset.taskId = task.id;
  card.appendChild(handle);

  // ── Move drag ────────────────────────────────────
  card.addEventListener('mousedown', (e) => {
    if (e.target.closest('.canvas-card-handle')) return;
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    const startX = e.clientX, startY = e.clientY;
    const origX = task.canvasX || 0, origY = task.canvasY || 0;
    card.classList.add('dragging');

    const onMove = (e) => {
      task.canvasX = Math.round(origX + (e.clientX - startX) / canvasState.zoom);
      task.canvasY = Math.round(origY + (e.clientY - startY) / canvasState.zoom);
      card.style.left = task.canvasX + 'px';
      card.style.top  = task.canvasY + 'px';
      const p = currentProject();
      if (p) drawCanvasArrows(arrowsSvg, p, Object.fromEntries(p.tasks.map(t => [t.id, t])));
    };
    const onUp = () => {
      card.classList.remove('dragging');
      markDirty();
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  return card;
}

function drawCanvasArrows(svg, p, byId) {
  [...svg.children].forEach(el => {
    if (el.tagName !== 'defs' && el.id !== 'canvas-ghost-line') el.remove();
  });
  p.tasks.forEach(task => {
    const toX = task.canvasX || 0;
    const toY = (task.canvasY || 0) + CARD_H / 2;
    normalizeDeps(task.dependencies).forEach(depObj => {
      const dep = byId[depObj.id];
      if (!dep) return;
      const fromX = (dep.canvasX || 0) + CARD_W;
      const fromY = (dep.canvasY || 0) + CARD_H / 2;
      svg.appendChild(canvasBezier(fromX, fromY, toX, toY));
      // Type label — clickable to cycle FS→FF→SS
      const type = depObj.type || 'FS';
      const mx = fromX + (toX - fromX) * 0.45;
      const my = fromY + (toY - fromY) * 0.45 - 6;
      const pill = makeSVGEl('g', { style: 'cursor:pointer' });
      pill.appendChild(makeSVGEl('rect', { x: mx - 10, y: my - 8, width: 20, height: 13, rx: 3, fill: '#fff', stroke: '#cbd5e1', 'stroke-width': 1 }));
      const lbl = makeSVGEl('text', { x: mx, y: my + 2, 'text-anchor': 'middle', 'font-size': 8, fill: '#64748b', 'font-weight': 700 });
      lbl.textContent = type;
      pill.appendChild(lbl);
      pill.addEventListener('click', (e) => {
        e.stopPropagation();
        const deps = normalizeDeps(task.dependencies);
        const d = deps.find(d => d.id === depObj.id);
        if (d) {
          d.type = DEP_TYPES[(DEP_TYPES.indexOf(d.type) + 1) % DEP_TYPES.length];
          task.dependencies = deps;
          markDirty();
          drawCanvasArrows(svg, p, byId);
        }
      });
      svg.appendChild(pill);
    });
  });
}

function canvasBezier(x1, y1, x2, y2) {
  const cx = Math.max(Math.abs(x2 - x1) * 0.5, 60);
  return makeSVGEl('path', {
    d: `M ${x1} ${y1} C ${x1 + cx} ${y1}, ${x2 - cx} ${y2}, ${x2} ${y2}`,
    stroke: '#94a3b8', 'stroke-width': 1.5, fill: 'none',
    'marker-end': 'url(#canvas-arrow)',
  });
}

function setupCanvasPanZoom(view, panArea) {
  let panning = null;

  const onWheel = (e) => {
    e.preventDefault();
    const rect = view.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const factor = e.deltaY < 0 ? 1.08 : 0.93;
    const newZoom = Math.min(3, Math.max(0.15, canvasState.zoom * factor));
    canvasState.pan.x = mx - (mx - canvasState.pan.x) * (newZoom / canvasState.zoom);
    canvasState.pan.y = my - (my - canvasState.pan.y) * (newZoom / canvasState.zoom);
    canvasState.zoom = newZoom;
    panArea.style.transform = `translate(${canvasState.pan.x}px,${canvasState.pan.y}px) scale(${canvasState.zoom})`;
  };

  const onViewDown = (e) => {
    if (e.target.closest('.canvas-card-handle')) return;
    if (e.button === 1 || (e.button === 0 && !e.target.closest('.canvas-card'))) {
      e.preventDefault();
      panning = { sx: e.clientX, sy: e.clientY, ox: canvasState.pan.x, oy: canvasState.pan.y };
      view.style.cursor = 'grabbing';
    }
  };

  const onDocMove = (e) => {
    if (!panning) return;
    canvasState.pan.x = panning.ox + e.clientX - panning.sx;
    canvasState.pan.y = panning.oy + e.clientY - panning.sy;
    panArea.style.transform = `translate(${canvasState.pan.x}px,${canvasState.pan.y}px) scale(${canvasState.zoom})`;
  };

  const onDocUp = () => {
    if (panning) { panning = null; view.style.cursor = ''; }
  };

  view.addEventListener('wheel', onWheel, { passive: false });
  view.addEventListener('mousedown', onViewDown);
  document.addEventListener('mousemove', onDocMove);
  document.addEventListener('mouseup', onDocUp);

  view._cleanupCanvas = () => {
    view.removeEventListener('wheel', onWheel);
    view.removeEventListener('mousedown', onViewDown);
    document.removeEventListener('mousemove', onDocMove);
    document.removeEventListener('mouseup', onDocUp);
  };
}

function setupCanvasDepConnect(view, panArea, arrowsSvg, p, byId) {
  const ghostLine = document.getElementById('canvas-ghost-line');

  panArea.addEventListener('mousedown', (e) => {
    const handle = e.target.closest('.canvas-card-handle');
    if (!handle) return;
    e.preventDefault();
    e.stopPropagation();

    const taskId = handle.dataset.taskId;
    const task = byId[taskId];
    if (!task) return;

    const fromX = (task.canvasX || 0) + CARD_W;
    const fromY = (task.canvasY || 0) + CARD_H / 2;
    const viewRect = view.getBoundingClientRect();

    document.querySelectorAll(`.canvas-card:not([data-task-id="${taskId}"])`).forEach(c => {
      c.classList.add('dep-target');
    });

    const toLocal = (e) => ({
      x: (e.clientX - viewRect.left - canvasState.pan.x) / canvasState.zoom,
      y: (e.clientY - viewRect.top  - canvasState.pan.y) / canvasState.zoom,
    });

    const onMove = (e) => {
      const { x, y } = toLocal(e);
      ghostLine.setAttribute('x1', fromX); ghostLine.setAttribute('y1', fromY);
      ghostLine.setAttribute('x2', x);     ghostLine.setAttribute('y2', y);
      ghostLine.setAttribute('opacity', 1);

      document.querySelectorAll('.canvas-card.dep-target').forEach(c => {
        const t = byId[c.dataset.taskId];
        if (!t) return;
        const inside = x >= (t.canvasX || 0) && x <= (t.canvasX || 0) + CARD_W
                    && y >= (t.canvasY || 0) && y <= (t.canvasY || 0) + CARD_H;
        c.classList.toggle('dep-hover', inside);
        if (inside) {
          const bad = wouldCreateCycle(p, taskId, c.dataset.taskId);
          c.classList.toggle('dep-bad', bad);
          c.classList.toggle('dep-good', !bad);
        } else {
          c.classList.remove('dep-bad', 'dep-good');
        }
      });
    };

    const onUp = () => {
      ghostLine.setAttribute('opacity', 0);

      const hovered = document.querySelector('.canvas-card.dep-hover');
      if (hovered) {
        const targetId = hovered.dataset.taskId;
        if (wouldCreateCycle(p, taskId, targetId)) {
          showToast('Cannot link — would create a cycle');
        } else {
          const t = byId[targetId];
          if (t && !normalizeDeps(t.dependencies).some(d => d.id === taskId)) {
            t.dependencies = [...normalizeDeps(t.dependencies), { id: taskId, type: 'FS' }];
            markDirty();
            drawCanvasArrows(arrowsSvg, p, byId);
          }
        }
      }

      document.querySelectorAll('.canvas-card').forEach(c => {
        c.classList.remove('dep-target', 'dep-hover', 'dep-bad', 'dep-good');
      });
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// ── Empty State ──────────────────────────────────────────────
function showEmptyState() {
  let el = document.getElementById('empty-state');
  if (!el) {
    el = document.createElement('div');
    el.id = 'empty-state';
    el.innerHTML = `<h2>No project selected</h2><p>Create a new project to get started.</p><button id="empty-new-btn">+ New Project</button>`;
    document.getElementById('table-view').prepend(el);
    document.getElementById('empty-new-btn').addEventListener('click', newProject);
  }
  el.style.display = 'flex';
  document.getElementById('table-scroll').style.display = 'none';
  document.getElementById('quick-add-area').style.display = 'none';
}

function hideEmptyState() {
  const el = document.getElementById('empty-state');
  if (el) el.style.display = 'none';
  document.getElementById('table-scroll').style.display = '';
  document.getElementById('quick-add-area').style.display = '';
}

// ── Confirm Modal ────────────────────────────────────────────
function showConfirm(msg, onConfirm) {
  document.getElementById('modal-msg').textContent = msg;
  document.getElementById('modal-overlay').classList.remove('hidden');
  const close = () => document.getElementById('modal-overlay').classList.add('hidden');
  const confirmBtn = document.getElementById('modal-confirm');
  const cancelBtn  = document.getElementById('modal-cancel');
  confirmBtn.replaceWith(confirmBtn.cloneNode(true));
  cancelBtn.replaceWith(cancelBtn.cloneNode(true));
  document.getElementById('modal-confirm').addEventListener('click', () => { close(); onConfirm(); });
  document.getElementById('modal-cancel').addEventListener('click', close);
}

// ── Dependency Popover ───────────────────────────────────────
function openDepPopover(taskId, anchorEl) {
  const p = currentProject();
  if (!p) return;
  closeDepPopover();
  closeTeamPopover();

  const task = p.tasks.find(t => t.id === taskId);
  const normDeps = normalizeDeps(task?.dependencies);
  const currentDepMap = new Map(normDeps.map(d => [d.id, d.type])); // id → type
  const inner = document.getElementById('dep-popover-inner');
  inner.innerHTML = '';

  const title = document.createElement('div');
  title.className = 'team-popover-title';
  title.textContent = 'Depends on';
  inner.appendChild(title);

  const delivMap = Object.fromEntries((p.deliverables || []).map(d => [d.id, d]));
  const groupMap = Object.fromEntries((p.taskGroups || []).map(g => [g.id, g]));

  const others = p.tasks.filter(t => t.id !== taskId);
  if (!others.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'padding:12px 14px;color:#aaa;font-size:13px';
    empty.textContent = 'No other tasks yet.';
    inner.appendChild(empty);
  } else {
    others.forEach(t => {
      const idx = p.tasks.indexOf(t);
      const isChecked = currentDepMap.has(t.id);
      const cyclic = !isChecked && wouldCreateCycle(p, t.id, taskId);

      const opt = document.createElement('label');
      opt.className = 'team-option';
      if (cyclic) opt.style.opacity = '0.4';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = isChecked;
      cb.disabled = cyclic;
      cb.addEventListener('change', () => {
        const tk = p.tasks.find(tk => tk.id === taskId);
        if (cb.checked) {
          tk.dependencies = [...normalizeDeps(tk.dependencies), { id: t.id, type: 'FS' }];
        } else {
          tk.dependencies = normalizeDeps(tk.dependencies).filter(d => d.id !== t.id);
        }
        markDirty();
        renderAll();
        openDepPopover(taskId, anchorEl);
      });

      const numSpan = document.createElement('span');
      numSpan.style.cssText = 'min-width:18px;text-align:right;font-size:11px;color:#888;flex-shrink:0';
      numSpan.textContent = idx + 1;

      const nameSpan = document.createElement('span');
      nameSpan.className = 'team-option-name';
      nameSpan.textContent = t.name;

      opt.appendChild(cb);
      opt.appendChild(numSpan);
      opt.appendChild(nameSpan);

      // Context label: deliverable / group
      const deliv = t.deliverableId ? delivMap[t.deliverableId] : null;
      const group = t.groupId ? groupMap[t.groupId] : null;
      const ctxText = group && deliv ? deliv.name + ' / ' + group.name
                    : deliv ? deliv.name
                    : group ? group.name : '';
      if (ctxText) {
        const ctx = document.createElement('span');
        ctx.className = 'dep-popover-context';
        ctx.textContent = ctxText;
        opt.appendChild(ctx);
      }

      // Type cycling badge (shown when checked)
      if (isChecked) {
        const typeBadge = document.createElement('span');
        typeBadge.className = 'dep-type-inline';
        typeBadge.textContent = currentDepMap.get(t.id) || 'FS';
        typeBadge.title = 'Click to cycle type (FS→FF→SS)';
        typeBadge.addEventListener('click', (e) => {
          e.preventDefault(); e.stopPropagation();
          const tk = p.tasks.find(tk => tk.id === taskId);
          if (!tk) return;
          const deps = normalizeDeps(tk.dependencies);
          const d = deps.find(d => d.id === t.id);
          if (d) {
            d.type = DEP_TYPES[(DEP_TYPES.indexOf(d.type) + 1) % DEP_TYPES.length];
            tk.dependencies = deps;
            markDirty();
            renderAll();
            openDepPopover(taskId, anchorEl);
          }
        });
        opt.appendChild(typeBadge);
      }

      if (cyclic) {
        const note = document.createElement('span');
        note.style.cssText = 'font-size:10px;color:#bbb;flex-shrink:0;margin-left:4px';
        note.textContent = 'cycle';
        opt.appendChild(note);
      }
      inner.appendChild(opt);
    });
  }

  const popover = document.getElementById('dep-popover');
  popover.classList.remove('hidden');
  const rect = anchorEl.getBoundingClientRect();
  const pw = 280;
  let left = rect.left;
  let top = rect.bottom + 4;
  if (left + pw > window.innerWidth - 8) left = window.innerWidth - pw - 8;
  if (top + 320 > window.innerHeight - 8) top = rect.top - Math.min(inner.scrollHeight + 20, 320) - 4;
  popover.style.left = Math.max(8, left) + 'px';
  popover.style.top = Math.max(8, top) + 'px';
}

function closeDepPopover() {
  document.getElementById('dep-popover').classList.add('hidden');
}

// ── Cycle Detection ───────────────────────────────────────────
// Returns true if adding newDepId as a dependency of taskId would create a cycle.
// A cycle occurs when newDepId already (transitively) depends on taskId.
function wouldCreateCycle(p, newDepId, taskId) {
  const byId = Object.fromEntries(p.tasks.map(t => [t.id, t]));
  const visited = new Set();
  function reaches(id) {
    if (id === taskId) return true;
    if (visited.has(id)) return false;
    visited.add(id);
    return normalizeDeps(byId[id]?.dependencies).some(d => reaches(d.id));
  }
  return reaches(newDepId);
}

// ── Gantt Drag-to-Connect ─────────────────────────────────────
function setupGanttDragConnect(svg, barPositions, p) {
  const ghost = makeSVGEl('g', { 'pointer-events': 'none' });
  const ghostLine = makeSVGEl('line', {
    stroke: '#4a7cf8', 'stroke-width': 2.5, 'stroke-dasharray': '7 4', opacity: 0,
  });
  const ghostDot = makeSVGEl('circle', { r: 6, fill: '#4a7cf8', opacity: 0 });
  ghost.appendChild(ghostLine);
  ghost.appendChild(ghostDot);
  svg.appendChild(ghost);

  const handles  = new Map(); // taskId → dot circle
  const dropZones = new Map(); // taskId → rect

  p.tasks.forEach((task, i) => {
    const pos = barPositions[task.id];
    if (!pos) return;
    const barY = GANTT_HEADER_H + i * ROW_H;

    // Visible dot at bar right edge (shown on hover)
    const dot = makeSVGEl('circle', {
      cx: pos.x + pos.w, cy: pos.y, r: 5,
      fill: '#fff', stroke: '#4a7cf8', 'stroke-width': 2,
      opacity: 0, 'pointer-events': 'none',
    });
    handles.set(task.id, dot);
    svg.appendChild(dot);

    // Wide invisible hover zone at right edge
    const hoverZone = makeSVGEl('rect', {
      x: pos.x + pos.w - 10, y: barY + BAR_TOP - 2,
      width: 24, height: BAR_H + 4,
      fill: 'transparent', style: 'cursor:crosshair',
    });
    hoverZone.addEventListener('mouseenter', () => { if (!dragDep) dot.setAttribute('opacity', 1); });
    hoverZone.addEventListener('mouseleave', () => { if (!dragDep) dot.setAttribute('opacity', 0); });
    hoverZone.addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation();
      dragDep = { fromId: task.id, fromX: pos.x + pos.w, fromY: pos.y };
      dot.setAttribute('opacity', 1);
      dropZones.forEach((dz, tid) => {
        if (tid !== task.id) dz.setAttribute('pointer-events', 'all');
      });
    });
    svg.appendChild(hoverZone);

    // Drop zone: full bar area, enabled only during drag
    const dropZone = makeSVGEl('rect', {
      x: pos.x - 2, y: barY + BAR_TOP - 2,
      width: pos.w + 4, height: BAR_H + 4, rx: 4,
      fill: 'transparent', 'pointer-events': 'none',
    });
    dropZones.set(task.id, dropZone);
    dropZone.addEventListener('mouseenter', () => {
      if (!dragDep || dragDep.fromId === task.id) return;
      const bad = wouldCreateCycle(p, dragDep.fromId, task.id);
      dropZone.setAttribute('fill', bad ? 'rgba(239,68,68,0.18)' : 'rgba(74,124,248,0.22)');
    });
    dropZone.addEventListener('mouseleave', () => dropZone.setAttribute('fill', 'transparent'));
    dropZone.addEventListener('mouseup', () => {
      if (!dragDep || dragDep.fromId === task.id) return;
      if (wouldCreateCycle(p, dragDep.fromId, task.id)) {
        showToast('Cannot create dependency — would form a cycle');
      } else {
        const t = p.tasks.find(t => t.id === task.id);
        if (t && !normalizeDeps(t.dependencies).some(d => d.id === dragDep.fromId)) {
          t.dependencies = [...normalizeDeps(t.dependencies), { id: dragDep.fromId, type: 'FS' }];
          markDirty();
          renderAll();
          return; // renderAll calls renderGantt which does cleanup
        }
      }
      endDrag();
    });
    svg.appendChild(dropZone);
  });

  // Document-level mouse tracking while dragging
  const onMove = (e) => {
    if (!dragDep) return;
    const r = svg.getBoundingClientRect();
    const mx = e.clientX - r.left, my = e.clientY - r.top;
    ghostLine.setAttribute('x1', dragDep.fromX); ghostLine.setAttribute('y1', dragDep.fromY);
    ghostLine.setAttribute('x2', mx);            ghostLine.setAttribute('y2', my);
    ghostLine.setAttribute('opacity', 1);
    ghostDot.setAttribute('cx', mx); ghostDot.setAttribute('cy', my);
    ghostDot.setAttribute('opacity', 1);
  };
  const onUp = () => { if (dragDep) endDrag(); };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);

  // Expose cleanup so next renderGantt call can remove these listeners
  svg._cleanupDrag = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    dragDep = null;
  };

  function endDrag() {
    ghostLine.setAttribute('opacity', 0);
    ghostDot.setAttribute('opacity', 0);
    handles.forEach(h => h.setAttribute('opacity', 0));
    dropZones.forEach(dz => { dz.setAttribute('fill', 'transparent'); dz.setAttribute('pointer-events', 'none'); });
    dragDep = null;
  }
}

// ── Toast notification ────────────────────────────────────────
function showToast(msg) {
  const t = document.createElement('div');
  t.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#374151;color:#fff;padding:10px 18px;border-radius:6px;font-size:13px;font-weight:500;z-index:999;box-shadow:0 4px 12px rgba(0,0,0,.25);pointer-events:none';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3000);
}

// ── Event Wiring ──────────────────────────────────────────────
function wireEvents() {
  document.getElementById('new-project-btn').addEventListener('click', newProject);

  const nameEl = document.getElementById('project-name');
  nameEl.addEventListener('input', () => {
    const p = currentProject(); if (!p) return;
    p.name = nameEl.value; markDirty(); renderSidebar();
  });

  const startEl = document.getElementById('project-start');
  startEl.addEventListener('change', () => {
    const p = currentProject(); if (!p) return;
    p.startDate = startEl.value; markDirty(); renderDates();
    if (state.view === 'gantt') renderGantt();
  });

  document.querySelectorAll('.view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.view = btn.dataset.view;
      document.querySelectorAll('.view-btn').forEach(b => b.classList.toggle('active', b === btn));
      ['table', 'gantt', 'canvas'].forEach(v => {
        const el = document.getElementById(v + '-view');
        el.classList.toggle('hidden', state.view !== v);
        el.classList.toggle('active', state.view === v);
      });
      document.getElementById('zoom-controls').classList.toggle('hidden', state.view !== 'gantt');
      if (state.view === 'gantt') renderGantt();
      else if (state.view === 'canvas') renderCanvas();
      else renderTable();
    });
  });

  document.querySelectorAll('.zoom-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      state.zoom = btn.dataset.zoom;
      document.querySelectorAll('.zoom-btn').forEach(b => b.classList.toggle('active', b === btn));
      renderGantt();
    });
  });

  // Streams button
  document.getElementById('streams-btn').addEventListener('click', openStreamsModal);
  document.getElementById('streams-modal-close').addEventListener('click', closeStreamsModal);
  document.getElementById('streams-overlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('streams-overlay')) closeStreamsModal();
  });
  document.getElementById('add-stream-btn').addEventListener('click', addStream);

  // Teams button
  document.getElementById('teams-btn').addEventListener('click', openTeamsModal);
  document.getElementById('teams-modal-close').addEventListener('click', closeTeamsModal);
  document.getElementById('teams-overlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('teams-overlay')) closeTeamsModal();
  });
  document.getElementById('add-team-btn').addEventListener('click', addTeam);

  // Deliverables button
  document.getElementById('deliverables-btn').addEventListener('click', openDeliverablesModal);
  document.getElementById('deliverables-modal-close').addEventListener('click', closeDeliverablesModal);
  document.getElementById('deliverables-overlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('deliverables-overlay')) closeDeliverablesModal();
  });
  document.getElementById('add-deliverable-btn').addEventListener('click', addDeliverable);

  // Close popovers on outside click
  document.addEventListener('click', (e) => {
    const teamPop = document.getElementById('team-popover');
    if (!teamPop.classList.contains('hidden') && !teamPop.contains(e.target) && !e.target.closest('.teams-cell')) {
      closeTeamPopover();
    }
    const depPop = document.getElementById('dep-popover');
    if (!depPop.classList.contains('hidden') && !depPop.contains(e.target) && !e.target.closest('.deps-cell')) {
      closeDepPopover();
    }
  });

  document.getElementById('save-btn').addEventListener('click', saveData);

  document.getElementById('print-btn').addEventListener('click', () => {
    if (state.view !== 'gantt') {
      state.view = 'gantt';
      document.querySelectorAll('.view-btn').forEach(b => b.classList.toggle('active', b.dataset.view === 'gantt'));
      ['table', 'canvas'].forEach(v => {
        document.getElementById(v + '-view').classList.add('hidden');
        document.getElementById(v + '-view').classList.remove('active');
      });
      document.getElementById('gantt-view').classList.remove('hidden');
      document.getElementById('gantt-view').classList.add('active');
      document.getElementById('zoom-controls').classList.remove('hidden');
      renderGantt();
    }
    setTimeout(() => window.print(), 100);
  });

  const qaInput = document.getElementById('quick-add-input');
  const doQuickAdd = () => {
    const task = parseQuickAdd(qaInput.value);
    if (task) { addTask(task); qaInput.value = ''; }
  };
  document.getElementById('quick-add-btn').addEventListener('click', doQuickAdd);
  qaInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); doQuickAdd(); } });

  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveData(); }
    if (e.key === 'Escape') { closeTeamPopover(); closeTeamsModal(); closeDepPopover(); closeDeliverablesModal(); closeStreamsModal(); }
  });

  document.getElementById('canvas-auto-layout-btn').addEventListener('click', () => {
    const p = currentProject(); if (!p) return;
    p.tasks.forEach(t => { delete t.canvasX; delete t.canvasY; });
    markDirty();
    renderCanvas();
  });

  document.getElementById('canvas-fit-btn').addEventListener('click', () => {
    fitCanvas(currentProject());
  });
}

// ── Boot ──────────────────────────────────────────────────────
wireEvents();
loadData();
