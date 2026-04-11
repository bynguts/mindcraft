import { History } from './history.js';
import { Coder } from './coder.js';
import { VisionInterpreter } from './vision/vision_interpreter.js';
import { Prompter } from '../models/prompter.js';
import { initModes } from './modes.js';
import { initBot } from '../utils/mcdata.js';
import { containsCommand, commandExists, executeCommand, truncCommandMessage, isAction, blacklistCommands } from './commands/index.js';
import { ActionManager } from './action_manager.js';
import { NPCContoller } from './npc/controller.js';
import { MemoryBank } from './memory_bank.js';
import { SelfPrompter } from './self_prompter.js';
import convoManager from './conversation.js';
import { handleTranslation, handleEnglishTranslation } from '../utils/translator.js';
import { addBrowserViewer } from './vision/browser_viewer.js';
import { serverProxy, sendOutputToServer } from './mindserver_proxy.js';
import settings from './settings.js';
import { Task } from './tasks/tasks.js';
import { speak } from './speak.js';
import { log, validateNameFormat, handleDisconnection } from './connection_handler.js';
import { LearnedSkills } from './learned_skills.js';
import { loadSavedSkills } from './commands/actions.js';

export class Agent {
    async start(load_mem = false, init_message = null, count_id = 0) {
        this.last_sender = null;
        this.count_id = count_id;

        this.flags = {
            disconnectHandled: false,
            shutUp: false
        };

        loadSavedSkills();

        this.actions = new ActionManager(this);
        this.prompter = new Prompter(this, settings.profile);
        this.name = (this.prompter.getName() || '').trim();
        console.log(`Initializing agent ${this.name}...`);


        const nameCheck = validateNameFormat(this.name);
        if (!nameCheck.success) {
            log(this.name, nameCheck.msg);
            process.exit(1);
            return;
        }

        this.history = new History(this);
        this.coder = new Coder(this);
        this.npc = new NPCContoller(this);
        this.memory_bank = new MemoryBank();
        this.learned_skills = new LearnedSkills(this);
        this.self_prompter = new SelfPrompter(this);
        convoManager.initAgent(this);
        await this.prompter.initExamples();

        let save_data = null;
        if (load_mem) {
            save_data = this.history.load();
        }


        if (save_data && save_data.quests) {
            this.memory_bank.quests = save_data.quests;
            console.log(`[Memory] Restored ${Object.keys(save_data.quests).length} active quests.`);
        }

        let taskStart = null;
        if (save_data) {
            taskStart = save_data.taskStart;
        } else {
            taskStart = Date.now();
        }
        this.task = new Task(this, settings.task, taskStart);
        this.blocked_actions = settings.blocked_actions.concat(this.task.blocked_actions || []);
        blacklistCommands(this.blocked_actions);

        console.log(this.name, 'logging into minecraft...');
        this.bot = initBot(this.name);

        const onDisconnect = (event, reason) => {
            if (this.flags.disconnectHandled) return;
            this.flags.disconnectHandled = true;


            if (this.bot && this.bot._positionTimeout) {
                clearTimeout(this.bot._positionTimeout);
                this.bot._positionTimeout = null;
                console.log(`[System] Cleared pending position packet for ${this.name}`);
            }


            if (this.heartbeatInterval) {
                clearInterval(this.heartbeatInterval);
                this.heartbeatInterval = null;
                console.log(`[System] Cleared heartbeat interval for ${this.name}`);
            }

            const { type } = handleDisconnection(this.name, reason);

            process.exit(1);
        };

        this.bot.once('kicked', (reason) => onDisconnect('Kicked', reason));
        this.bot.once('end', (reason) => onDisconnect('Disconnected', reason));
        this.bot.on('error', (err) => {
            if (String(err).includes('Duplicate') || String(err).includes('ECONNREFUSED')) {
                onDisconnect('Error', err);
            } else {
                log(this.name, `[LoginGuard] Connection Error: ${String(err)}`);
            }
        });

        initModes(this);

        this.bot.on('login', () => {
            console.log(this.name, 'logged in!');
            serverProxy.login();

            // Set skin for profile, requires Fabric Tailor. (https://modrinth.com/mod/fabrictailor)
            if (this.prompter.profile.skin)
                this.bot.chat(`/skin set URL ${this.prompter.profile.skin.model} ${this.prompter.profile.skin.path}`);
            else
                this.bot.chat(`/skin clear`);
        });
        const spawnTimeoutDuration = settings.spawn_timeout;
        const spawnTimeout = setTimeout(() => {
            const msg = `Bot has not spawned after ${spawnTimeoutDuration} seconds. Exiting.`;
            log(this.name, msg);


            if (this.heartbeatInterval) {
                clearInterval(this.heartbeatInterval);
                this.heartbeatInterval = null;
            }

            process.exit(1);
        }, spawnTimeoutDuration * 1000);
        this.bot.once('spawn', async () => {
            try {
                clearTimeout(spawnTimeout);
                addBrowserViewer(this.bot, count_id);
                console.log('Initializing vision intepreter...');
                this.vision_interpreter = new VisionInterpreter(this, settings.allow_vision);

                await new Promise((resolve) => setTimeout(resolve, 1000));

                console.log(`${this.name} spawned.`);
                this.clearBotLogs();


                this.heartbeatInterval = setInterval(() => {
                    if (serverProxy.getSocket()) {
                        serverProxy.getSocket().emit('agent-heartbeat', this.name);
                    }
                }, 5000);

                this._setupEventHandlers(save_data, init_message);
                this.startEvents();

                if (!load_mem) {
                    if (settings.task) {
                        this.task.initBotTask();
                        this.task.setAgentGoal();
                    }
                } else {
                    if (settings.task) {
                        this.task.setAgentGoal();
                    }
                }

                await new Promise((resolve) => setTimeout(resolve, 10000));
                await this.checkAllPlayersPresent();

            } catch (error) {
                console.error('Error in spawn event:', error);


                if (this.heartbeatInterval) {
                    clearInterval(this.heartbeatInterval);
                    this.heartbeatInterval = null;
                }

                process.exit(0);
            }
        });
    }

