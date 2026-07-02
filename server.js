const express = require('express');
const { Client, GatewayIntentBits, PermissionsBitField } = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  getVoiceConnection,
} = require('@discordjs/voice');
const playdl     = require('play-dl');
const ffmpegPath = require('ffmpeg-static');
const ngrok      = require('ngrok');
process.env.FFMPEG_PATH = ffmpegPath;
const path = require('path');

const app  = express();
const PORT = 4000;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

let botClient = null;

// ── Lecteur audio par serveur ─────────────────────────────────────────────
const players = new Map(); // guildId → { player, connection, queue, current }

// ── Connexion ─────────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.json({ ok: false, error: 'Token manquant' });
  if (botClient) { try { botClient.destroy(); } catch {} botClient = null; }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.GuildBans,
      GatewayIntentBits.GuildVoiceStates,
    ],
  });

  try {
    await new Promise((resolve, reject) => {
      client.once('ready', resolve);
      client.once('error', reject);
      client.login(token).catch(reject);
      setTimeout(() => reject(new Error('Timeout')), 12000);
    });
    botClient = client;
    res.json({ ok: true, username: client.user.username, tag: client.user.tag, avatar: client.user.displayAvatarURL({ size: 128 }) });
  } catch {
    res.json({ ok: false, error: 'Token invalide' });
  }
});

// ── Middleware ─────────────────────────────────────────────────────────────
function requireClient(req, res, next) {
  if (!botClient) return res.json({ ok: false, error: 'Non connecté' });
  next();
}

// ── Infos ─────────────────────────────────────────────────────────────────
app.get('/api/info', requireClient, (req, res) => {
  const up = process.uptime();
  let total = 0;
  const guildList = [];
  for (const g of botClient.guilds.cache.values()) {
    total += g.memberCount;
    guildList.push({ id: g.id, name: g.name });
  }
  res.json({
    ok: true,
    username: botClient.user.username,
    tag: botClient.user.tag,
    avatar: botClient.user.displayAvatarURL({ size: 128 }),
    guilds: botClient.guilds.cache.size,
    members: total,
    uptime: `${Math.floor(up/3600)}h ${Math.floor((up%3600)/60)}m ${Math.floor(up%60)}s`,
    ping: botClient.ws.ping,
    guildList,
  });
});

// ── Salons texte ──────────────────────────────────────────────────────────
app.get('/api/channels/:guildId', requireClient, (req, res) => {
  const guild = botClient.guilds.cache.get(req.params.guildId);
  if (!guild) return res.json([]);
  res.json(guild.channels.cache.filter(c => c.type === 0).map(c => ({ id: c.id, name: c.name })).sort((a,b) => a.name.localeCompare(b.name)));
});

// ── Salons vocaux ─────────────────────────────────────────────────────────
app.get('/api/voice/:guildId', requireClient, (req, res) => {
  const guild = botClient.guilds.cache.get(req.params.guildId);
  if (!guild) return res.json([]);
  res.json(guild.channels.cache.filter(c => c.type === 2).map(c => ({ id: c.id, name: c.name })).sort((a,b) => a.name.localeCompare(b.name)));
});

// ── Membres ───────────────────────────────────────────────────────────────
app.get('/api/members/:guildId', requireClient, async (req, res) => {
  const guild = botClient.guilds.cache.get(req.params.guildId);
  if (!guild) return res.json([]);
  await guild.members.fetch().catch(() => {});
  res.json(guild.members.cache.filter(m => !m.user.bot).map(m => ({ id: m.id, username: m.user.username, avatar: m.user.displayAvatarURL({ size: 64 }) })).sort((a,b) => a.username.localeCompare(b.username)));
});

// ── Bannis ────────────────────────────────────────────────────────────────
app.get('/api/bans/:guildId', requireClient, async (req, res) => {
  const guild = botClient.guilds.cache.get(req.params.guildId);
  if (!guild) return res.json([]);
  const bans = await guild.bans.fetch().catch(() => new Map());
  res.json([...bans.values()].map(b => ({ id: b.user.id, username: b.user.username, reason: b.reason })));
});

