require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const db = require('./db');
const { startSchedulers } = require('./scheduler');

const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) { console.error('❌ BOT_TOKEN не встановлено!'); process.exit(1); }

const bot = new TelegramBot(TOKEN, { polling: true });
const conv = {};

// ─── /start ───────────────────────────────────────────────────────────────────
bot.onText(/\/start/, (msg) => {
  const { id: uid, username, first_name } = msg.from;
  const name = first_name + (username ? ` (@${username})` : '');
  db.upsertUser(uid, name, msg.chat.id, null);
  const u = db.getUser(uid);

  if (u.role === 'director') {
    menuDirector(msg.chat.id, first_name);
  } else if (u.role === 'manager') {
    menuManager(msg.chat.id, first_name);
  } else {
    bot.sendMessage(msg.chat.id,
      `👋 Привіт, *${first_name}*!\n\nТи зареєстрований як *співробітник*.\nКоли керівник призначить тобі задачу — ти отримаєш сповіщення.\n\n📋 /mytasks — переглянути активні задачі`,
      { parse_mode: 'Markdown' }
    );
  }
});

// ─── /director <пароль> ───────────────────────────────────────────────────────
bot.onText(/\/director (.+)/, (msg, match) => {
  const { id: uid, username, first_name } = msg.from;
  const pass = match[1].trim();
  if (pass !== (process.env.DIRECTOR_PASSWORD || 'director123')) {
    bot.sendMessage(msg.chat.id, '❌ Невірний пароль.'); return;
  }
  const name = first_name + (username ? ` (@${username})` : '');
  db.promoteToDirector(uid, msg.chat.id, name);
  bot.sendMessage(msg.chat.id, '✅ Права комерційного директора отримано!');
  menuDirector(msg.chat.id, first_name);
});

// ─── /manager <пароль> ────────────────────────────────────────────────────────
bot.onText(/\/manager (.+)/, (msg, match) => {
  const { id: uid, username, first_name } = msg.from;
  const pass = match[1].trim();
  if (pass !== (process.env.MANAGER_PASSWORD || 'admin123')) {
    bot.sendMessage(msg.chat.id, '❌ Невірний пароль.'); return;
  }
  const name = first_name + (username ? ` (@${username})` : '');
  db.promoteToManager(uid, msg.chat.id, name);
  bot.sendMessage(msg.chat.id, '✅ Права керівника відділу отримано!');
  menuManager(msg.chat.id, first_name);
});

// ─── /menu ────────────────────────────────────────────────────────────────────
bot.onText(/\/menu/, (msg) => {
  const u = db.getUser(msg.from.id);
  if (u?.role === 'director') menuDirector(msg.chat.id);
  else if (u?.role === 'manager') menuManager(msg.chat.id);
});

// ─── /stats ───────────────────────────────────────────────────────────────────
bot.onText(/\/stats/, (msg) => {
  const u = db.getUser(msg.from.id);
  if (u?.role === 'director' || u?.role === 'manager') showStats(msg.chat.id, msg.from.id);
});

// ─── /mytasks ─────────────────────────────────────────────────────────────────
bot.onText(/\/mytasks/, (msg) => showMyTasks(msg.chat.id, msg.from.id));

// ─── /mystaff ─────────────────────────────────────────────────────────────────
bot.onText(/\/mystaff/, (msg) => {
  const u = db.getUser(msg.from.id);
  if (u?.role === 'manager' || u?.role === 'director') showMyStaff(msg.chat.id, msg.from.id);
});

// ─── /addstaff ────────────────────────────────────────────────────────────────
// ─── /resetrole (тільки для тестування) ──────────────────────────────────────
bot.onText(/\/resetrole/, (msg) => {
  db.upsertUser(msg.from.id, msg.from.first_name, msg.chat.id, 'employee');
  db.assignStaff(msg.from.id, null);
  bot.sendMessage(msg.chat.id, '🔄 Роль скинута. Ти знову співробітник.\nНапиши /start');
});
bot.onText(/\/addstaff/, (msg) => {
  const u = db.getUser(msg.from.id);
  if (u?.role !== 'manager') {
    bot.sendMessage(msg.chat.id, '❌ Тільки керівник відділу може додавати підлеглих.');
    return;
  }
  showAddStaff(msg.chat.id, msg.from.id);
});

