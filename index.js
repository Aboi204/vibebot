/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 * 
 * Elegant, highly-efficient Discord Music Bot using discord.js v14 & play-dl.
 * Avoids local downloads entirely; streams everything on-the-fly to minimize memory.
 */

require('dotenv').config();
const { 
  Client, 
  GatewayIntentBits, 
  ActivityType, 
  EmbedBuilder, 
  PermissionsBitField 
} = require('discord.js');
const { 
  joinVoiceChannel, 
  createAudioPlayer, 
  createAudioResource, 
  AudioPlayerStatus, 
  VoiceConnectionStatus,
  getVoiceConnection
} = require('@discordjs/voice');
const play = require('play-dl');

// --- Helper for Logging ---
function log(level, message, context = '') {
  const timestamp = new Date().toISOString();
  const ctxString = context ? ` [${context}]` : '';
  console.log(`[${timestamp}] [${level}]${ctxString}: ${message}`);
}

// Ensure the token exists
if (!process.env.DISCORD_TOKEN) {
  log('ERROR', 'DISCORD_TOKEN is missing in the environment or .env file.', 'Startup');
  process.exit(1);
}

// --- Discord Client Initialization ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
  ]
});

// Queue store (guildId -> queue object)
const queues = new Map();

// --- Platform Link Resolvers ---
function getGoogleDriveStreamUrl(url) {
  // Try to extract Google Drive file ID
  const driveRegex = /(?:drive\.google\.com\/(?:file\/d\/|open\?id=)|docs\.google\.com\/file\/d\/)([a-zA-Z0-9_-]{25,})/;
  const match = url.match(driveRegex);
  if (match && match[1]) {
    const fileId = match[1];
    // Return direct download/stream link format
    return `https://docs.google.com/uc?export=download&id=${fileId}`;
  }
  return null;
}

// Custom handler for Direct Streamable URL (Telegram, Facebook, Direct Files)
function isDirectOrSocialUrl(url) {
  return url.includes('telegram') || url.includes('facebook.com') || url.includes('fb.watch') || url.match(/\.(mp3|wav|ogg|m4a|mp4|webm)$/i);
}

// --- Audio Player Controller ---
class GuildQueue {
  constructor(guild, textChannel, voiceChannel) {
    this.guild = guild;
    this.textChannel = textChannel;
    this.voiceChannel = voiceChannel;
    this.songs = [];
    this.connection = null;
    this.player = null;
    this.playing = false;
    this.paused = false;

    this.setupPlayer();
  }

  setupPlayer() {
    this.player = createAudioPlayer();

    this.player.on(AudioPlayerStatus.Playing, () => {
      this.playing = true;
      const current = this.songs[0];
      log('STREAM', `Started streaming: "${current.title}" (${current.platform})`, this.guild.id);
      
      const embed = new EmbedBuilder()
        .setColor('#10B981')
        .setTitle('🎶 Now Playing')
        .setDescription(`[${current.title}](${current.url})`)
        .addFields(
          { name: 'Duration', value: current.duration || 'Live Stream', inline: true },
          { name: 'Requested By', value: `<@${current.requestedBy}>`, inline: true },
          { name: 'Platform', value: current.platform, inline: true }
        )
        .setTimestamp();
      
      this.textChannel.send({ embeds: [embed] }).catch(err => log('ERROR', err.message, 'TextChannelSend'));
    });

    this.player.on(AudioPlayerStatus.Idle, () => {
      log('INFO', 'Finished track. Fetching next song...', this.guild.id);
      this.songs.shift(); // Remove the finished song
      this.playNext();
    });

    this.player.on('error', error => {
      log('ERROR', `Audio Player error: ${error.message}`, this.guild.id);
      this.textChannel.send(`⚠️ An error occurred while streaming: **${error.message}**`).catch(e => {});
      this.songs.shift();
      this.playNext();
    });
  }

  async playNext() {
    if (this.songs.length === 0) {
      log('INFO', 'Queue is empty. Waiting for songs or preparing to disconnect...', this.guild.id);
      this.playing = false;
      
      // Leave channel after 3 minutes of idle time
      setTimeout(() => {
        if (this.songs.length === 0 && this.connection) {
          log('INFO', 'Bot left voice channel due to inactivity.', this.guild.id);
          this.destroy();
        }
      }, 180000);

      return;
    }

    const song = this.songs[0];
    try {
      let resource;
      
      if (song.platform === 'Google Drive') {
        // Direct stream from Google Drive URL
        resource = createAudioResource(song.streamUrl, {
          inputType: song.streamType || undefined
        });
      } else if (song.platform === 'Direct Link' || song.platform === 'Social Media') {
        // Play directly from raw URL
        resource = createAudioResource(song.streamUrl);
      } else {
        // YouTube, Spotify, SoundCloud streaming via play-dl
        const streamResult = await play.stream(song.url);
        resource = createAudioResource(streamResult.stream, {
          inputType: streamResult.type
        });
      }

      this.connection.subscribe(this.player);
      this.player.play(resource);
    } catch (err) {
      log('ERROR', `Failed to stream song: ${err.message}`, this.guild.id);
      this.textChannel.send(`⚠️ Failed to stream song **${song.title}**: ${err.message}`).catch(e => {});
      this.songs.shift();
      this.playNext();
    }
  }

