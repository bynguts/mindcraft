import { Server } from 'socket.io';
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import * as mindcraft from './mindcraft.js';
import { readFileSync } from 'fs';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Mindserver is:
// - central hub for communication between all agent processes
// - api to control from other languages and remote users 
// - host for webapp

let io;
let server;
const agent_connections = {};
const agent_listeners = [];

const settings_spec = JSON.parse(readFileSync(path.join(__dirname, 'public/settings_spec.json'), 'utf8'));

class AgentConnection {
    constructor(settings, viewer_port) {
        this.socket = null;
        this.settings = settings;
        this.in_game = false;
        this.full_state = null;
        this.viewer_port = viewer_port;
        this.last_heartbeat = Date.now(); // FIXED: Track heartbeat (Bug #34)
    }
    setSettings(settings) {
        this.settings = settings;
    }
}

export function registerAgent(settings, viewer_port) {
    let agentConnection = new AgentConnection(settings, viewer_port);
    agent_connections[settings.profile.name] = agentConnection;
}

export function logoutAgent(agentName) {
    if (agent_connections[agentName]) {
        agent_connections[agentName].in_game = false;
        agentsStatusUpdate();
    }
}

// Initialize the server
export function createMindServer(host_public = false, port = 8080) {
    const app = express();
    server = http.createServer(app);
    io = new Server(server);

    // Serve static files
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    app.use(express.static(path.join(__dirname, 'public')));

    // FIXED 1: Global API queue time untuk centralized rate limiting
    let global_api_queue_time = Date.now();

    // FIXED 2: Kunci server dengan token autentikasi (Security Patch)
    const AUTH_TOKEN = process.env.MINDCRAFT_SECRET || "mindcraft_super_secret_123";

    io.use((socket, next) => {
        // Ambil token dari auth object atau query parameter
        const token = socket.handshake.auth?.token || socket.handshake.query?.token;

        if (token === AUTH_TOKEN) {
            return next();
        }

        console.warn(`[Security] Blocked unauthorized connection attempt from IP: ${socket.handshake.address}`);
        return next(new Error("Authentication error: Access Denied"));
    });

    // Socket.io connection handling
    io.on('connection', (socket) => {
        let curAgentName = null;
        console.log('Client connected');

        // Handle request antrean API dari agent (Dari patch rate limiter)
        socket.on('request-api-slot', (minWait, callback) => {
            const now = Date.now();
            if (global_api_queue_time < now) {
                global_api_queue_time = now;
            }

            let sleepTime = global_api_queue_time - now;
            global_api_queue_time += minWait;

            if (typeof callback === 'function') {
                callback(sleepTime);
            }
        });

        agentsStatusUpdate(socket);

        socket.on('create-agent', async (settings, callback) => {
            console.log('API create agent...');
            for (let key in settings_spec) {
                if (!(key in settings)) {
                    if (settings_spec[key].required) {
                        callback({ success: false, error: `Setting ${key} is required` });
                        return;
                    }
                    else {
                        settings[key] = settings_spec[key].default;
                    }
                }
            }
            for (let key in settings) {
                if (!(key in settings_spec)) {
                    delete settings[key];
                }
            }
            if (settings.profile?.name) {
                if (settings.profile.name in agent_connections) {
                    callback({ success: false, error: 'Agent already exists' });
                    return;
                }
                let returned = await mindcraft.createAgent(settings);
                callback({ success: returned.success, error: returned.error });
                let name = settings.profile.name;
                if (!returned.success && agent_connections[name]) {
                    mindcraft.destroyAgent(name);
                    delete agent_connections[name];
                }
                agentsStatusUpdate();
            }
            else {
                console.error('Agent name is required in profile');
                callback({ success: false, error: 'Agent name is required in profile' });
            }
        });

        socket.on('get-settings', (agentName, callback) => {
            if (agent_connections[agentName]) {
                // FIXED: Sanitasi data settings sebelum dikirim ke client (Security Patch)
                // Cegah kebocoran seluruh isi profile ke jaringan
                const safeSettings = JSON.parse(JSON.stringify(agent_connections[agentName].settings));
                if (safeSettings.profile) {
                    // Hanya ekspos nama profile ke Web UI, buang sisa data sensitifnya
                    safeSettings.profile = { name: safeSettings.profile.name };
                }
                callback({ settings: safeSettings });
            } else {
                callback({ error: `Agent '${agentName}' not found.` });
            }
        });

        socket.on('connect-agent-process', (agentName) => {
            if (agent_connections[agentName]) {
                agent_connections[agentName].socket = socket;
                agentsStatusUpdate();
            }
        });

        socket.on('login-agent', (agentName) => {
            if (agent_connections[agentName]) {
                agent_connections[agentName].socket = socket;
                agent_connections[agentName].in_game = true;
                agent_connections[agentName].last_heartbeat = Date.now(); // Reset on login
                curAgentName = agentName;
                agentsStatusUpdate();
            }
            else {
                console.warn(`Unregistered agent ${agentName} tried to login`);
            }
        });

        socket.on('agent-heartbeat', (agentName) => {
            if (agent_connections[agentName]) {
                agent_connections[agentName].last_heartbeat = Date.now();
            }
        });

        socket.on('disconnect', () => {
            if (agent_connections[curAgentName]) {
                console.log(`Agent ${curAgentName} disconnected`);
                agent_connections[curAgentName].in_game = false;
                agent_connections[curAgentName].socket = null;
                agentsStatusUpdate();
            }
            if (agent_listeners.includes(socket)) {
                removeListener(socket);
            }
        });

        socket.on('chat-message', (agentName, json) => {
            if (!agent_connections[agentName]) {
                console.warn(`Agent ${agentName} tried to send a message but is not logged in`);
                return;
            }
            console.log(`${curAgentName} sending message to ${agentName}: ${json.message}`);
            agent_connections[agentName].socket.emit('chat-message', curAgentName, json);
        });

        socket.on('set-agent-settings', (agentName, settings) => {
            const agent = agent_connections[agentName];
            if (agent) {
                // FIXED: Gabungkan kembali dengan profile asli di server
                // Karena frontend hanya mengirim profile yang sudah disanitasi (kosong)
                const updatedSettings = {
                    ...settings,
                    profile: agent.settings.profile // Pertahankan data profile asli milik agent
                };
                agent.setSettings(updatedSettings);
                agent.socket.emit('restart-agent');
            }
        });

        socket.on('restart-agent', (agentName) => {
            console.log(`Restarting agent: ${agentName}`);
            agent_connections[agentName].socket.emit('restart-agent');
        });

        socket.on('stop-agent', (agentName) => {
            mindcraft.stopAgent(agentName);
        });

        socket.on('start-agent', (agentName) => {
            mindcraft.startAgent(agentName);
        });

        socket.on('destroy-agent', (agentName) => {
            if (agent_connections[agentName]) {
                mindcraft.destroyAgent(agentName);
                delete agent_connections[agentName];
            }
            agentsStatusUpdate();
        });

        socket.on('stop-all-agents', () => {
            console.log('Killing all agents');
            for (let agentName in agent_connections) {
                mindcraft.stopAgent(agentName);
            }
        });

        socket.on('shutdown', () => {
            console.log('Shutting down');
            for (let agentName in agent_connections) {
                mindcraft.stopAgent(agentName);
            }
            // wait 2 seconds
            setTimeout(() => {
                console.log('Exiting MindServer');
                process.exit(0);
            }, 2000);

        });

        socket.on('send-message', (agentName, data) => {
            if (!agent_connections[agentName]) {
                console.warn(`Agent ${agentName} not in game, cannot send message via MindServer.`);
                return
            }
            try {
                agent_connections[agentName].socket.emit('send-message', data)
            } catch (error) {
                console.error('Error: ', error);
            }
        });

        socket.on('bot-output', (agentName, message) => {
            io.emit('bot-output', agentName, message);
        });

        socket.on('listen-to-agents', () => {
            addListener(socket);
        });
    });

    if (host_public) {
        console.log('Public hosting not supported yet. Using localhost.');
    }
    const host = '0.0.0.0';
    server.listen(port, host, () => {
        console.log(`MindServer running on port ${port} on host ${host}`);
    });

    // FIXED: Watchdog untuk mendeteksi agent yang crash/hang (Bug #34)
    setInterval(() => {
        let changed = false;
        const now = Date.now();
        for (let agentName in agent_connections) {
            const conn = agent_connections[agentName];
            if (conn.in_game && (now - conn.last_heartbeat > 15000)) {
                console.log(`[Watchdog] Agent ${agentName} heartbeat timeout. Marking as crashed.`);
                conn.in_game = false;
                changed = true;
            }
        }
        if (changed) agentsStatusUpdate();
    }, 5000);

    return server;
}