    _parseDiscordMessage(message, defaultUsername = "") {
        let finalUsername = defaultUsername;
        let finalMessage = message;

        if (!message || typeof message !== 'string') {
            return { finalUsername, finalMessage };
        }


        const discordRegex = /(?:\[.*?\]\s*)?([a-zA-Z0-9_]+)\s*(?:»|>>|>|:)\s*(.*)/;
        const match = message.match(discordRegex);

        if (match) {
            finalUsername = match[1].trim() || defaultUsername;
            finalMessage = match[2].trim();
        } else if (message.includes('»')) {

            const parts = message.split('»');
            const namePart = parts[0].split(']').pop();
            finalUsername = namePart.trim() || defaultUsername;
            finalMessage = parts.slice(1).join('»').trim();
        }

        return { finalUsername, finalMessage };
    }

    async _setupEventHandlers(save_data, init_message) {
        const ignore_messages = [
            "Set own game mode to",
            "ClearLag",
            "[ClearLag]",
            "Items on ground will vanish",
            "Set the time to",
            "Set the difficulty to",
            "Teleported ",
            "Set the weather to",
            "Gamerule "
        ];


        if (!this.userRateLimits) this.userRateLimits = new Map();

        const respondFunc = async (username, message) => {
            if (message === "") return;
            if (username === this.name) return;

            const currentTime = Date.now();


            const isAllowed = await serverProxy.checkRateLimit(username, message);
            if (!isAllowed) {
                console.warn(`[Rate Limit] Dropped spam message from ${username} (Global Block).`);
                return;
            }

            // DISCORD CLEANER OPERATION
            const { finalUsername, finalMessage } = this._parseDiscordMessage(message, username);

            const escapedName = this.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const nameRegex = new RegExp(`\\b${escapedName}\\b`, 'i');

            const isMentioned = nameRegex.test(finalMessage);

            if (!isMentioned && username !== 'ADMIN') {
                return;
            }
            if (settings.only_chat_with.length > 0 && !settings.only_chat_with.includes(finalUsername) && username !== 'ADMIN') return;

            try {
                if (ignore_messages.some((m) => finalMessage.includes(m))) return;

                this.flags.shutUp = false;

                console.log(`${this.name} detected chat from: ${finalUsername} -> ${finalMessage}`);

                if (convoManager.isOtherAgent(finalUsername)) {
                    console.warn('Message from another bot ignored.');
                }
                else {
                    let translation = await handleEnglishTranslation(finalMessage);
                    this.handleMessage(finalUsername, translation);
                }
            } catch (error) {
                console.error('Error handling message:', error);
            }
        }

        this.respondFunc = respondFunc;

        this.bot.on('whisper', respondFunc);

        this.bot.on('chat', (username, message) => {
            if (serverProxy.getNumOtherAgents() > 0) return;
            respondFunc(username, message);
        });

        this.bot.autoEat.options = {
            priority: 'foodPoints',
            startAt: 14,
            bannedFood: ["rotten_flesh", "spider_eye", "poisonous_potato", "pufferfish", "chicken"]
        };

        if (save_data?.self_prompt) {
            if (init_message) {
                this.history.add('system', init_message);
            }
            await this.self_prompter.handleLoad(save_data.self_prompt, save_data.self_prompting_state);
        }
        if (save_data?.last_sender) {
            this.last_sender = save_data.last_sender;
            if (convoManager.otherAgentInGame(this.last_sender)) {
                const msg_package = {
                    message: `You have restarted and this message is auto-generated. Continue the conversation with me.`,
                    start: true
                };
                convoManager.receiveFromBot(this.last_sender, msg_package);
            }
        }
        else if (init_message) {
            await this.handleMessage('system', init_message, 2);
        }
        else {
            this.openChat("Hello world! I am " + this.name);
        }
    }

