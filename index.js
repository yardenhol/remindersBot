const TelegramBot = require('node-telegram-bot-api');
const express = require('express');

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('Error: TELEGRAM_BOT_TOKEN is not set!');
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });
const app = express();

const userState = {};

// Express server to keep Railway happy
app.get('/', (req, res) => res.send('Bot is alive!'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on port ${PORT}`));

// Telegram Bot Logic

bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!userState[chatId]) {
    userState[chatId] = { step: 'awaiting_task' };
    bot.sendMessage(chatId, 'Hi! What do you want to be reminded about?');
    return;
  }

  const state = userState[chatId];

  if (state.step === 'awaiting_task') {
    state.task = text;
    state.step = 'awaiting_time';

    bot.sendMessage(chatId, 'When should I remind you?', {
      reply_markup: {
        inline_keyboard: [
          [
            { text: '⏰ 1 hour', callback_data: '1h' },
            { text: '⏳ 3 hours', callback_data: '3h' },
          ],
          [
            { text: '🌅 Tomorrow at 9AM', callback_data: 'tomorrow' },
            { text: '📅 Enter custom time', callback_data: 'custom' },
          ],
        ],
      },
    });
    return;
  }

  if (state.step === 'custom_time') {
    const inputTime = new Date(text.replace(' ', 'T'));
    if (isNaN(inputTime)) {
      bot.sendMessage(chatId, '❌ Invalid date/time format. Please use YYYY-MM-DD HH:MM');
      return;
    }
    scheduleReminder(chatId, state.task, inputTime);
    bot.sendMessage(chatId, `✅ Reminder set for ${inputTime.toLocaleString()}`);
    delete userState[chatId];
  }
});

// Handle inline button callbacks
bot.on('callback_query', (query) => {
  const chatId = query.message.chat.id;
  const state = userState[chatId];
  const now = new Date();
  let remindAt;

  switch (query.data) {
    case '1h':
      remindAt = new Date(now.getTime() + 60 * 60 * 1000);
      break;
    case '3h':
      remindAt = new Date(now.getTime() + 3 * 60 * 60 * 1000);
      break;
    case 'tomorrow':
      remindAt = new Date();
      remindAt.setDate(now.getDate() + 1);
      remindAt.setHours(9, 0, 0, 0);
      break;
    case 'custom':
      bot.sendMessage(chatId, 'Please enter a date & time (YYYY-MM-DD HH:MM)');
      state.step = 'custom_time';
      bot.answerCallbackQuery(query.id);
      return;
    default:
      bot.answerCallbackQuery(query.id, { text: 'Unknown option' });
      return;
  }

  scheduleReminder(chatId, state.task, remindAt);
  bot.sendMessage(chatId, `✅ Reminder set for ${remindAt.toLocaleString()}`);
  delete userState[chatId];
  bot.answerCallbackQuery(query.id);
});

// Schedule a reminder message
function scheduleReminder(chatId, task, date) {
  const delay = date.getTime() - Date.now();
  if (delay <= 0) {
    bot.sendMessage(chatId, '❌ That time is in the past!');
    return;
  }

  setTimeout(() => {
    bot.sendMessage(chatId, `🔔 Reminder: ${task}`);
  }, delay);
}