// ─── Текстові повідомлення (діалоги) ─────────────────────────────────────────
bot.on('message', (msg) => {
  const { id: uid } = msg.from;
  const chatId = msg.chat.id;
  const text   = msg.text;
  if (!text || text.startsWith('/')) return;

  const s = conv[uid];
  if (!s) return;

  switch (s.step) {
    case 'title':
      s.title = text.trim();
      s.step  = 'description';
      bot.sendMessage(chatId, '📄 Додай *опис задачі* або натисни "Пропустити":', {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '⏭ Пропустити', callback_data: 'skip_desc' }]] }
      });
      break;

    case 'description':
      s.description = text.trim();
      askCheckpoints(chatId);
      s.step = 'checkpoints';
      break;

    case 'checkpoints':
      s.checkpoints = text.trim();
      askDeadline(chatId);
      s.step = 'deadline';
      break;

    case 'done_comment': {
      const task = db.getTaskFull(s.taskId);
      if (!task) { delete conv[uid]; return; }
      db.completeTask(s.taskId, text.trim());
      delete conv[uid];
      bot.sendMessage(chatId, '🎉 Задача виконана! Керівник отримає звіт.');
      notifyManagerDone(task, text.trim());
      break;
    }
  }
});

// ─── Callback кнопки ──────────────────────────────────────────────────────────
bot.on('callback_query', (q) => {
  const uid    = q.from.id;
  const chatId = q.message.chat.id;
  const data   = q.data;
  bot.answerCallbackQuery(q.id);

  const u = db.getUser(uid);

  // Нова задача
  if (data === 'new_task') {
    if (!u || (u.role !== 'manager' && u.role !== 'director')) return;
    showEmployeeSelector(chatId, uid);

  // Вибір співробітника
  } else if (data.startsWith('emp_')) {
    conv[uid] = { step: 'title', employeeId: parseInt(data.slice(4)) };
    bot.sendMessage(chatId, '📝 Введи *назву задачі*:', { parse_mode: 'Markdown' });

  // Пропуск опису
  } else if (data === 'skip_desc') {
    const s = conv[uid]; if (!s) return;
    s.description = '';
    askCheckpoints(chatId);
    s.step = 'checkpoints';

  // Пропуск чек-поінтів
  } else if (data === 'skip_checkpoints') {
    const s = conv[uid]; if (!s) return;
    s.checkpoints = '';
    askDeadline(chatId);
    s.step = 'deadline';

  // Дедлайн
  } else if (data.startsWith('dl_')) {
    const s = conv[uid]; if (!s) return;
    const days = parseInt(data.slice(3));
    s.deadline = days < 0 ? null : offsetDate(days);
    askReminder(chatId);
    s.step = 'reminder';

  // Нагадування
  } else if (data.startsWith('rm_')) {
    const s = conv[uid]; if (!s) return;
    s.reminderMinutes = data === 'rm_none' ? null : parseInt(data.slice(3));
    s.step = 'confirm';
    showConfirm(chatId, s);

  // Підтвердження задачі
  } else if (data === 'confirm_task') {
    const s = conv[uid]; if (!s) return;
    const taskId = db.createTask({
      employeeId:  s.employeeId,
      managerId:   uid,
      title:       s.title,
      description: s.description,
      checkpoints: s.checkpoints,
      deadline:    s.deadline,
    });
    if (s.reminderMinutes) db.addReminder(taskId, s.reminderMinutes);
    delete conv[uid];
    bot.sendMessage(chatId, `✅ Задача *#${taskId}* створена і відправлена!`, { parse_mode: 'Markdown' });
    notifyEmployee(taskId);
    // Якщо директор ставить задачу — повідомити керівника відділу
    if (u?.role === 'director') notifyManagerAboutTask(taskId);
    if (u?.role === 'director') menuDirector(chatId);
    else menuManager(chatId);

  // Перегляд задач
  } else if (data === 'view_tasks') {
    showAllTasks(chatId, uid);

  // Статистика
  } else if (data === 'today_stats') {
    showStats(chatId, uid);

  // Мій персонал
  } else if (data === 'my_staff') {
    showMyStaff(chatId, uid);

  // Додати підлеглого (тільки manager)
  } else if (data === 'add_staff') {
    showAddStaff(chatId, uid);

  // Призначити підлеглого менеджеру
  } else if (data.startsWith('assign_')) {
    const employeeId = parseInt(data.slice(7));
    db.assignStaff(employeeId, uid);
    const emp = db.getUser(employeeId);
    bot.sendMessage(chatId, `✅ *${emp.username}* додано до твого відділу!`, { parse_mode: 'Markdown' });
    showMyStaff(chatId, uid);

  // Скасувати
  } else if (data === 'cancel') {
    delete conv[uid];
    bot.sendMessage(chatId, '❌ Скасовано.');
    if (u?.role === 'director') menuDirector(chatId);
    else if (u?.role === 'manager') menuManager(chatId);

  // Назад в меню
  } else if (data === 'back_menu') {
    if (u?.role === 'director') menuDirector(chatId);
    else if (u?.role === 'manager') menuManager(chatId);

  // Виконати задачу
  } else if (data.startsWith('finish_')) {
    const taskId = parseInt(data.slice(7));
    const task   = db.getTask(taskId);
    if (!task || task.employee_id !== uid) return;
    conv[uid] = { step: 'done_comment', taskId };
    bot.sendMessage(chatId, '💬 Напиши короткий коментар по виконанню:');
  }
});