    async checkAllPlayersPresent() {
        if (!this.task || !Array.isArray(this.task.agent_names) || this.task.agent_names.length === 0) {
            return true;
        }

        const maxRetries = 15;
        const delayMs = 2000;

        for (let i = 0; i < maxRetries; i++) {
            const missingPlayers = this.task.agent_names.filter(name => !this.bot.players[name]);

            if (missingPlayers.length === 0) {
                if (i > 0) console.log(`[System] All players/bots present after waiting ${i * 2} seconds!`);
                return true;
            }

            console.log(`[System] Waiting for other players/bots to spawn: ${missingPlayers.join(', ')}... (Attempt ${i + 1}/${maxRetries})`);
            await new Promise(resolve => setTimeout(resolve, delayMs));
        }


        const finalMissing = this.task.agent_names.filter(name => !this.bot.players[name]);
        console.log(`[System] Timeout! Missing players/bots: ${finalMissing.join(', ')}`);
        this.cleanKill('Not all required players/bots are present in the world. Exiting.', 4);
        return false;
    }

    requestInterrupt() {
        this.bot.interrupt_code = true;
        this.bot.stopDigging();
        this.bot.collectBlock.cancelTask();
        this.bot.pathfinder.stop();
        this.bot.pvp.stop();
    }

    clearBotLogs() {
        this.bot.output = '';
        this.bot.interrupt_code = false;
    }

    shutUp() {
        this.flags.shutUp = true;
        if (this.self_prompter.isActive()) {
            this.self_prompter.stop(false);
        }
        convoManager.endAllConversations();
    }

