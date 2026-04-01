function startSchedulers(bot, db, showStats, sendReminder) {
  _startDailyReport(db, showStats);
  _startReminderChecker(db, sendReminder);
  _startOverdueChecker(bot, db);
}

function _startDailyReport(db, showStats) {
  const HOUR   = parseInt(process.env.REPORT_HOUR   || '18');
  const MINUTE = parseInt(process.env.REPORT_MINUTE || '0');
  function scheduleNext() {
    const now  = new Date();
    const next = new Date();
    next.setHours(HOUR, MINUTE, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    const delay = next - now;
    console.log(`📅 Авто-звіт о ${HOUR}:${String(MINUTE).padStart(2,'0')} (через ${Math.round(delay/60000)} хв)`);
    setTimeout(async () => {
      const managers = await db.getManagers();
      managers.forEach(m => {
        try { showStats(m.chat_id, m.user_id); } catch(e) { console.error(e.message); }
      });
      scheduleNext();
    }, delay);
  }
  scheduleNext();
}

function _startReminderChecker(db, sendReminder) {
  setInterval(async () => {
    try {
      const reminders = await db.getDueReminders();
      for (const r of reminders) {
        const emp = await db.getUser(r.employee_id);
        if (!emp) continue;
        sendReminder(r.task_id, emp.chat_id, r.title);
        await db.markReminderSent(r.id);
        console.log(`⏰ Нагадування → задача #${r.task_id} → ${emp.username}`);
      }
    } catch(e) { console.error('Reminder error:', e.message); }
  }, 60_000);
  console.log('⏰ Планувальник нагадувань запущено');
}

function _startOverdueChecker(bot, db) {
  const HOUR   = parseInt(process.env.OVERDUE_HOUR   || '9');
  const MINUTE = parseInt(process.env.OVERDUE_MINUTE || '0');
  function scheduleNext() {
    const now  = new Date();
    const next = new Date();
    next.setHours(HOUR, MINUTE, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    setTimeout(async () => {
      try {
        const managers = await db.getManagers();
        for (const m of managers) {
          const { overdueTasks } = await db.getManagerStats(m.user_id);
          const byEmp = {};
          overdueTasks.forEach(t => {
            if (!byEmp[t.employee_id]) byEmp[t.employee_id] = [];
            byEmp[t.employee_id].push(t);
          });
          for (const [empId, tasks] of Object.entries(byEmp)) {
            const emp = await db.getUser(parseInt(empId));
            if (!emp) continue;
            const list = tasks.map(t => `• *${t.title}* (дедлайн: ${t.deadline})`).join('\n');
            bot.sendMessage(emp.chat_id,
              `⚠️ *Прострочені задачі:*\n\n${list}\n\nБудь ласка, виконай або повідом керівника!`,
              { parse_mode: 'Markdown' }
            );
          }
        }
      } catch(e) { console.error(e.message); }
      scheduleNext();
    }, next - now);
  }
  scheduleNext();
  console.log(`🔔 Перевірка прострочення о ${HOUR}:${String(MINUTE).padStart(2,'0')}`);
}

module.exports = { startSchedulers };
