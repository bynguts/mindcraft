import { io } from 'socket.io-client';
import convoManager from './conversation.js';
import { setSettings } from './settings.js';
import { getFullState } from './library/full_state.js';

// agent's individual connection to the mindserver
// always connect to localhost

class MindServerProxy {
    constructor() {
        this.socket = null;
        this.connected = false;
    }

    async connect(name, port) {
        if (this.connected) return;

        this.name = name;

        this.socket = io(`http://127.0.0.1:${port}`);

        await new Promise((resolve, reject) => {
            this.socket.on('connect', resolve);
            this.socket.on('connect_error', (err) => {
                console.error('Connection failed:', err);
                reject(err);
            });
        });

        this.connected = true;
        console.log(name, 'connected to MindServer');

        this.socket.on('disconnect', () => {
            console.log('Disconnected from MindServer');
            this.connected = false;
            if (this.agent) {
                this.agent.cleanKill('Disconnected from MindServer. Killing agent process.');
            }
        });

        this.socket.on('chat-message', (agentName, json) => {
            convoManager.receiveFromBot(agentName, json);
        });

        this.socket.on('agents-status', (agents) => {
            this.agents = agents;
            convoManager.updateAgents(agents);
            if (this.agent?.task) {
                console.log(this.agent.name, 'updating available agents');
                this.agent.task.updateAvailableAgents(agents);
            }
        });

        this.socket.on('restart-agent', (agentName) => {
            console.log(`Restarting agent: ${agentName}`);
            this.agent.cleanKill();
        });

        this.socket.on('send-message', (data) => {
            try {
                this.agent.respondFunc(data.from, data.message);
            } catch (error) {
                console.error('Error: ', JSON.stringify(error, Object.getOwnPropertyNames(error)));
            }
        });

        this.socket.on('get-full-state', (callback) => {
            try {
                const state = getFullState(this.agent);
                callback(state);
            } catch (error) {
                console.error('Error getting full state:', error);
                callback(null);
            }
        });

        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Settings request timed out after 5 seconds'));
            }, 5000);

            this.socket.emit('get-settings', name, true, (response) => {
                clearTimeout(timeout);
                if (response.error) {
                    return reject(new Error(response.error));
                }
                setSettings(response.settings);
                this.socket.emit('connect-agent-process', name);
                resolve();
            });
        });
    }

    setAgent(agent) {
        this.agent = agent;
    }

    getAgents() {
        return this.agents;
    }

    getNumOtherAgents() {
        return this.agents.length - 1;
    }

    login() {
        if (this.socket) {
            this.socket.emit('login-agent', this.agent.name);
        }
    }

    shutdown() {
        if (this.socket) {
            this.socket.emit('shutdown');
        }
    }

    checkRateLimit(username, message) {
        return new Promise((resolve) => {
            if (!this.socket || !this.connected) return resolve(true);
            const timeout = setTimeout(() => resolve(true), 1000);
            this.socket.emit('check-rate-limit', username, message, (response) => {
                clearTimeout(timeout);
                resolve(response.allowed);
            });
        });
    }

    getSocket() {
        return this.socket;
    }
}

export const serverProxy = new MindServerProxy();

export function sendBotChatToServer(agentName, json) {
    if (serverProxy.getSocket()) {
        serverProxy.getSocket().emit('chat-message', agentName, json);
    }
}

export function sendOutputToServer(agentName, message) {
    if (serverProxy.getSocket()) {
        serverProxy.getSocket().emit('bot-output', agentName, message);
    }
}