    async handleMessage(source, message, max_responses = null) {
        await this.checkTaskDone();
        if (!source || !message) {
            console.warn('Received empty message from', source);
            return false;
        }

        let used_command = false;
        if (max_responses === null) {
            max_responses = settings.max_commands === -1 ? Infinity : settings.max_commands;
        }
        if (max_responses === -1) {
            max_responses = Infinity;
        }

        const self_prompt = source === 'system' || source === this.name;
        const from_other_bot = convoManager.isOtherAgent(source);

        if (!self_prompt && !from_other_bot) {
            const user_command_name = containsCommand(message);
            if (user_command_name) {
                if (!commandExists(user_command_name)) {
                    this.routeResponse(source, `Command '${user_command_name}' does not exist.`);
                    return false;
                }
                this.routeResponse(source, `*${source} used ${user_command_name.substring(1)}*`);
                if (user_command_name === '!newAction') {
                    this.history.add(source, message);
                }
                let execute_res = await executeCommand(this, message);
                if (execute_res)
                    this.routeResponse(source, execute_res);
                return true;
            }
        }

        if (from_other_bot)
            this.last_sender = source;

        message = await handleEnglishTranslation(message);
        console.log('received message from', source, ':', message);

        const checkInterrupt = () => this.self_prompter.shouldInterrupt(self_prompt) || this.flags.shutUp || convoManager.responseScheduledFor(source);

        let behavior_log = this.bot.modes.flushBehaviorLog().trim();
        if (behavior_log.length > 0) {
            const MAX_LOG = 500;
            if (behavior_log.length > MAX_LOG) {
                behavior_log = '...' + behavior_log.substring(behavior_log.length - MAX_LOG);
            }
            behavior_log = 'Recent behaviors log: \n' + behavior_log;
            await this.history.add('system', behavior_log);
        }

        await this.history.add(source, message);
        this.history.save();

        if (!self_prompt && this.self_prompter.isActive()) // message is from user during self-prompting
            max_responses = 1; // force only respond to this message, then let self-prompting take over
        for (let i = 0; i < max_responses; i++) {
            if (checkInterrupt()) break;
            let history = this.history.getHistory();
            let res = await this.prompter.promptConvo(history);

            console.log(`${this.name} full response to ${source}: ""${res}""`);

            if (res.trim().length === 0) {
                console.warn('no response')
                break;
            }

            let command_name = containsCommand(res);

            if (command_name) {
                res = truncCommandMessage(res);
                this.history.add(this.name, res);

                if (!commandExists(command_name)) {
                    this.history.add('system', `Command ${command_name} does not exist.`);
                    console.warn('Agent hallucinated command:', command_name)
                    continue;
                }

                if (checkInterrupt()) break;
                this.self_prompter.handleUserPromptedCmd(self_prompt, isAction(command_name));

                if (settings.show_command_syntax === "full") {
                    this.routeResponse(source, res);
                }
                else if (settings.show_command_syntax === "shortened") {
                    let pre_message = res.substring(0, res.indexOf(command_name)).trim();
                    let chat_message = `*used ${command_name.substring(1)}*`;
                    if (pre_message.length > 0)
                        chat_message = `${pre_message}  ${chat_message}`;
                    this.routeResponse(source, chat_message);
                }
                else {
                    let pre_message = res.substring(0, res.indexOf(command_name)).trim();
                    if (pre_message.trim().length > 0)
                        this.routeResponse(source, pre_message);
                }

                let execute_res = await executeCommand(this, res);

                console.log('Agent executed:', command_name, 'and got:', execute_res);
                used_command = true;

                if (execute_res)
                    this.history.add('system', execute_res);
                else
                    break;
            }
            else {
                this.history.add(this.name, res);
                this.routeResponse(source, res);
                break;
            }

            this.history.save();
        }

        return used_command;
    }

    async routeResponse(to_player, message) {
        if (this.flags.shutUp) return;
        let self_prompt = to_player === 'system' || to_player === this.name;
        if (self_prompt && this.last_sender) {
            to_player = this.last_sender;
        }

        if (convoManager.isOtherAgent(to_player) && convoManager.inConversation(to_player)) {
            convoManager.sendToBot(to_player, message);
        }
        else {
            this.openChat(message);
        }
    }

    async openChat(message) {
        let to_translate = message;
        let remaining = '';
        let command_name = containsCommand(message);
        let translate_up_to = command_name ? message.indexOf(command_name) : -1;
        if (translate_up_to != -1) { // don't translate the command
            to_translate = to_translate.substring(0, translate_up_to);
            remaining = message.substring(translate_up_to);
        }
        message = (await handleTranslation(to_translate)).trim() + " " + remaining;
        // newlines are interpreted as separate chats, which triggers spam filters. replace them with spaces
        message = message.replaceAll('\n', ' ');

        if (settings.only_chat_with.length > 0) {
            for (let username of settings.only_chat_with) {
                this.bot.whisper(username, message);
            }
        }
        else {
            if (settings.speak) {
                speak(to_translate, this.prompter.profile.speak_model);
            }
            if (settings.chat_ingame) { this.bot.chat(message); }
            sendOutputToServer(this.name, message);
        }
    }