  destroy() {
    try {
      if (this.player) this.player.stop();
      if (this.connection) this.connection.destroy();
    } catch (e) {
      log('ERROR', `Error destroying queue connection: ${e.message}`, this.guild.id);
    }
    queues.delete(this.guild.id);
  }
}

// --- Interaction (Slash Commands) Listener ---
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName, guildId, member, guild } = interaction;
  
  // Track commands
  const userTag = `${interaction.user.username}#${interaction.user.discriminator || '0000'}`;
  const queryParam = interaction.options.getString('query') || '';
  log('COMMAND', `/${commandName} requested by ${userTag}`, guildId);

  // Guild voice pre-checks
  if (!member.voice.channel) {
    return interaction.reply({ 
      content: '❌ You must be in a voice channel to use this command!', 
      ephemeral: true 
    });
  }

  let queue = queues.get(guildId);

  // Command handlers
  if (commandName === 'play') {
    await interaction.deferReply();
    const query = interaction.options.getString('query');

    try {
      let songInfo = null;
      let platform = 'YouTube';
      let streamUrl = query;

      // 1. Google Drive Links
      const driveUrl = getGoogleDriveStreamUrl(query);
      if (driveUrl) {
        platform = 'Google Drive';
        songInfo = {
          title: 'Google Drive Audio Stream',
          url: query,
          streamUrl: driveUrl,
          duration: 'Live / Variable',
          platform: 'Google Drive',
          requestedBy: interaction.user.id
        };
      } 
      // 2. Direct Audio Link (e.g., Telegram, Web URLs)
      else if (isDirectOrSocialUrl(query)) {
        platform = query.includes('telegram') ? 'Telegram' : query.includes('facebook') ? 'Facebook' : 'Direct Link';
        songInfo = {
          title: `Direct Link Media (${platform})`,
          url: query,
          streamUrl: query,
          duration: 'Live',
          platform: platform,
          requestedBy: interaction.user.id
        };
      } 
      // 3. YouTube/Spotify/SoundCloud via play-dl
      else {
        // Search & metadata retrieval
        const searchType = play.yt_validate(query);
        
        if (searchType === 'video') {
          const ytInfo = await play.video_basic_info(query);
          const videoDetails = ytInfo.video_details;
          songInfo = {
            title: videoDetails.title,
            url: videoDetails.url,
            duration: videoDetails.durationRaw,
            platform: 'YouTube',
            requestedBy: interaction.user.id
          };
        } else if (searchType === 'playlist') {
          const playlist = await play.playlist_info(query);
          const videos = await playlist.all_videos();
          
          if (videos.length === 0) {
            return interaction.editReply('⚠️ No videos found in that playlist!');
          }

          if (!queue) {
            queue = new GuildQueue(guild, interaction.channel, member.voice.channel);
            queues.set(guildId, queue);
          }

          // Connect
          if (!queue.connection) {
            queue.connection = joinVoiceChannel({
              channelId: member.voice.channel.id,
              guildId: guildId,
              adapterCreator: guild.voiceAdapterCreator,
            });
          }

          videos.forEach(video => {
            queue.songs.push({
              title: video.title,
              url: video.url,
              duration: video.durationRaw,
              platform: 'YouTube Playlist',
              requestedBy: interaction.user.id
            });
          });

          if (!queue.playing) {
            queue.playNext();
          }

          return interaction.editReply(`🎶 Added **${videos.length}** tracks from YouTube playlist to queue!`);
        } else if (query.includes('spotify.com')) {
          // spotify validation
          if (play.sp_validate(query) === 'track') {
            const spInfo = await play.spotify(query);
            // Search on youtube
            const ytSearch = await play.search(`${spInfo.name} ${spInfo.artists[0]?.name}`, { limit: 1 });
            if (ytSearch.length > 0) {
              songInfo = {
                title: `${spInfo.name} - ${spInfo.artists.map(a => a.name).join(', ')}`,
                url: ytSearch[0].url,
                duration: spInfo.durationRaw || ytSearch[0].durationRaw,
                platform: 'Spotify',
                requestedBy: interaction.user.id
              };
            } else {
              return interaction.editReply('❌ Could not resolve this Spotify track to streamable audio.');
            }
          } else {
            return interaction.editReply('⚠️ Playlists are supported for YouTube. Single tracks only for Spotify/Soundcloud currently for extreme efficiency.');
          }
        } else if (query.includes('soundcloud.com')) {
          if (await play.so_validate(query) === 'track') {
            const scInfo = await play.soundcloud(query);
            songInfo = {
              title: scInfo.name,
              url: scInfo.url,
              duration: scInfo.duration || 'Variable',
              platform: 'SoundCloud',
              requestedBy: interaction.user.id
            };
          } else {
            return interaction.editReply('⚠️ SoundCloud tracks only are supported for lightweight streaming.');
          }
        } else {
          // Search YouTube as fallback
          const searchResult = await play.search(query, { limit: 1 });
          if (searchResult.length === 0) {
            return interaction.editReply('❌ No results found on YouTube.');
          }
          songInfo = {
            title: searchResult[0].title,
            url: searchResult[0].url,
            duration: searchResult[0].durationRaw,
            platform: 'YouTube Search',
            requestedBy: interaction.user.id
          };
        }
      }

      if (!songInfo) {
        return interaction.editReply('❌ Failed to extract audio resource details.');
      }

      // Initialize queue if it does not exist
      if (!queue) {
        queue = new GuildQueue(guild, interaction.channel, member.voice.channel);
        queues.set(guildId, queue);
      }

      // Join Voice Connection
      if (!queue.connection) {
        queue.connection = joinVoiceChannel({
          channelId: member.voice.channel.id,
          guildId: guildId,
          adapterCreator: guild.voiceAdapterCreator,
        });

        queue.connection.on(VoiceConnectionStatus.Disconnected, async () => {
          log('INFO', 'Voice connection disconnected. Cleaning up...', guildId);
          queue.destroy();
        });
      }

      queue.songs.push(songInfo);

      if (queue.playing) {
        const addedEmbed = new EmbedBuilder()
          .setColor('#3B82F6')
          .setTitle('📝 Added to Queue')
          .setDescription(`[${songInfo.title}](${songInfo.url})`)
          .addFields(
            { name: 'Position', value: `${queue.songs.length - 1}`, inline: true },
            { name: 'Platform', value: songInfo.platform, inline: true }
          );
        return interaction.editReply({ embeds: [addedEmbed] });
      } else {
        await interaction.editReply(`🎧 Initializing stream...`);
        queue.playNext();
      }

    } catch (err) {
      log('ERROR', `Error handling play command: ${err.message}`, guildId);
      interaction.editReply(`❌ An error occurred while queuing audio: **${err.message}**`);
    }
  }

  else if (commandName === 'skip') {
    if (!queue || !queue.playing) {
      return interaction.reply({ content: '❌ Nothing is currently playing!', ephemeral: true });
    }
    log('INFO', 'Skipping active track...', guildId);
    queue.player.stop(); // Stops player, triggers Idle event which plays next track
    interaction.reply('⏭️ Skipped current track!');
  }

  else if (commandName === 'stop') {
    if (!queue) {
      return interaction.reply({ content: '❌ The bot is not in a voice channel!', ephemeral: true });
    }
    log('INFO', 'Stopping audio player and clearing queue...', guildId);
    queue.destroy();
    interaction.reply('🛑 Stopped playback, cleared the queue, and disconnected from voice.');
  }

  else if (commandName === 'pause') {
    if (!queue || !queue.playing || queue.paused) {
      return interaction.reply({ content: '❌ No active track to pause!', ephemeral: true });
    }
    log('INFO', 'Pausing playback...', guildId);
    queue.player.pause();
    queue.paused = true;
    interaction.reply('⏸️ Paused playback!');
  }

  else if (commandName === 'resume') {
    if (!queue || !queue.paused) {
      return interaction.reply({ content: '❌ The music is not paused!', ephemeral: true });
    }
    log('INFO', 'Resuming playback...', guildId);
    queue.player.unpause();
    queue.paused = false;
    interaction.reply('▶️ Resumed playback!');
  }
});

// --- Startup Hook ---
client.once('ready', () => {
  log('INFO', `Successfully logged in as ${client.user.tag}!`, 'Startup');
  client.user.setActivity({
    name: 'Slash Commands | /play',
    type: ActivityType.Listening
  });
});

client.login(process.env.DISCORD_TOKEN).catch(err => {
  log('ERROR', `Failed to authenticate with Discord API: ${err.message}`, 'Startup');
});
