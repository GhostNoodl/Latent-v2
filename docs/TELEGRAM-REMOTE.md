# 📱 Telegram remote

Make images from your phone! Latent can connect to your own Telegram bot, so you can send it a prompt from anywhere and get the finished picture back in the chat. Everything still runs on your PC; Telegram is just the remote control.

It's off until you turn it on, and only the people you list can use it.

## What you'll need

- Latent **0.2.3 or newer**, set up and able to make images in **Create**.
- The Telegram app on your phone (or Telegram on the web or desktop).
- Your PC turned on with Latent open. The bot only answers while Latent is running.

You don't need to open any ports or change your router. Latent checks Telegram for new messages itself.

## Set it up

### 1. Make your bot

1. In Telegram, search for **@BotFather** (the official one has a blue check mark) and open a chat with it.
2. Send `/newbot`.
3. Pick a display name, like `My Latent Studio`.
4. Pick a username that ends in `bot`, like `my_latent_studio_bot`.
5. BotFather replies with a **token** that looks like `123456789:AAH...`. Copy it.

Keep the token private. Anyone who has it can control your bot. If it ever leaks, send `/revoke` to BotFather to get a new one.

### 2. Connect it to Latent

1. Open Latent and go to **Settings › Telegram remote**.
2. Paste the token into **Bot token** and click **Save protected token**. Windows keeps it locked away, just like a Civitai key.
3. Turn on **Telegram remote**. The badge says **Connecting** and then **Online**.

The card will ask for at least one allowed user until you finish the next step. That's expected!

### 3. Let yourself in

The bot ignores everyone who isn't on its list, so add your Telegram user ID:

1. In Telegram, open a chat with your new bot (tap the link BotFather sent, or search for its username) and press **Start**.
2. The bot replies with **your Telegram user ID**, a number like `123456789`.
3. In Latent, paste that number into **Who can use the bot** and click **Save allowed users**.

Want to share with a friend? They send `/start` to the bot, tell you the number it shows them, and you add it to the list with a comma in between, like `123456789, 987654321`.

### 4. Make something! 🎨

Send the bot a prompt, like:

```
a cozy cabin in a snowy forest at dusk
```

It replies **Queued!**, and the picture shows up in the chat once it's done.

## Changing settings

Each chat starts with whatever is set in **Create** on the PC: model, LoRAs, size, steps and so on. Change anything below and it sticks for that chat only, without touching the studio. Send a command on its own (like `/model` or `/size`) to see the choices; most show buttons you can tap.

| Command | What it does |
| --- | --- |
| `/settings` | Shows everything this chat will use |
| `/model` | Pick the checkpoint |
| `/loras` | Lists your LoRAs with numbers |
| `/lora 2 0.8` | Adds LoRA number 2 at weight 0.8 (a name works too) |
| `/lora remove 2` or `/lora clear` | Removes one LoRA, or all of them |
| `/size portrait` or `/size 832x1216` | Image size (multiples of 64, from 256 to 2048) |
| `/steps 30` · `/cfg 6.5` | Sampling steps and CFG |
| `/sampler` · `/scheduler` | Sampler and scheduler |
| `/seed 1234` or `/seed random` | Pin a seed, or go back to random |
| `/batch 2` | Images per prompt (1 to 4) |
| `/neg blurry, lowres` or `/neg off` | Negative prompt |
| `/hires on 1.5 0.35` or `/hires off` | Hires fix, with an optional scale and denoise |
| `/faces on anime 0.5` or `/faces off` | Face fix with a style (illustrated, anime or photographic) and an optional strength |
| `/triggers on` or `off` | Add LoRA trigger words automatically |
| `/preset` | Loads one of the studio's saved presets |
| `/reset` | Goes back to the studio's Create settings |

### One-off changes

Add settings to the end of a prompt to use them for just that image:

```
a fox in the snow --size landscape --steps 35 --seed 7
```

Anything from the table works this way, like `--model`, `--lora`, `--neg` or `--hires`.

### Other handy commands

| Command | What it does |
| --- | --- |
| `/gen <prompt>` | Same as just sending a prompt |
| `/again` | Runs your last prompt again with a new seed |
| `/queue` | Shows what's waiting or running |
| `/cancel` | Cancels your latest image |
| `/status` | Is the image engine running? |
| `/id` | Shows your Telegram user ID |
| `/help` | Shows all of this in the chat |

## Good to know

- Seeds are random unless you pin one with `/seed`, even if the studio has a fixed seed.
- With face fix on, the bot waits for the fix and sends the touched-up picture. If no face is found, you get the original.
- Pictures that are too big for a Telegram photo arrive as a file instead, at full quality.
- Everything the bot makes is saved in your **Library** on the PC, just like images made in the app.
- The bot does text-to-image only. Things that need you to pick an image first (img2img, inpainting, ControlNet, IP-Adapter, regional prompts and upscaling) stay in the app.
- The bot only answers private chats, so adding it to a group won't do anything.

## Troubleshooting

**The badge says "Telegram rejected the bot token."**
The token was mistyped or revoked. Get a fresh one from BotFather with `/token` (or `/revoke`) and paste it again.

**The badge says "Another program is using this bot token."**
Only one program can listen to a bot at a time. Close the other one (or Latent on another PC), and Latent reconnects by itself.

**The bot says "This bot is private."**
That Telegram account isn't on the list yet. Add the number it shows under **Who can use the bot**.

**The bot doesn't answer at all.**
Check that Latent is open and the badge says **Online**. If it says it can't reach Telegram, check your internet connection; Latent keeps retrying.

**"Couldn't queue that: …"**
Latent couldn't start that image, and the message says why. Usually no model is picked yet (send `/model`), or a LoRA doesn't match the model.

**"The image engine is not running yet."**
The image is queued and starts as soon as the engine is running. Start it from **Settings**, or turn on **Start with the studio** there.
