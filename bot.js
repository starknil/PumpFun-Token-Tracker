require('dotenv').config();
const { Telegraf } = require('telegraf');

const bot = new Telegraf(process.env.BOT_TOKEN);


const sendMessage = async (t, message) => {
  const _to = t === 'channel' ? process.env.CHANNEL_ID : t === 'group' ? process.env.GROUP_ID : null;
  if (!_to) return;
  try {
    await bot.telegram.sendMessage(_to, message, { parse_mode: 'HTML', disable_web_page_preview: true });
  } catch (error) {
    console.error('Error sending message:', error.response?.description);
  };
};

//bot.use(ctx => ctx.reply(JSON.stringify(ctx.chat)));


bot.launch();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
module.exports = { sendMessage };