    startEvents() {
        // Custom events
        this.bot.on('time', () => {
            if (this.bot.time.timeOfDay == 0)
                this.bot.emit('sunrise');
            else if (this.bot.time.timeOfDay == 6000)
                this.bot.emit('noon');
            else if (this.bot.time.timeOfDay == 12000)
                this.bot.emit('sunset');
            else if (this.bot.time.timeOfDay == 18000)
                this.bot.emit('midnight');
        });

        let prev_health = this.bot.health;
        this.bot.lastDamageTime = 0;
        this.bot.lastDamageTaken = 0;
        this.bot.on('health', () => {
            if (this.bot.health < prev_health) {
                this.bot.lastDamageTime = Date.now();
                this.bot.lastDamageTaken = prev_health - this.bot.health;
            }
            prev_health = this.bot.health;
        });
        // Logging callbacks
        this.bot.on('error', (err) => {
            console.error('Error event!', err);
        });
        // Use connection handler for runtime disconnects
        this.bot.on('end', (reason) => {
            if (!this.flags.disconnectHandled) {
                const { msg } = handleDisconnection(this.name, reason);
                this.cleanKill(msg);
            }
        });
        this.bot.on('death', () => {
            this.actions.cancelResume();
            this.actions.stop();
        });
        this.bot.on('kicked', (reason) => {
            if (!this.flags.disconnectHandled) {
                const { msg } = handleDisconnection(this.name, reason);
                this.cleanKill(msg);
            }
        });
        this.bot.on('messagestr', async (message, _, jsonMsg) => {

            console.log("[SERVER SPY] ->", message);
            // 1. Death Detection (Default)
            if (jsonMsg.translate && jsonMsg.translate.startsWith('death') && message.startsWith(this.name + ' ')) {
                console.log('Agent died: ', message);
                let death_pos = this.bot.entity.position;
                this.memory_bank.rememberPlace('last_death_position', death_pos.x, death_pos.y, death_pos.z);
                let death_pos_text = null;
                if (death_pos) {
                    death_pos_text = `x: ${death_pos.x.toFixed(2)}, y: ${death_pos.y.toFixed(2)}, z: ${death_pos.z.toFixed(2)}`;
                }
                let dimention = this.bot.game.dimension;
                this.handleMessage('system', `You died at position ${death_pos_text || "unknown"} in the ${dimention} dimension with the final message: '${message}'. Your place of death is saved as 'last_death_position' if you want to return. Previous actions were stopped and you have respawned.`);
            }

            // --- 2. SPECIAL DISCORDSRV ROUTE (FAIL-SAFE VERSION) ---
            if (message.includes('[Discord') && message.includes('»')) {
                // Rely on the unified helper
                const { finalUsername, finalMessage } = this._parseDiscordMessage(message);

                // Throw to respondFunc!
                if (this.respondFunc) {
                    this.respondFunc(finalUsername, finalMessage);
                }
            }
            // -----------------------------------------------------
        });
        this.bot.on('idle', () => {
            this.bot.clearControlStates();
            this.bot.pathfinder.stop(); // clear any lingering pathfinder
            this.bot.modes.unPauseAll();
            setTimeout(() => {
                if (this.isIdle()) {
                    this.actions.resumeAction();
                }
            }, 1000);
        });

        // Init NPC controller
        this.npc.init();

        // This update loop ensures that each update() is called one at a time, even if it takes longer than the interval
        const INTERVAL = 300;
        let last = Date.now();
        setTimeout(async () => {
            while (true) {
                let start = Date.now();
                await this.update(start - last);
                let remaining = INTERVAL - (Date.now() - start);
                if (remaining > 0) {
                    await new Promise((resolve) => setTimeout(resolve, remaining));
                }
                last = start;
            }
        }, INTERVAL);

        this.bot.emit('idle');
    }

    async update(delta) {
        await this.bot.modes.update();
        this.self_prompter.update(delta);
        await this.checkTaskDone();
    }

    isIdle() {
        return !this.actions.executing;
    }


    cleanKill(msg = 'Killing agent process...', code = 1) {
        if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
        this.history.add('system', msg);
        this.bot.chat(code > 1 ? 'Restarting.' : 'Exiting.');
        this.history.save();
        process.exit(code);
    }
    async checkTaskDone() {
        if (this.task.data) {
            let res = this.task.isDone();
            if (res) {
                await this.history.add('system', `Task ended with score : ${res.score}`);
                await this.history.save();
                // await new Promise(resolve => setTimeout(resolve, 3000))
                this.killAll();
            }
        }
    }

    killAll() {
        serverProxy.shutdown();
    }
}