// ─── Меню директора ───────────────────────────────────────────────────────────
function menuDirector(chatId, name) {
  const greeting = name ? `👋 Привіт, *${name}*!\n\n` : '';
  bot.sendMessage(chatId, `${greeting}👔 *Панель комерційного директора*`, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '➕ Нова задача',      callback_data: 'new_task'    }],
        [{ text: '📋 Всі мої задачі',   callback_data: 'view_tasks'  }],
        [{ text: '📊 Статистика',       callback_data: 'today_stats' }],
        [{ text: '👥 Персонал',         callback_data: 'my_staff'    }],
      ]
    }
  });
}

// ─── Меню менеджера ───────────────────────────────────────────────────────────
function menuManager(chatId, name) {
  const greeting = name ? `👋 Привіт, *${name}*!\n\n` : '';
  bot.sendMessage(chatId, `${greeting}👨‍💼 *Панель керівника відділу*`, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [{ text: '➕ Нова задача',      callback_data: 'new_task'    }],
        [{ text: '📋 Всі мої задачі',   callback_data: 'view_tasks'  }],
        [{ text: '📊 Статистика',       callback_data: 'today_stats' }],
        [{ text: '👥 Мій відділ',       callback_data: 'my_staff'    }],
        [{ text: '➕ Додати підлеглого', callback_data: 'add_staff'   }],
      ]
    }
  });
}

// ─── Вибір співробітника для задачі ──────────────────────────────────────────
function showEmployeeSelector(chatId, uid) {
  const u = db.getUser(uid);
  let employees = [];

  if (u.role === 'director') {
    // Директор бачить всіх: менеджерів і співробітників
    const managers = db.getManagers();
    const emps = db.getEmployees();
    employees = [...managers, ...emps];
  } else if (u.role === 'manager') {
    // Менеджер бачить тільки своїх підлеглих
    employees = db.getStaffOf(uid);
  }

  if (!employees.length) {
    const msg = u.role === 'manager'
      ? '⚠️ У тебе немає підлеглих.\nДодай їх через "Додати підлеглого".'
      : '⚠️ Немає зареєстрованих співробітників.';
    bot.sendMessage(chatId, msg);
    return;
  }

  const rows = employees.map(e => [{
    text: `${e.role === 'manager' ? '👨‍💼' : '👤'} ${e.username}`,
    callback_data: `emp_${e.user_id}`
  }]);
  rows.push([{ text: '❌ Скасувати', callback_data: 'cancel' }]);
  bot.sendMessage(chatId, '👥 Вибери виконавця:', { reply_markup: { inline_keyboard: rows } });
}