// ── Envoyer message ───────────────────────────────────────────────────────
app.post('/api/send', requireClient, async (req, res) => {
  const { channelId, content } = req.body;
  if (!channelId || !content) return res.json({ ok: false, error: 'Paramètres manquants' });
  try {
    const ch = await botClient.channels.fetch(channelId);
    await ch.send(content);
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ── Clear messages ────────────────────────────────────────────────────────
app.post('/api/clear', requireClient, async (req, res) => {
  const { channelId, amount } = req.body;
  try {
    const ch = await botClient.channels.fetch(channelId);
    const deleted = await ch.bulkDelete(Math.min(amount || 10, 100), true);
    res.json({ ok: true, deleted: deleted.size });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ── Status ────────────────────────────────────────────────────────────────
app.post('/api/status', requireClient, (req, res) => {
  const { status, type, text } = req.body;
  const types = { Playing: 0, Listening: 2, Watching: 3, Competing: 5 };
  try {
    botClient.user.setPresence({ status, activities: text ? [{ name: text, type: types[type] ?? 0 }] : [] });
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ── Avatar ────────────────────────────────────────────────────────────────
app.post('/api/avatar', requireClient, async (req, res) => {
  const { url, data } = req.body;
  try {
    if (data) await botClient.user.setAvatar(Buffer.from(data.split(',')[1], 'base64'));
    else if (url) await botClient.user.setAvatar(url);
    else return res.json({ ok: false, error: 'Aucune image' });
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ── Username ──────────────────────────────────────────────────────────────
app.post('/api/username', requireClient, async (req, res) => {
  const { username } = req.body;
  try {
    await botClient.user.setUsername(username);
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ── Ban ───────────────────────────────────────────────────────────────────
app.post('/api/ban', requireClient, async (req, res) => {
  const { guildId, userId, reason } = req.body;
  try {
    const guild = botClient.guilds.cache.get(guildId);
    await guild.members.ban(userId, { reason: reason || 'Panel', deleteMessageSeconds: 604800 });
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ── Unban ─────────────────────────────────────────────────────────────────
app.post('/api/unban', requireClient, async (req, res) => {
  const { guildId, userId } = req.body;
  try {
    const guild = botClient.guilds.cache.get(guildId);
    await guild.bans.remove(userId);
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ── Kick ──────────────────────────────────────────────────────────────────
app.post('/api/kick', requireClient, async (req, res) => {
  const { guildId, userId, reason } = req.body;
  try {
    const guild = botClient.guilds.cache.get(guildId);
    const member = await guild.members.fetch(userId);
    await member.kick(reason || 'Panel');
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ── Mute / Unmute ─────────────────────────────────────────────────────────
app.post('/api/mute', requireClient, async (req, res) => {
  const { guildId, userId, duration } = req.body;
  try {
    const guild = botClient.guilds.cache.get(guildId);
    const member = await guild.members.fetch(userId);
    await member.timeout(duration || 60000);
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

app.post('/api/unmute', requireClient, async (req, res) => {
  const { guildId, userId } = req.body;
  try {
    const guild = botClient.guilds.cache.get(guildId);
    const member = await guild.members.fetch(userId);
    await member.timeout(null);
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, error: e.message }); }
});

// ── Déconnexion ───────────────────────────────────────────────────────────
app.post('/api/logout', (req, res) => {
  if (botClient) { try { botClient.destroy(); } catch {} botClient = null; }
  res.json({ ok: true });
});

// ── Musique ───────────────────────────────────────────────────────────────
async function playNext(guildId) {
  const state = players.get(guildId);
  if (!state || state.queue.length === 0) {
    if (state) { state.current = null; }
    return;
  }
  const track = state.queue.shift();
  state.current = track;
  try {
    console.log(`Tentative lecture: ${track.title}, URL: ${track.url}`);
    const stream = ytdl(track.url, { filter: 'audioonly', quality: 'highestaudio' });
    const resource = createAudioResource(stream);
    state.player.play(resource);
    console.log(`Lecture démarrée: ${track.title}`);
  } catch (e) {
    console.error('❌ Erreur lecture :', e.message, 'pour:', track.title);
    state.current = null;
    // Passer à la suivante sans supprimer celle qui a échoué (elle est déjà retirée)
    playNext(guildId);
  }
}

// Rejoindre + jouer
app.post('/api/music/play', requireClient, async (req, res) => {
  const { guildId, channelId, url } = req.body;
  if (!guildId || !channelId || !url) return res.json({ ok: false, error: 'Paramètres manquants' });

  try {
    // Nettoie l'URL pour ne garder que l'ID de la vidéo
    let cleanUrl = url;
    const videoIdMatch = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]+)/);
    if (videoIdMatch) {
      cleanUrl = `https://www.youtube.com/watch?v=${videoIdMatch[1]}`;
    }

    // Vérifie que c'est une URL YouTube valide
    const isValid = await ytdl.validateURL(cleanUrl);
    if (!isValid) {
      console.error('URL invalide:', cleanUrl);
      return res.json({ ok: false, error: 'URL YouTube invalide. Assurez-vous que c\'est un lien YouTube complet.' });
    }

    // Récupère les infos de la vidéo
    const info = await ytdl.getInfo(cleanUrl);
    const track = { url: cleanUrl, title: info.videoDetails.title, duration: info.videoDetails.lengthSeconds };

    let state = players.get(guildId);

    if (!state) {
      // Rejoindre le salon vocal
      const guild = botClient.guilds.cache.get(guildId);
      const channel = guild.channels.cache.get(channelId);
      if (!channel) return res.json({ ok: false, error: 'Salon vocal introuvable' });

      const connection = joinVoiceChannel({
        channelId,
        guildId,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false,
      });

      const player = createAudioPlayer();
      connection.subscribe(player);

      // Attendre que la connexion soit prête
      connection.on('stateChange', (oldState, newState) => {
        if (newState.status === VoiceConnectionStatus.Ready) {
          console.log('Connexion vocale prête');
        }
      });

      player.on(AudioPlayerStatus.Idle, () => playNext(guildId));
      player.on('error', e => console.error('Player error:', e.message));

      state = { player, connection, queue: [], current: null };
      players.set(guildId, state);
    }

    state.queue.push(track);

    console.log(`Musique ajoutée: ${track.title}, File: ${state.queue.length} musiques`);

    // Si rien en cours, joue directement
    if (state.player.state.status === AudioPlayerStatus.Idle) {
      await playNext(guildId);
    }

    res.json({ ok: true, title: track.title, duration: track.duration, position: state.queue.length });
  } catch (e) {
    console.error('Erreur play:', e.message);
    res.json({ ok: false, error: e.message });
  }
});

// Stop
app.post('/api/music/stop', requireClient, (req, res) => {
  const { guildId } = req.body;
  const state = players.get(guildId);
  if (!state) return res.json({ ok: false, error: 'Pas de musique en cours' });
  state.queue = [];
  state.player.stop();
  state.connection.destroy();
  players.delete(guildId);
  res.json({ ok: true });
});

// Skip
app.post('/api/music/skip', requireClient, (req, res) => {
  const { guildId } = req.body;
  const state = players.get(guildId);
  if (!state) return res.json({ ok: false, error: 'Pas de musique en cours' });
  state.player.stop(); // déclenche Idle → playNext
  res.json({ ok: true });
});

// Queue
app.get('/api/music/queue/:guildId', requireClient, (req, res) => {
  const state = players.get(req.params.guildId);
  console.log(`Queue request for ${req.params.guildId}, state:`, state ? 'exists' : 'null');
  if (!state) return res.json({ ok: true, current: null, queue: [] });
  console.log(`Queue: ${state.queue.length} items, current:`, state.current);
  res.json({ ok: true, current: state.current, queue: state.queue });
});

// Remove from queue
app.post('/api/music/remove', requireClient, (req, res) => {
  const { guildId, index } = req.body;
  const state = players.get(guildId);
  if (!state) return res.json({ ok: false, error: 'Pas de file d\'attente' });
  if (index < 0 || index >= state.queue.length) return res.json({ ok: false, error: 'Index invalide' });
  const removed = state.queue.splice(index, 1)[0];
  res.json({ ok: true, removed: removed.title });
});

// Play specific from queue
app.post('/api/music/play-index', requireClient, async (req, res) => {
  const { guildId, index } = req.body;
  const state = players.get(guildId);
  if (!state) return res.json({ ok: false, error: 'Pas de file d\'attente' });
  if (index < 0 || index >= state.queue.length) return res.json({ ok: false, error: 'Index invalide' });

  // Déplace la musique au début de la file
  const track = state.queue.splice(index, 1)[0];
  state.queue.unshift(track);

  // Si le player est idle, lance la musique
  if (state.player.state.status === AudioPlayerStatus.Idle) {
    await playNext(guildId);
  } else {
    state.player.stop(); // Cela déclenchera playNext qui jouera la nouvelle première musique
  }

  res.json({ ok: true, title: track.title });
});

// Leave
app.post('/api/music/leave', requireClient, (req, res) => {
  const { guildId } = req.body;
  const conn = getVoiceConnection(guildId);
  if (conn) conn.destroy();
  players.delete(guildId);
  res.json({ ok: true });
});

// Mute (pause audio + self-mute)
app.post('/api/music/mute', requireClient, (req, res) => {
  const { guildId } = req.body;
  const state = players.get(guildId);
  if (!state || !state.player) return res.json({ ok: false, error: 'Pas de lecture en cours' });
  state.player.pause();
  if (state.connection) {
    state.connection.voice.setSelfMute(true);
  }
  res.json({ ok: true });
});

// Unmute (resume audio + self-unmute)
app.post('/api/music/unmute', requireClient, (req, res) => {
  const { guildId } = req.body;
  const state = players.get(guildId);
  if (!state || !state.player) return res.json({ ok: false, error: 'Pas de lecture en cours' });
  state.player.unpause();
  if (state.connection) {
    state.connection.voice.setSelfMute(false);
  }
  res.json({ ok: true });
});

app.listen(PORT, async () => {
  console.log(`✅ Panel local : http://localhost:${PORT}`);
  try {
    const url = await ngrok.connect(PORT);
    console.log(`🌍 Panel public  : ${url}`);
    console.log(`⚠️  Cette URL change à chaque redémarrage.`);
  } catch (e) {
    console.log(`⚠️  ngrok non disponible (${e.message})`);
    console.log(`   Crée un compte sur https://ngrok.com pour activer le tunnel public.`);
  }
});
