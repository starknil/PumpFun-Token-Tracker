require('dotenv').config();
const { Telegraf } = require('telegraf');

const bot = new Telegraf(process.env.BOT_TOKEN);


const sendMessage = async (message) => {
  try {
    await bot.telegram.sendMessage(`@${process.env.CHAT_ID}`, message, { parse_mode: 'HTML', disable_web_page_preview: true });
  } catch (error) {
    console.error('Error sending message:', error.response?.description);
  };
};


bot.launch();
module.exports = { sendMessage };