// ─── Показати персонал ────────────────────────────────────────────────────────
function showMyStaff(chatId, uid) {
  const u = db.getUser(uid);

  if (u.role === 'director') {
    // Директор бачить всіх менеджерів і їх підлеглих
    const managers = db.getManagers();
    if (!managers.length) {
      bot.sendMessage(chatId, '📭 Немає керівників відділів.');
      return;
    }
    let text = '👥 *Структура компанії:*\n\n';
    managers.forEach(m => {
      text += `👨‍💼 *${m.username}*\n`;
      const staff = db.getStaffOf(m.user_id);
      if (staff.length) {
        staff.forEach(s => { text += `   └ 👤 ${s.username}\n`; });
      } else {
        text += `   └ _немає підлеглих_\n`;
      }
      text += '\n';
    });
    // Незакріплені співробітники
    const unassigned = db.getUnassignedEmployees();
    if (unassigned.length) {
      text += `❓ *Без відділу:*\n`;
      unassigned.forEach(s => { text += `   • ${s.username}\n`; });
    }
    bot.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '↩️ Назад', callback_data: 'back_menu' }]] }
    });

  } else if (u.role === 'manager') {
    const staff = db.getStaffOf(uid);
    if (!staff.length) {
      bot.sendMessage(chatId, '📭 У тебе поки немає підлеглих.\nДодай їх через "Додати підлеглого".', {
        reply_markup: { inline_keyboard: [[{ text: '↩️ Назад', callback_data: 'back_menu' }]] }
      });
      return;
    }
    let text = '👥 *Твій відділ:*\n\n';
    staff.forEach(s => { text += `👤 ${s.username}\n`; });
    bot.sendMessage(chatId, text, {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '↩️ Назад', callback_data: 'back_menu' }]] }
    });
  }
}

// ─── Додати підлеглого ────────────────────────────────────────────────────────
function showAddStaff(chatId, managerId) {
  const unassigned = db.getUnassignedEmployees();
  if (!unassigned.length) {
    bot.sendMessage(chatId,
      '📭 Немає вільних співробітників.\n\nВсі зареєстровані вже закріплені за відділами, або ще ніхто не писав /start боту.',
      { reply_markup: { inline_keyboard: [[{ text: '↩️ Назад', callback_data: 'back_menu' }]] } }
    );
    return;
  }
  const rows = unassigned.map(e => [{
    text: `👤 ${e.username}`,
    callback_data: `assign_${e.user_id}`
  }]);
  rows.push([{ text: '↩️ Назад', callback_data: 'back_menu' }]);
  bot.sendMessage(chatId, '👤 Вибери співробітника для додавання до твого відділу:', {
    reply_markup: { inline_keyboard: rows }
  });
}

// ─── Допоміжні функції ────────────────────────────────────────────────────────
function askCheckpoints(chatId) {
  bot.sendMessage(chatId,
    '✅ Введи *чек-поінти* — кожен з нового рядка:\n\n_Приклад:_\n`Зателефонувати клієнту\nПідготувати КП\nВідправити на узгодження`',
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '⏭ Без чек-поінтів', callback_data: 'skip_checkpoints' }]] }
    }
  );
}

function askDeadline(chatId) {
  bot.sendMessage(chatId, '📅 Встанови дедлайн:', {
    reply_markup: {
      inline_keyboard: [
        [{ text: '🔥 Сьогодні', callback_data: 'dl_0' }, { text: '📆 Завтра', callback_data: 'dl_1' }],
        [{ text: '📅 3 дні',    callback_data: 'dl_3' }, { text: '📅 7 днів', callback_data: 'dl_7' }],
        [{ text: '♾ Без дедлайну', callback_data: 'dl_-1' }],
      ]
    }
  });
}

