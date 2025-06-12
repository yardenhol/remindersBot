const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const { DateTime } = require("luxon");

const REMINDERS_FILE = "./reminders.json";

const token = process.env.TELEGRAM_BOT_TOKEN || "YOUR_TOKEN_HERE";
const bot = new TelegramBot(token, { polling: true });

const userState = {};
let reminders = {};

// --- Persistence ---

function saveReminders() {
  try {
    const cleanReminders = {};
    for (const chatId in reminders) {
      cleanReminders[chatId] = reminders[chatId].map(({ task, remindAt }) => ({
        task,
        remindAt,
      }));
    }
    fs.writeFileSync(REMINDERS_FILE, JSON.stringify(cleanReminders, null, 2));
  } catch (e) {
    console.error("Error saving reminders:", e);
  }
}

function loadReminders() {
  if (fs.existsSync(REMINDERS_FILE)) {
    try {
      const data = fs.readFileSync(REMINDERS_FILE, "utf8");
      const loaded = JSON.parse(data);
      for (const chatId in loaded) {
        loaded[chatId] = loaded[chatId].map((r) => ({
          ...r,
          remindAt: new Date(r.remindAt),
          timeoutId: null,
        }));
      }
      return loaded;
    } catch (e) {
      console.error("Error loading reminders:", e);
      return {};
    }
  }
  return {};
}

reminders = loadReminders();

function restoreAllReminders() {
  for (const chatId in reminders) {
    reminders[chatId].forEach((reminder) => {
      const delay = reminder.remindAt.getTime() - Date.now();
      if (delay > 0) {
        reminder.timeoutId = setTimeout(() => {
          bot.sendMessage(chatId, `🔔 Reminder: ${reminder.task}`);

          // After reminder, ask for done/remind later
          bot.sendMessage(chatId, `Did you complete this task?`, {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "✅ Mark as done", callback_data: `done_${reminder.task}` },
                  { text: "⏰ Remind me later", callback_data: `remind_later_${reminder.task}` },
                ],
              ],
            },
          });

          if (reminders[chatId]) {
            reminders[chatId] = reminders[chatId].filter((r) => r !== reminder);
            if (reminders[chatId].length === 0) delete reminders[chatId];
            saveReminders();
          }
        }, delay);
      } else {
        reminders[chatId] = reminders[chatId].filter((r) => r !== reminder);
        if (reminders[chatId].length === 0) delete reminders[chatId];
      }
    });
  }
  saveReminders();
}

restoreAllReminders();

// --- Helpers ---

function resetUserState(chatId) {
  userState[chatId] = { step: "awaiting_task" };
}

function scheduleReminder(chatId, task, date) {
  const delay = date.getTime() - Date.now();

  if (delay <= 0) {
    bot.sendMessage(chatId, "❌ That time is in the past!");
    return false;
  }

  const timeoutId = setTimeout(() => {
    bot.sendMessage(chatId, `🔔 Reminder: ${task}`);

    // After reminder, ask for done/remind later
    bot.sendMessage(chatId, `Did you complete this task?`, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Mark as done", callback_data: `done_${task}` },
            { text: "⏰ Remind me later", callback_data: `remind_later_${task}` },
          ],
        ],
      },
    });

    if (reminders[chatId]) {
      reminders[chatId] = reminders[chatId].filter(
        (r) => r.timeoutId !== timeoutId,
      );
      if (reminders[chatId].length === 0) delete reminders[chatId];
      saveReminders();
    }
  }, delay);

  if (!reminders[chatId]) reminders[chatId] = [];
  reminders[chatId].push({ task, remindAt: date, timeoutId });
  saveReminders();
  return true;
}

// --- Commands ---

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const welcomeMsg = `
Hi! I'm your Reminder Bot. Here's what I can do:

📌 *How to use me:*
1. Send me a task you want to be reminded about.
2. Choose when you'd like the reminder (preset options or custom time).
3. Receive the reminder when the time comes!

🛠 *Commands:*
/start - Show this welcome message
/list - Show all your pending reminders
/delete - Delete a reminder from your list
/cancel - Cancel the current reminder setup

You can also type 'cancel' anytime to stop the current setup.

Ready? Send me what you'd like to be reminded about!
  `;
  bot.sendMessage(chatId, welcomeMsg, { parse_mode: "Markdown" });
  resetUserState(chatId);
});

bot.onText(/\/list/, (msg) => {
  const chatId = msg.chat.id;
  if (!reminders[chatId] || reminders[chatId].length === 0) {
    bot.sendMessage(chatId, "You have no pending reminders.");
    return;
  }

  let listMsg = "📝 Your pending reminders:\n";
  reminders[chatId].forEach((r, idx) => {
    listMsg += `${idx + 1}. "${r.task}" at ${r.remindAt.toLocaleString()}\n`;
  });
  bot.sendMessage(chatId, listMsg);
});

