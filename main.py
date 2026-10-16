import os
import random
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import Application, CommandHandler, CallbackQueryHandler, ContextTypes, MessageHandler, filters

BOT_TOKEN = "8857400952:AAEmmPsB9Cnm1isfPZcIIsI0Vs3JuoGLiwM"

RIDDLES = [
    {"q": "What has to be broken before you can use it?", "a": "egg"},
    {"q": "I speak without a mouth, what am I?", "a": "echo"},
    {"q": "What gets wetter as it dries?", "a": "towel"},
    {"q": "What has keys but no locks?", "a": "keyboard"},
]
TRIVIA = [
    {"q": "Capital of Nigeria?", "options": ["Lagos", "Abuja", "Kano"], "ans": "Abuja"},
    {"q": "Who is Wizkid?", "options": ["Singer", "Footballer", "President"], "ans": "Singer"},
    {"q": "How many states in Nigeria?", "options": ["36", "30", "40"], "ans": "36"},
]
UNSCRAMBLE_WORDS = ["NIGERIA", "LAGOS", "ZADDY", "ABUJA", "TELEGRAM", "LUDO", "FOOTBALL"]

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    keyboard = [
        [InlineKeyboardButton("🎲 Dice", callback_data="dice"), InlineKeyboardButton("🧩 Riddle", callback_data="riddle")],
        [InlineKeyboardButton("🧠 Trivia", callback_data="trivia"), InlineKeyboardButton("❓ Quiz", callback_data="quiz")],
        [InlineKeyboardButton("🔤 Unscramble", callback_data="unscramble"), InlineKeyboardButton("🏷️ Logo", callback_data="logo")],
    ]
    await update.message.reply_text("Welcome to @Zaddyzbot 🎮\nChoose game:", reply_markup=InlineKeyboardMarkup(keyboard))

async def games_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("🎮 GAMES:\n/dice\n/riddle\n/trivia\n/quiz\n/unscramble\n/logo\n/ludo\n/wordgrid")

async def dice_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_dice(emoji="🎲")

async def riddle_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    r = random.choice(RIDDLES)
    context.user_data['riddle_ans'] = r['a']
    await update.message.reply_text(f"🧩 RIDDLE:\n\n{r['q']}\n\nReply with your answer!")

async def trivia_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    q = random.choice(TRIVIA)
    keyboard = [[InlineKeyboardButton(opt, callback_data=f"triv_{opt}_{q['ans']}")] for opt in q['options']]
    await update.message.reply_text(f"🧠 TRIVIA:\n\n{q['q']}", reply_markup=InlineKeyboardMarkup(keyboard))

async def quiz_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await trivia_command(update, context)

async def unscramble_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    word = random.choice(UNSCRAMBLE_WORDS)
    scrambled = ''.join(random.sample(word, len(word)))
    context.user_data['unscramble_ans'] = word
    await update.message.reply_text(f"🔤 UNSCRAMBLE:\n\n{scrambled}")

async def logo_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("🏷️ GUESS THE LOGO:\nReply MTN, GLO, AIRTEL?")

async def ludo_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("🎮 LUDO coming soon!")

async def wordgrid_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text("🔠 WORD GRID coming soon!")

async def button_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    query = update.callback_query
    await query.answer()
    data = query.data
    if data == "dice":
        await query.message.reply_dice(emoji="🎲")
    elif data == "riddle":
        r = random.choice(RIDDLES)
        context.user_data['riddle_ans'] = r['a']
        await query.message.reply_text(f"🧩 RIDDLE:\n\n{r['q']}")
    elif data == "trivia" or data == "quiz":
        q = random.choice(TRIVIA)
        keyboard = [[InlineKeyboardButton(opt, callback_data=f"triv_{opt}_{q['ans']}")] for opt in q['options']]
        await query.message.reply_text(f"🧠 TRIVIA:\n\n{q['q']}", reply_markup=InlineKeyboardMarkup(keyboard))
    elif data.startswith("triv_"):
        parts = data.split("_", 2)
        chosen = parts[1]
        correct = parts[2]
        if chosen == correct:
            await query.edit_message_text(f"✅ Correct! Na {correct}")
        else:
            await query.edit_message_text(f"❌ Wrong! Correct na {correct}")

async def text_handler(update: Update, context: ContextTypes.DEFAULT_TYPE):
    text = update.message.text.lower().strip()
    if 'riddle_ans' in context.user_data and text == context.user_data['riddle_ans']:
        await update.message.reply_text("✅ You sabi! Correct!")
        del context.user_data['riddle_ans']
    if 'unscramble_ans' in context.user_data and text == context.user_data['unscramble_ans'].lower():
        await update.message.reply_text(f"✅ Correct! Na {context.user_data['unscramble_ans']}")
        del context.user_data['unscramble_ans']

def main():
    app = Application.builder().token(BOT_TOKEN).build()
    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("games", games_command))
    app.add_handler(CommandHandler("dice", dice_command))
    app.add_handler(CommandHandler("riddle", riddle_command))
    app.add_handler(CommandHandler("trivia", trivia_command))
    app.add_handler(CommandHandler("quiz", quiz_command))
    app.add_handler(CommandHandler("unscramble", unscramble_command))
    app.add_handler(CommandHandler("logo", logo_command))
    app.add_handler(CommandHandler("ludo", ludo_command))
    app.add_handler(CommandHandler("wordgrid", wordgrid_command))
    app.add_handler(CallbackQueryHandler(button_handler))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, text_handler))
    print("Zaddyzbot running...")
    app.run_polling()

if __name__ == "__main__":
    main()