function askReminder(chatId) {
  bot.sendMessage(chatId, '⏰ Нагадати якщо задача не виконана?', {
    reply_markup: {
      inline_keyboard: [
        [{ text: '⚡ Через 1 год', callback_data: 'rm_60'  }, { text: '🕐 Через 2 год', callback_data: 'rm_120' }],
        [{ text: '🕓 Через 4 год', callback_data: 'rm_240' }, { text: '🌅 Через 8 год', callback_data: 'rm_480' }],
        [{ text: '🔕 Без нагадування', callback_data: 'rm_none' }],
      ]
    }
  });
}

function showConfirm(chatId, s) {
  const emp    = db.getUser(s.employeeId);
  const cpText = s.checkpoints
    ? '\n' + s.checkpoints.split('\n').filter(Boolean).map((c,i) => `  ${i+1}. ${c}`).join('\n')
    : ' —';
  const dlText = s.deadline        ? `📅 *${s.deadline}*`                     : 'без дедлайну';
  const rmText = s.reminderMinutes ? `⏰ через *${fmtMin(s.reminderMinutes)}*` : 'без нагадування';

  bot.sendMessage(chatId,
    `📋 *Підтвердь задачу:*\n\n` +
    `👤 Виконавець: *${emp?.username}*\n` +
    `📌 Назва: *${s.title}*\n` +
    `📄 Опис: ${s.description || '—'}\n` +
    `✅ Чек-поінти:${cpText}\n\n` +
    `${dlText} | ${rmText}`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Створити',   callback_data: 'confirm_task' },
          { text: '❌ Скасувати', callback_data: 'cancel'       },
        ]]
      }
    }
  );
}

function notifyEmployee(taskId) {
  const task = db.getTaskFull(taskId);
  if (!task?.employee) return;
  const cpLines = task.cpList.length
    ? '\n\n*Чек-поінти:*\n' + task.cpList.map((c,i) => `${i+1}. ${c}`).join('\n')
    : '';
  const dlLine = task.deadline ? `\n📅 Дедлайн: *${task.deadline}*` : '';

  bot.sendMessage(task.employee.chat_id,
    `📬 *Нова задача від ${task.manager.username}!*\n\n` +
    `📌 *${task.title}*` +
    `${task.description ? '\n📄 ' + task.description : ''}` +
    `${cpLines}${dlLine}\n\nКоли виконаєш — натисни кнопку:`,
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '✅ Виконано!', callback_data: `finish_${task.id}` }]] }
    }
  );
}

// Повідомити керівника відділу що директор поставив задачу його підлеглому
function notifyManagerAboutTask(taskId) {
  const task = db.getTaskFull(taskId);
  if (!task?.employee) return;
  const mgr = db.getManagerOf(task.employee_id);
  if (!mgr) return;
  // Не повідомляємо якщо задача поставлена самому менеджеру
  if (mgr.user_id === task.employee_id) return;

  bot.sendMessage(mgr.chat_id,
    `ℹ️ *Директор поставив задачу твоєму підлеглому*\n\n` +
    `👤 Виконавець: *${task.employee.username}*\n` +
    `📌 *${task.title}*` +
    `${task.deadline ? `\n📅 Дедлайн: *${task.deadline}*` : ''}`,
    { parse_mode: 'Markdown' }
  );
}

function notifyManagerDone(task, comment) {
  if (!task?.manager) return;
  const cpLines = task.cpList.length
    ? '\n\n*Чек-поінти:*\n' + task.cpList.map(c => `☑️ ${c}`).join('\n')
    : '';
  bot.sendMessage(task.manager.chat_id,
    `✅ *${task.employee.username}* виконав задачу!\n\n` +
    `📌 *${task.title}*${cpLines}\n\n` +
    `💬 Коментар:\n_${comment}_`,
    { parse_mode: 'Markdown' }
  );

  // Якщо задачу ставив директор — також повідомити керівника відділу про виконання
  const assigner = db.getUser(task.manager_id);
  if (assigner?.role === 'director') {
    const mgr = db.getManagerOf(task.employee_id);
    if (mgr && mgr.chat_id !== task.manager.chat_id) {
      bot.sendMessage(mgr.chat_id,
        `✅ *${task.employee.username}* виконав задачу директора!\n\n` +
        `📌 *${task.title}*\n💬 _${comment}_`,
        { parse_mode: 'Markdown' }
      );
    }
  }
}