bot.onText(/\/delete/, (msg) => {
  const chatId = msg.chat.id;
  if (!reminders[chatId] || reminders[chatId].length === 0) {
    bot.sendMessage(chatId, "You have no reminders to delete.");
    return;
  }

  const buttons = reminders[chatId].map((r, idx) => ({
    text: `${idx + 1}. ${r.task} at ${r.remindAt.toLocaleString()}`,
    callback_data: `delete_${idx}`,
  }));

  const keyboard = [];
  while (buttons.length) keyboard.push(buttons.splice(0, 2));

  bot.sendMessage(chatId, "Select a reminder to delete:", {
    reply_markup: { inline_keyboard: keyboard },
  });
});

// --- Main message handler ---

bot.on("message", (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  if (text.startsWith("/")) return; // commands handled above

  if (text.toLowerCase() === "cancel") {
    if (
      userState[chatId] &&
      userState[chatId].step !== "awaiting_task" &&
      userState[chatId].step !== "completed"
    ) {
      resetUserState(chatId);
      bot.sendMessage(
        chatId,
        "❌ Reminder setup canceled. Send me a new task whenever you want.",
      );
    } else {
      bot.sendMessage(chatId, "No active reminder setup to cancel.");
    }
    return;
  }

  if (!userState[chatId] || userState[chatId].step === "completed") {
    resetUserState(chatId);
  }

  const state = userState[chatId];

  // Handle unrecognized input gracefully
  if (
    state.step !== "awaiting_task" &&
    state.step !== "awaiting_time" &&
    !state.step.startsWith("custom_time")
  ) {
    bot.sendMessage(
      chatId,
      "❓ Sorry, I didn't understand that. You can type 'cancel' to abort the current reminder setup."
    );
    return;
  }

  if (state.step === "awaiting_task") {
    state.task = text;
    state.step = "awaiting_time";

    bot.sendMessage(chatId, "When should I remind you?", {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "⏰ 1 hour", callback_data: "1h" },
            { text: "⏳ 3 hours", callback_data: "3h" },
          ],
          [
            { text: "🌅 Tomorrow at 9AM", callback_data: "tomorrow" },
            { text: "📅 Enter custom time", callback_data: "custom" },
          ],
        ],
      },
    });
  } else if (state.step === "custom_choice") {
    // wait for callback_query
  } else if (state.step === "custom_time_today") {
    const timeMatch = text.match(/^(\d{1,2}):(\d{2})$/);
    if (!timeMatch) {
      bot.sendMessage(
        chatId,
        "Invalid time format. Please enter time as HH:MM (e.g., 14:30)",
      );
      return;
    }
    const hour = parseInt(timeMatch[1], 10);
    const minute = parseInt(timeMatch[2], 10);

    let dt = DateTime.now()
      .setZone("Asia/Jerusalem")
      .set({ hour, minute, second: 0, millisecond: 0 });
    if (dt < DateTime.now().setZone("Asia/Jerusalem")) {
      bot.sendMessage(
        chatId,
        "That time already passed today. Please enter a future time.",
      );
      return;
    }

    scheduleReminder(chatId, state.task, dt.toJSDate());
    bot.sendMessage(
      chatId,
      `✅ I will remind you to "${state.task}" today at ${dt.toFormat("HH:mm")}.`,
    );
    state.step = "completed";
  } else if (state.step === "custom_time_tomorrow") {
    const timeMatch = text.match(/^(\d{1,2}):(\d{2})$/);
    if (!timeMatch) {
      bot.sendMessage(
        chatId,
        "Invalid time format. Please enter time as HH:MM (e.g., 09:00)",
      );
      return;
    }
    const hour = parseInt(timeMatch[1], 10);
    const minute = parseInt(timeMatch[2], 10);

    let dt = DateTime.now()
      .setZone("Asia/Jerusalem")
      .plus({ days: 1 })
      .set({ hour, minute, second: 0, millisecond: 0 });
    scheduleReminder(chatId, state.task, dt.toJSDate());
    bot.sendMessage(
      chatId,
      `✅ I will remind you to "${state.task}" tomorrow at ${dt.toFormat("HH:mm")}.`,
    );
    state.step = "completed";
  } else if (state.step === "custom_time_full") {
    const dt = parseCustomDate(text);
    if (!dt) {
      bot.sendMessage(
        chatId,
        "Invalid date/time format. Please enter in YYYY-MM-DD HH:MM format.",
      );
      return;
    }
    scheduleReminder(chatId, state.task, dt);
    bot.sendMessage(
      chatId,
      `✅ I will remind you to "${state.task}" on ${dt.toLocaleString()}.`,
    );
    state.step = "completed";
  }
});

// --- Callback query handler ---

