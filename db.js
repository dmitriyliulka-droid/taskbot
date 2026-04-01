const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'tasks.db');
const db = new sqlite3.Database(DB_PATH);

const run  = (sql, params = []) => new Promise((res, rej) => db.run(sql, params, function(err) { err ? rej(err) : res(this); }));
const get  = (sql, params = []) => new Promise((res, rej) => db.get(sql, params, (err, row) => err ? rej(err) : res(row)));
const all  = (sql, params = []) => new Promise((res, rej) => db.all(sql, params, (err, rows) => err ? rej(err) : res(rows)));

async function init() {
  await run(`CREATE TABLE IF NOT EXISTS users (
    user_id    INTEGER PRIMARY KEY,
    username   TEXT NOT NULL,
    chat_id    INTEGER NOT NULL,
    role       TEXT DEFAULT 'employee',
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`);
  await run(`CREATE TABLE IF NOT EXISTS tasks (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id  INTEGER NOT NULL,
    manager_id   INTEGER NOT NULL,
    title        TEXT NOT NULL,
    description  TEXT DEFAULT '',
    checkpoints  TEXT DEFAULT '',
    deadline     TEXT,
    status       TEXT DEFAULT 'pending',
    done_comment TEXT DEFAULT '',
    created_at   TEXT DEFAULT (datetime('now','localtime')),
    updated_at   TEXT DEFAULT (datetime('now','localtime'))
  )`);
  await run(`CREATE TABLE IF NOT EXISTS reminders (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id   INTEGER NOT NULL,
    remind_at TEXT NOT NULL,
    sent      INTEGER DEFAULT 0
  )`);
}

async function upsertUser(userId, username, chatId, role) {
  const existing = await getUser(userId);
  if (existing) {
    await run('UPDATE users SET username=?, chat_id=? WHERE user_id=?', [username, chatId, userId]);
    if (role) await run('UPDATE users SET role=? WHERE user_id=?', [role, userId]);
  } else {
    await run('INSERT INTO users (user_id,username,chat_id,role) VALUES (?,?,?,?)',
      [userId, username, chatId, role || 'employee']);
  }
}

async function getUser(id)      { return get('SELECT * FROM users WHERE user_id=?', [id]); }
async function getEmployees()   { return all("SELECT * FROM users WHERE role='employee' ORDER BY username"); }
async function getManagers()    { return all("SELECT * FROM users WHERE role='manager'"); }
async function isManager(uid)   { const u = await getUser(uid); return u?.role === 'manager'; }
async function promoteToManager(userId, chatId, username) { await upsertUser(userId, username, chatId, 'manager'); }

async function createTask({ employeeId, managerId, title, description, checkpoints, deadline }) {
  const result = await run(
    'INSERT INTO tasks (employee_id,manager_id,title,description,checkpoints,deadline) VALUES (?,?,?,?,?,?)',
    [employeeId, managerId, title, description || '', checkpoints || '', deadline || null]
  );
  return result.lastID;
}

async function getTask(id) { return get('SELECT * FROM tasks WHERE id=?', [id]); }

async function getTaskFull(id) {
  const t = await getTask(id);
  if (!t) return null;
  t.employee = await getUser(t.employee_id);
  t.manager  = await getUser(t.manager_id);
  t.cpList   = t.checkpoints ? t.checkpoints.split('\n').filter(Boolean) : [];
  return t;
}

async function getManagerTasks(managerId) {
  return all('SELECT * FROM tasks WHERE manager_id=? ORDER BY created_at DESC', [managerId]);
}

async function getEmployeeActiveTasks(employeeId) {
  return all("SELECT * FROM tasks WHERE employee_id=? AND status='pending' ORDER BY created_at DESC", [employeeId]);
}

async function completeTask(taskId, comment) {
  await run("UPDATE tasks SET status='done', done_comment=?, updated_at=datetime('now','localtime') WHERE id=?", [comment, taskId]);
}

async function addReminder(taskId, minutesFromNow) {
  const at = new Date(Date.now() + minutesFromNow * 60000).toISOString();
  await run('INSERT INTO reminders (task_id,remind_at) VALUES (?,?)', [taskId, at]);
}

async function getDueReminders() {
  return all(`
    SELECT r.*, t.title, t.employee_id, t.status
    FROM reminders r JOIN tasks t ON r.task_id=t.id
    WHERE r.sent=0 AND r.remind_at<=? AND t.status='pending'
  `, [new Date().toISOString()]);
}

async function markReminderSent(id) { await run('UPDATE reminders SET sent=1 WHERE id=?', [id]); }

async function getManagerStats(managerId) {
  const today = new Date().toISOString().split('T')[0];
  const todayTasks = await all(`
    SELECT t.*, u.username as emp_name FROM tasks t
    JOIN users u ON t.employee_id=u.user_id
    WHERE t.manager_id=? AND date(t.created_at)=? ORDER BY t.created_at DESC
  `, [managerId, today]);
  const overdueTasks = await all(`
    SELECT t.*, u.username as emp_name FROM tasks t
    JOIN users u ON t.employee_id=u.user_id
    WHERE t.manager_id=? AND t.status='pending' AND t.deadline IS NOT NULL AND t.deadline < date('now','localtime')
    ORDER BY t.deadline
  `, [managerId]);
  const allTasks = await all(`
    SELECT t.*, u.username as emp_name FROM tasks t
    JOIN users u ON t.employee_id=u.user_id
    WHERE t.manager_id=? ORDER BY t.created_at DESC LIMIT 50
  `, [managerId]);
  return { todayTasks, overdueTasks, allTasks };
}

module.exports = {
  init,
  upsertUser, getUser, getEmployees, getManagers, isManager, promoteToManager,
  createTask, getTask, getTaskFull, getManagerTasks, getEmployeeActiveTasks, completeTask,
  addReminder, getDueReminders, markReminderSent,
  getManagerStats,
};