function showAllTasks(chatId, managerId) {
  const { allTasks } = db.getManagerStats(managerId);
  if (!allTasks.length) { bot.sendMessage(chatId, '📭 Задач поки немає.'); return; }
  const icon = { pending: '🕐', done: '✅' };
  let text = '*📋 Всі твої задачі:*\n\n';
  allTasks.forEach(t => {
    text += `${icon[t.status] || '🕐'} *#${t.id}* ${t.title}\n`;
    text += `   👤 ${t.emp_name} | 📅 ${t.deadline || 'без дедлайну'}\n`;
    if (t.status === 'done' && t.done_comment) text += `   💬 _${t.done_comment}_\n`;
    text += '\n';
  });
  bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[{ text: '↩️ Назад', callback_data: 'back_menu' }]] }
  });
}

function showStats(chatId, managerId) {
  const { todayTasks, overdueTasks } = db.getManagerStats(managerId);
  const date = new Date().toLocaleDateString('uk-UA');
  const done = todayTasks.filter(t => t.status === 'done').length;
  const pend = todayTasks.filter(t => t.status === 'pending').length;

  let text = `📊 *Статистика на ${date}*\n\n`;
  text += `✅ Виконано сьогодні: *${done}* з ${todayTasks.length}\n`;
  text += `🕐 В процесі: *${pend}*\n`;
  if (overdueTasks.length) text += `⚠️ Прострочено: *${overdueTasks.length}*\n`;

  if (todayTasks.length) {
    text += '\n*Задачі сьогодні:*\n';
    todayTasks.forEach(t => {
      text += `${t.status === 'done' ? '✅' : '🕐'} ${t.title} — ${t.emp_name}\n`;
      if (t.done_comment) text += `   💬 _${t.done_comment}_\n`;
    });
  }
  if (overdueTasks.length) {
    text += '\n*⚠️ Прострочені:*\n';
    overdueTasks.forEach(t => { text += `• ${t.title} — ${t.emp_name} (${t.deadline})\n`; });
  }

  bot.sendMessage(chatId, text, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: [[{ text: '↩️ Назад', callback_data: 'back_menu' }]] }
  });
}

function showMyTasks(chatId, userId) {
  const tasks = db.getEmployeeActiveTasks(userId);
  if (!tasks.length) { bot.sendMessage(chatId, '✅ Немає активних задач!'); return; }
  for (const t of tasks) {
    const full = db.getTaskFull(t.id);
    const cpLines = full.cpList.length
      ? '\n\n*Чек-поінти:*\n' + full.cpList.map((c,i) => `${i+1}. ${c}`).join('\n')
      : '';
    bot.sendMessage(chatId,
      `📌 *#${t.id} ${t.title}*\n👤 Від: *${full.manager?.username}*\n📅 ${t.deadline || 'без дедлайну'}${cpLines}`,
      {
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: '✅ Виконано!', callback_data: `finish_${t.id}` }]] }
      }
    );
  }
}

function sendReminder(taskId, employeeChatId, title) {
  bot.sendMessage(employeeChatId,
    `⏰ *Нагадування!*\n\nУ тебе є невиконана задача:\n📌 *${title}*`,
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '✅ Виконано!', callback_data: `finish_${taskId}` }]] }
    }
  );
}

function offsetDate(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

function fmtMin(m) { return m < 60 ? `${m} хв` : `${m/60} год`; }

db.init();
startSchedulers(bot, db, showStats, sendReminder);
console.log('🤖 TaskBot запущено!');