bot.on("callback_query", (query) => {
  const chatId = query.message.chat.id;
  const state = userState[chatId];
  const data = query.data;

  // Handle deletion requests
  if (data.startsWith("delete_")) {
    if (!reminders[chatId] || reminders[chatId].length === 0) {
      bot.answerCallbackQuery(query.id, { text: "No reminders to delete." });
      return;
    }

    const idx = parseInt(data.split("_")[1], 10);
    if (isNaN(idx) || idx < 0 || idx >= reminders[chatId].length) {
      bot.answerCallbackQuery(query.id, { text: "Invalid selection." });
      return;
    }

    clearTimeout(reminders[chatId][idx].timeoutId);
    const removed = reminders[chatId].splice(idx, 1)[0];
    saveReminders();

    bot.answerCallbackQuery(query.id, {
      text: `Deleted reminder: "${removed.task}"`,
    });
    bot.sendMessage(chatId, `🗑️ Deleted reminder: "${removed.task}"`);
    return;
  }

  // Handle done/remind later buttons after reminder
  if (data.startsWith("done_")) {
    const task = data.slice(5);

    bot.answerCallbackQuery(query.id, { text: `Marked "${task}" as done.` });
    bot.sendMessage(chatId, `✅ Great! Task "${task}" marked as done.`);
    return;
  }

  if (data.startsWith("remind_later_")) {
    const task = data.slice(13);

    bot.answerCallbackQuery(query.id, { text: `Let's reschedule the reminder for "${task}".` });
    userState[chatId] = { step: "awaiting_time", task };
    bot.sendMessage(chatId, `When should I remind you again for "${task}"?`, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "⏰ 1 hour", callback_data: "1h" },
            { text: "⏳ 3 hours", callback_data: "3h" },
          ],
          [
            { text: "🌅 Tomorrow at 9AM", callback_data: "tomorrow" },
            { text: "📅 Enter custom time", callback_data: "custom" },
          ],
        ],
      },
    });
    return;
  }

  // If no active task
  if (
    !state ||
    (state.step !== "awaiting_time" && state.step !== "custom_choice")
  ) {
    bot.answerCallbackQuery(query.id, { text: "Please send me a task first." });
    return;
  }

  // Handle reminder time selection
  switch (data) {
    case "1h": {
      const remindAt = DateTime.now()
        .setZone("Asia/Jerusalem")
        .plus({ hours: 1 })
        .toJSDate();
      scheduleReminder(chatId, state.task, remindAt);
      bot.sendMessage(
        chatId,
        `✅ I will remind you to "${state.task}" in 1 hour.`,
      );
      state.step = "completed";
      bot.answerCallbackQuery(query.id);
      break;
    }
    case "3h": {
      const remindAt = DateTime.now()
        .setZone("Asia/Jerusalem")
        .plus({ hours: 3 })
        .toJSDate();
      scheduleReminder(chatId, state.task, remindAt);
      bot.sendMessage(
        chatId,
        `✅ I will remind you to "${state.task}" in 3 hours.`,
      );
      state.step = "completed";
      bot.answerCallbackQuery(query.id);
      break;
    }
    case "tomorrow": {
      const remindAt = DateTime.now()
        .setZone("Asia/Jerusalem")
        .plus({ days: 1 })
        .set({ hour: 9, minute: 0, second: 0, millisecond: 0 })
        .toJSDate();
      scheduleReminder(chatId, state.task, remindAt);
      bot.sendMessage(
        chatId,
        `✅ I will remind you to "${state.task}" tomorrow at 9:00.`,
      );
      state.step = "completed";
      bot.answerCallbackQuery(query.id);
      break;
    }
    case "custom":
      bot.sendMessage(chatId, "Choose custom time type:", {
        reply_markup: {
          inline_keyboard: [
            [{ text: "Today at HH:MM", callback_data: "custom_today" }],
            [{ text: "Tomorrow at HH:MM", callback_data: "custom_tomorrow" }],
            [{ text: "Enter full date & time", callback_data: "custom_full" }],
          ],
        },
      });
      state.step = "custom_choice";
      bot.answerCallbackQuery(query.id);
      break;

    case "custom_today":
      bot.sendMessage(
        chatId,
        "Please enter the time for *today* in HH:MM format:",
        { parse_mode: "Markdown" },
      );
      state.step = "custom_time_today";
      bot.answerCallbackQuery(query.id);
      break;

    case "custom_tomorrow":
      bot.sendMessage(
        chatId,
        "Please enter the time for *tomorrow* in HH:MM format:",
        { parse_mode: "Markdown" },
      );
      state.step = "custom_time_tomorrow";
      bot.answerCallbackQuery(query.id);
      break;

    case "custom_full":
      bot.sendMessage(
        chatId,
        "Please enter the full date and time in YYYY-MM-DD HH:MM format:",
      );
      state.step = "custom_time_full";
      bot.answerCallbackQuery(query.id);
      break;

    default:
      bot.answerCallbackQuery(query.id, { text: "Unknown option." });
  }
});

// --- Error handler ---

bot.on("polling_error", (error) => {
  if (error.code === "ETELEGRAM" && error.message.includes("409 Conflict")) {
    console.warn("Warning: Multiple bot instances detected or stale session.");
  } else {
    console.error("Polling error:", error);
  }
});

// Helper: parse full custom date input (YYYY-MM-DD HH:MM)
function parseCustomDate(input) {
  input = input.trim();

  // ISO format YYYY-MM-DD HH:MM
  const isoMatch = input.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})$/);
  if (isoMatch) {
    let dt = DateTime.fromISO(
      `${isoMatch[1]}T${isoMatch[2].padStart(2, "0")}:${isoMatch[3]}`,
      { zone: "Asia/Jerusalem" },
    );
    if (dt.isValid) return dt.toJSDate();
  }
  return null;
}