function agentsStatusUpdate(socket) {
    if (!socket) {
        socket = io;
    }
    let agents = [];
    for (let agentName in agent_connections) {
        const conn = agent_connections[agentName];
        agents.push({
            name: agentName,
            in_game: conn.in_game,
            viewerPort: conn.viewer_port,
            socket_connected: !!conn.socket
        });
    };
    socket.emit('agents-status', agents);
}


let listenerInterval = null;
let isFetchingState = false; // FIXED: Lock untuk mekanisme Backpressure

function addListener(listener_socket) {
    agent_listeners.push(listener_socket);
    if (agent_listeners.length === 1) {
        listenerInterval = setInterval(async () => {
            // FIXED 1: Backpressure - Lewati siklus jika fetch sebelumnya belum beres
            if (isFetchingState) return;
            isFetchingState = true;

            const states = {};

            // FIXED 2: Parallel Execution - Kumpulkan semua agen yang aktif
            const activeAgents = Object.keys(agent_connections).filter(name => agent_connections[name].in_game);

            const fetchPromises = activeAgents.map(async (agentName) => {
                const agent = agent_connections[agentName];
                try {
                    const state = await new Promise((resolve, reject) => {
                        // FIXED: Bom waktu untuk mematikan Promise yang nyangkut
                        const timeout = setTimeout(() => {
                            reject(new Error('Fetch timeout (800ms)'));
                        }, 800);

                        agent.socket.emit('get-full-state', (s) => {
                            clearTimeout(timeout); // Matikan bom jika agen jawab cepat
                            resolve(s);
                        });
                    });
                    states[agentName] = state;
                } catch (e) {
                    states[agentName] = { error: String(e.message || e) };
                }
            });

            // Jalankan tembakan socket ke semua agen secara bersamaan
            await Promise.all(fetchPromises);

            for (let listener of agent_listeners) {
                listener.emit('state-update', states);
            }

            // Lepaskan lock agar siklus berikutnya bisa berjalan
            isFetchingState = false;
        }, 1000);
    }
}

function removeListener(listener_socket) {
    agent_listeners.splice(agent_listeners.indexOf(listener_socket), 1);
    if (agent_listeners.length === 0) {
        clearInterval(listenerInterval);
        listenerInterval = null;
    }
}

// Optional: export these if you need access to them from other files
export const getIO = () => io;
export const getServer = () => server;
export const numStateListeners = () => agent_listeners.length;