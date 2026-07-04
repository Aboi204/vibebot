{
  "name": "discord-music-bot",
  "version": "1.0.0",
  "description": "A lightweight, highly efficient Discord Music Bot using play-dl and discord.js v14.",
  "main": "index.js",
  "scripts": {
    "start": "node index.js",
    "deploy": "node deploy-commands.js"
  },
  "keywords": [
    "discord",
    "bot",
    "music",
    "play-dl",
    "discord.js",
    "streaming"
  ],
  "author": "Discord Bot Manager",
  "license": "MIT",
  "dependencies": {
    "discord.js": "^14.14.1",
    "@discordjs/voice": "^0.16.1",
    "play-dl": "^1.9.7",
    "dotenv": "^16.4.5",
    "libsodium-wrappers": "^0.7.13",
    "@discordjs/opus": "^0.9.0"
  }
}
