const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'tasks.db');
const db = new Database(DB_PATH);

function init() {
  db.exec(`CREATE TABLE IF NOT EXISTS users (
    user_id    INTEGER PRIMARY KEY,
    username   TEXT NOT NULL,
    chat_id    INTEGER NOT NULL,
    role       TEXT DEFAULT 'employee',
    department TEXT DEFAULT NULL,
    manager_id INTEGER DEFAULT NULL,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`);

  try { db.exec(`ALTER TABLE users ADD COLUMN manager_id INTEGER DEFAULT NULL`); } catch(e) {}
  try { db.exec(`ALTER TABLE users ADD COLUMN department TEXT DEFAULT NULL`); } catch(e) {}

  db.exec(`CREATE TABLE IF NOT EXISTS tasks (
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

  db.exec(`CREATE TABLE IF NOT EXISTS reminders (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id   INTEGER NOT NULL,
    remind_at TEXT NOT NULL,
    sent      INTEGER DEFAULT 0
  )`);
}

function getUser(id) {
  return db.prepare('SELECT * FROM users WHERE user_id=?').get(id);
}

function getAllUsers() {
  return db.prepare('SELECT * FROM users ORDER BY username').all();
}

function getEmployees() {
  return db.prepare("SELECT * FROM users WHERE role='employee' ORDER BY username").all();
}

function getManagers() {
  return db.prepare("SELECT * FROM users WHERE role='manager' ORDER BY username").all();
}

function getDirectors() {
  return db.prepare("SELECT * FROM users WHERE role='director' ORDER BY username").all();
}

function isManager(uid) {
  const u = getUser(uid);
  return u?.role === 'manager' || u?.role === 'director';
}

function isDirector(uid) {
  const u = getUser(uid);
  return u?.role === 'director';
}

function upsertUser(userId, username, chatId, role) {
  const existing = getUser(userId);
  if (existing) {
    db.prepare('UPDATE users SET username=?, chat_id=? WHERE user_id=?').run(username, chatId, userId);
    if (role) db.prepare('UPDATE users SET role=? WHERE user_id=?').run(role, userId);
  } else {
    db.prepare('INSERT INTO users (user_id,username,chat_id,role) VALUES (?,?,?,?)').run(
      userId, username, chatId, role || 'employee'
    );
  }
}

function promoteToManager(userId, chatId, username, department) {
  upsertUser(userId, username, chatId, 'manager');
  db.prepare('UPDATE users SET department=? WHERE user_id=?').run(department, userId);
}

function promoteToDirector(userId, chatId, username) {
  upsertUser(userId, username, chatId, 'director');
  db.prepare("UPDATE users SET department='Комерційний директор' WHERE user_id=?").run(userId);
}

function assignStaff(employeeId, managerId) {
  db.prepare('UPDATE users SET manager_id=? WHERE user_id=?').run(managerId, employeeId);
}

function getStaffOf(managerId) {
  return db.prepare('SELECT * FROM users WHERE manager_id=? ORDER BY username').all(managerId);
}

function getManagerOf(employeeId) {
  const u = getUser(employeeId);
  if (!u?.manager_id) return null;
  return getUser(u.manager_id);
}

function getUnassignedEmployees() {
  return db.prepare(
    "SELECT * FROM users WHERE manager_id IS NULL AND role='employee' ORDER BY username"
  ).all();
}

function unassignAll() {
  db.prepare('UPDATE users SET manager_id=NULL').run();
}

function createTask({ employeeId, managerId, title, description, checkpoints, deadline }) {
  const result = db.prepare(
    'INSERT INTO tasks (employee_id,manager_id,title,description,checkpoints,deadline) VALUES (?,?,?,?,?,?)'
  ).run(employeeId, managerId, title, description || '', checkpoints || '', deadline || null);
  return result.lastInsertRowid;
}

function getTask(id) {
  return db.prepare('SELECT * FROM tasks WHERE id=?').get(id);
}

function getTaskFull(id) {
  const t = getTask(id);
  if (!t) return null;
  t.employee = getUser(t.employee_id);
  t.manager  = getUser(t.manager_id);
  t.cpList   = t.checkpoints ? t.checkpoints.split('\n').filter(Boolean) : [];
  return t;
}

function getManagerTasks(managerId) {
  return db.prepare('SELECT * FROM tasks WHERE manager_id=? ORDER BY created_at DESC').all(managerId);
}

function getTasksForStaffOf(managerId) {
  return db.prepare(`
    SELECT t.*, u.username as emp_name FROM tasks t
    JOIN users u ON t.employee_id=u.user_id
    WHERE u.manager_id=? ORDER BY t.created_at DESC
  `).all(managerId);
}

function getEmployeeActiveTasks(employeeId) {
  return db.prepare(
    "SELECT * FROM tasks WHERE employee_id=? AND status='pending' ORDER BY created_at DESC"
  ).all(employeeId);
}

function completeTask(taskId, comment) {
  db.prepare(
    "UPDATE tasks SET status='done', done_comment=?, updated_at=datetime('now','localtime') WHERE id=?"
  ).run(comment, taskId);
}

function addReminder(taskId, minutesFromNow) {
  const at = new Date(Date.now() + minutesFromNow * 60000).toISOString();
  db.prepare('INSERT INTO reminders (task_id,remind_at) VALUES (?,?)').run(taskId, at);
}

function getDueReminders() {
  return db.prepare(`
    SELECT r.*, t.title, t.employee_id, t.status
    FROM reminders r JOIN tasks t ON r.task_id=t.id
    WHERE r.sent=0 AND r.remind_at<=? AND t.status='pending'
  `).all(new Date().toISOString());
}

function markReminderSent(id) {
  db.prepare('UPDATE reminders SET sent=1 WHERE id=?').run(id);
}

function getManagerStats(managerId) {
  const today = new Date().toISOString().split('T')[0];
  const todayTasks = db.prepare(`
    SELECT t.*, u.username as emp_name FROM tasks t
    JOIN users u ON t.employee_id=u.user_id
    WHERE t.manager_id=? AND date(t.created_at)=? ORDER BY t.created_at DESC
  `).all(managerId, today);
  const overdueTasks = db.prepare(`
    SELECT t.*, u.username as emp_name FROM tasks t
    JOIN users u ON t.employee_id=u.user_id
    WHERE t.manager_id=? AND t.status='pending' AND t.deadline IS NOT NULL AND t.deadline < date('now','localtime')
    ORDER BY t.deadline
  `).all(managerId);
  const allTasks = db.prepare(`
    SELECT t.*, u.username as emp_name FROM tasks t
    JOIN users u ON t.employee_id=u.user_id
    WHERE t.manager_id=? ORDER BY t.created_at DESC LIMIT 50
  `).all(managerId);
  return { todayTasks, overdueTasks, allTasks };
}

module.exports = {
  init,
  upsertUser, getUser, getAllUsers, getEmployees, getManagers, getDirectors,
  isManager, isDirector, promoteToManager, promoteToDirector,
  assignStaff, getStaffOf, getManagerOf, getUnassignedEmployees, unassignAll,
  createTask, getTask, getTaskFull, getManagerTasks, getTasksForStaffOf,
  getEmployeeActiveTasks, completeTask,
  addReminder, getDueReminders, markReminderSent,
  getManagerStats,
};