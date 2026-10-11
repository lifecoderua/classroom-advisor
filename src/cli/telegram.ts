import type { Command } from "commander";
import { type Config, loadConfig } from "../config/index.ts";
import { addTelegramChat } from "../config/local.ts";
import { chatLabel, chatsOf, HELP_TEXT, TelegramApi, type TgChat } from "../notify/telegram.ts";

function api(config: Config): TelegramApi {
  if (!config.telegramBotToken) {
    throw new Error("TELEGRAM_BOT_TOKEN is not set (put it in .env or the environment)");
  }
  return new TelegramApi(config.telegramBotToken);
}

/** Picks the chat to link: `--chat` (must have messaged the bot), else the only one seen. */
export function pickChat(chats: readonly TgChat[], wanted?: string): TgChat {
  if (wanted !== undefined) {
    const chat = chats.find((c) => String(c.id) === wanted.trim());
    if (!chat) throw new Error(`chat ${wanted} hasn't messaged the bot (see the list above)`);
    return chat;
  }
  const [only] = chats;
  if (chats.length === 1 && only) return only;
  throw new Error("several chats messaged the bot: pick one with --chat <id>");
}

/** Adds `telegram link` and `telegram test` to the CLI. */
export function registerTelegramCommands(program: Command): void {
  const telegram = program.command("telegram").description("Telegram bot notifier");

  telegram
    .command("link")
    .description("Find the chats that sent /start to the bot and save one to config.local.json")
    .option("--chat <id>", "chat id to save when several chats messaged the bot")
    .action(async (opts: { chat?: string }) => {
      const config = loadConfig();
      const bot = api(config);
      const me = await bot.getMe();
      const name = me.username ? `@${me.username}` : me.first_name;
      // No offset: reading doesn't confirm the updates, so `run` still sees them.
      const chats = chatsOf(await bot.getUpdates({ timeout: 0 }));
      if (chats.length === 0) {
        console.log(`Bot ${name}: no messages yet.`);
        console.log(
          `Open https://t.me/${me.username ?? "<bot>"} in Telegram, send /start, then run this again.`,
        );
        console.log("(Stop a running `run` first: it consumes the updates.)");
        process.exitCode = 1;
        return;
      }
      console.log(`Bot ${name}: chats that messaged it:`);
      for (const c of chats)
        console.log(`  ${String(c.id).padEnd(16)} ${c.type.padEnd(10)} ${chatLabel(c)}`);
      const chat = pickChat(chats, opts.chat);
      const { changed, chatIds } = addTelegramChat(process.cwd(), String(chat.id));
      console.log(
        changed
          ? `Saved chat ${chat.id} to config.local.json (${chatIds.length} chat(s) linked).`
          : `Chat ${chat.id} was already linked.`,
      );
      if (process.env.CA_TELEGRAM_CHAT_IDS) {
        console.log("Note: CA_TELEGRAM_CHAT_IDS is set and overrides config.local.json.");
      }
      console.log("Next: pnpm cli telegram test");
    });

  telegram
    .command("test")
    .description("Send a test message to every linked chat")
    .action(async () => {
      const config = loadConfig();
      const bot = api(config);
      if (config.telegramChatIds.length === 0) {
        throw new Error("no chat linked: message the bot, then run `telegram link`");
      }
      const text = `✅ Test message: Telegram works.\n\n${HELP_TEXT}`;
      for (const chatId of config.telegramChatIds) {
        try {
          await bot.sendMessage(chatId, text);
          console.log(`ok    ${chatId}`);
        } catch (err) {
          console.log(`FAIL  ${chatId}  ${(err as Error).message}`);
          process.exitCode = 1;
        }
      }
    });
}
