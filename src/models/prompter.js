import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import { Examples } from '../utils/examples.js';
import { getCommandDocs } from '../agent/commands/index.js';
import { SkillLibrary } from "../agent/library/skill_library.js";
import { stringifyTurns } from '../utils/text.js';
import { getCommand } from '../agent/commands/index.js';
import settings from '../agent/settings.js';
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { selectAPI, createModel } from './_model_map.js';
import { serverProxy } from '../agent/mindserver_proxy.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export class Prompter {
    constructor(agent, profile) {
        this.agent = agent;
        this.profile = profile;
        let default_profile = JSON.parse(readFileSync('./profiles/defaults/_default.json', 'utf8'));
        let base_fp = '';
        if (settings.base_profile.includes('survival')) {
            base_fp = './profiles/defaults/survival.json';
        } else if (settings.base_profile.includes('assistant')) {
            base_fp = './profiles/defaults/assistant.json';
        } else if (settings.base_profile.includes('creative')) {
            base_fp = './profiles/defaults/creative.json';
        } else if (settings.base_profile.includes('god_mode')) {
            base_fp = './profiles/defaults/god_mode.json';
        }
        let base_profile = JSON.parse(readFileSync(base_fp, 'utf8'));

        for (let key in default_profile) {
            if (base_profile[key] === undefined)
                base_profile[key] = default_profile[key];
        }
        for (let key in base_profile) {
            if (this.profile[key] === undefined)
                this.profile[key] = base_profile[key];
        }

        this.convo_examples = null;
        this.coding_examples = null;

        let name = this.profile.name;
        this.cooldown = this.profile.cooldown ? this.profile.cooldown : 0;
        this.last_prompt_time = 0;
        this.awaiting_coding = false;

        let max_tokens = null;
        if (this.profile.max_tokens)
            max_tokens = this.profile.max_tokens;

        let chat_model_profile = selectAPI(this.profile.model);
        this.chat_model = createModel(chat_model_profile);

        if (this.profile.code_model) {
            let code_model_profile = selectAPI(this.profile.code_model);
            this.code_model = createModel(code_model_profile);
        }
        else {
            this.code_model = this.chat_model;
        }

        if (this.profile.vision_model) {
            let vision_model_profile = selectAPI(this.profile.vision_model);
            this.vision_model = createModel(vision_model_profile);
        }
        else {
            this.vision_model = this.chat_model;
        }


        let embedding_model_profile = null;
        if (this.profile.embedding) {
            try {
                embedding_model_profile = selectAPI(this.profile.embedding);
            } catch (e) {
                embedding_model_profile = null;
            }
        }
        this.embedding_model = embedding_model_profile
            ? createModel(embedding_model_profile)
            : null;

        this.skill_libary = new SkillLibrary(agent, this.embedding_model);
        mkdirSync(`./bots/${name}`, { recursive: true });
        writeFileSync(`./bots/${name}/last_profile.json`, JSON.stringify(this.profile, null, 4), (err) => {
            if (err) {
                throw new Error('Failed to save profile:', err);
            }
            console.log("Copy profile saved.");
        });
    }

    getName() {
        return this.profile.name;
    }

    getInitModes() {
        return this.profile.modes;
    }

    async initExamples() {
        try {
            this.convo_examples = new Examples(this.embedding_model, settings.num_examples);
            this.coding_examples = new Examples(this.embedding_model, settings.num_examples);

            await Promise.all([
                this.convo_examples.load(this.profile.conversation_examples),
                this.coding_examples.load(this.profile.coding_examples),
                this.skill_libary.initSkillLibrary()
            ]).catch(error => {
                console.error('Failed to initialize examples. Error details:', error);
                console.error('Stack trace:', error.stack);
                throw error;
            });

            console.log('Examples initialized.');
        } catch (error) {
            console.error('Failed to initialize examples:', error);
            console.error('Stack trace:', error.stack);
            throw error;
        }
    }

    async replaceStrings(prompt, messages, examples = null, to_summarize = [], last_goals = null) {
        if (!this.stringCache) this.stringCache = new Map();
        const now = Date.now();

        for (const [k, v] of this.stringCache.entries()) {
            if (now - v.time > 30000) {
                this.stringCache.delete(k);
            }
        }

        const getCached = async (key, ttl_ms, fetcher) => {
            if (this.stringCache.has(key)) {
                const cached = this.stringCache.get(key);
                if (now - cached.time < ttl_ms) {
                    return cached.value;
                }
            }

            const MAX_CACHE_SIZE = 10;
            if (this.stringCache.size >= MAX_CACHE_SIZE) {
                const oldestKey = this.stringCache.keys().next().value;
                this.stringCache.delete(oldestKey);
            }

            const val = await fetcher();
            this.stringCache.set(key, { time: now, value: val });
            return val;
        };

        prompt = prompt.replaceAll('$NAME', this.agent.name);

        if (prompt.includes('$STATS')) {
            let stats = await getCached('stats', 15000, async () => {
                let s = await getCommand('!stats').perform(this.agent) + '\n';
                s += await getCommand('!entities').perform(this.agent) + '\n';
                s += await getCommand('!nearbyBlocks').perform(this.agent);
                return s;
            });
            prompt = prompt.replaceAll('$STATS', stats);
        }

        if (prompt.includes('$INVENTORY')) {
            let inventory = await getCached('inventory', 15000, async () => {
                return await getCommand('!inventory').perform(this.agent);
            });
            prompt = prompt.replaceAll('$INVENTORY', inventory);
        }
        if (prompt.includes('$ACTION')) {
            prompt = prompt.replaceAll('$ACTION', this.agent.actions.currentActionLabel);
        }
        if (prompt.includes('$COMMAND_DOCS')) {
            let docs = getCommandDocs(this.agent);

            const last_user_msg = messages.slice().reverse().find(msg => msg.role !== 'system')?.content || '';
            if (this.agent.learned_skills && last_user_msg) {
                let relevant_skills = await this.agent.learned_skills.getFormattedSkills(last_user_msg);
                if (!relevant_skills.includes("No relevant")) {
                    docs += "\n\n" + relevant_skills;
                }
            }

            if (this.agent.memory_bank) {
                const quests = this.agent.memory_bank.quests;
                if (Array.isArray(quests) && quests.length > 0) {
                    docs += this.agent.memory_bank.getQuestBoard();
                }
            }

            prompt = prompt.replaceAll('$COMMAND_DOCS', docs);
        }
        if (prompt.includes('$CODE_DOCS')) {
            const code_task_content = messages.slice().reverse().find(msg =>
                msg.role !== 'system' && msg.content.includes('!newAction(')
            )?.content?.match(/!newAction\((.*?)\)/)?.[1] || '';

            prompt = prompt.replaceAll(
                '$CODE_DOCS',
                await this.skill_libary.getRelevantSkillDocs(code_task_content, settings.relevant_docs_count)
            );
        }
        if (prompt.includes('$EXAMPLES') && examples !== null)
            prompt = prompt.replaceAll('$EXAMPLES', await examples.createExampleMessage(messages));
        if (prompt.includes('$MEMORY'))
            prompt = prompt.replaceAll('$MEMORY', this.agent.history.memory);
        if (prompt.includes('$TO_SUMMARIZE'))
            prompt = prompt.replaceAll('$TO_SUMMARIZE', stringifyTurns(to_summarize));
        if (prompt.includes('$CONVO'))
            prompt = prompt.replaceAll('$CONVO', 'Recent conversation:\n' + stringifyTurns(messages));
        if (prompt.includes('$SELF_PROMPT')) {
            let self_prompt = !this.agent.self_prompter.isStopped() ? `YOUR CURRENT ASSIGNED GOAL: "${this.agent.self_prompter.prompt}"\n` : '';
            prompt = prompt.replaceAll('$SELF_PROMPT', self_prompt);
        }
        if (prompt.includes('$LAST_GOALS')) {
            let goal_text = '';
            for (let goal in last_goals) {
                if (last_goals[goal])
                    goal_text += `You recently successfully completed the goal ${goal}.\n`
                else
                    goal_text += `You recently failed to complete the goal ${goal}.\n`
            }
            prompt = prompt.replaceAll('$LAST_GOALS', goal_text.trim());
        }
        if (prompt.includes('$BLUEPRINTS')) {
            if (this.agent.npc.constructions) {
                let blueprints = '';
                for (let blueprint in this.agent.npc.constructions) {
                    blueprints += blueprint + ', ';
                }
                prompt = prompt.replaceAll('$BLUEPRINTS', blueprints.slice(0, -2));
            }
        }

        let remaining = prompt.match(/\$[A-Z_]+/g);
        if (remaining !== null) {
            console.warn('Unknown prompt placeholders:', remaining.join(', '));
        }
        return prompt;
    }

    async checkCooldown() {
        const minWait = this.cooldown > 0 ? this.cooldown : 1000;
        const currentTime = Date.now();
        const elapsed = currentTime - this.last_prompt_time;

        if (elapsed < minWait) {
            const sleepTime = minWait - elapsed;
            if (sleepTime > 100) {
                console.log(`[Prompter] Throttling local request: Waiting ${sleepTime}ms...`);
            }
            await new Promise(r => setTimeout(r, sleepTime));
        }


        this.last_prompt_time = Date.now();
    }

    async promptConvo(messages) {
        this.most_recent_msg_time = Date.now();
        let current_msg_time = this.most_recent_msg_time;

        for (let i = 0; i < 3; i++) {
            await this.checkCooldown();
            if (current_msg_time !== this.most_recent_msg_time) {
                return '';
            }

            let prompt = this.profile.conversing;
            prompt = await this.replaceStrings(prompt, messages, this.convo_examples);
            let generation;

            try {
                generation = await this.chat_model.sendRequest(messages, prompt);
                if (typeof generation !== 'string') {
                    console.error('Error: Generated response is not a string', generation);
                    throw new Error('Generated response is not a string');
                }
                console.log("Generated response:", generation);
                await this._saveLog(prompt, messages, generation, 'conversation');

            } catch (error) {
                console.error('Error during message generation or file writing:', error.message || error);

                const status = error.status || error.response?.status || error.code || error.statusCode;

                const fatalCodes = [400, 401, 403, 404, 422];

                if (fatalCodes.includes(status) || String(error).includes('API key')) {
                    console.error(`[Prompter] 🚨 FATAL API ERROR (${status}). Aborting retry to prevent blocking or waste.`);
                    return '';
                }

                if (i < 2) {
                    const backoffTime = 2000 * Math.pow(2, i);
                    console.warn(`[Prompter] ⚠️ Temporary API Error/Rate Limit (${status || 'Network'}). Retrying in ${backoffTime}ms... (Attempt ${i + 1}/3)`);
                    await new Promise(resolve => setTimeout(resolve, backoffTime));
                }
                continue;
            }

            if (generation?.includes('(FROM OTHER BOT)')) {
                console.warn('LLM hallucinated message as another bot. Trying again...');

                if (i < 2) {
                    const backoffTime = 1000 * Math.pow(2, i);
                    console.warn(`[Prompter] Hallucination detected. Retrying in ${backoffTime}ms... (Attempt ${i + 1}/3)`);
                    await new Promise(resolve => setTimeout(resolve, backoffTime));
                }
                continue;
            }

            if (current_msg_time !== this.most_recent_msg_time) {
                console.warn(`${this.agent.name} received new message while generating, discarding old response.`);
                return '';
            }

            if (generation?.includes('</think>')) {
                const [_, afterThink] = generation.split('</think>')
                generation = afterThink.trim();
            }

            return generation;
        }

        return '';
    }

    async promptCoding(messages) {
        if (this.awaiting_coding) {
            console.warn('Already awaiting coding response, returning no response.');
            return '```//no response```';
        }
        this.awaiting_coding = true;
        await this.checkCooldown();
        let prompt = this.profile.coding;
        prompt = await this.replaceStrings(prompt, messages, this.coding_examples);

        let resp = await this.code_model.sendRequest(messages, prompt);
        this.awaiting_coding = false;
        await this._saveLog(prompt, messages, resp, 'coding');
        return resp;
    }

    async promptMemSaving(to_summarize) {
        await this.checkCooldown();
        let prompt = this.profile.saving_memory;
        prompt = await this.replaceStrings(prompt, null, null, to_summarize);
        let resp = await this.chat_model.sendRequest([], prompt);
        await this._saveLog(prompt, to_summarize, resp, 'memSaving');
        if (resp?.includes('</think>')) {
            const [_, afterThink] = resp.split('</think>')
            resp = afterThink;
        }
        return resp;
    }

    async promptShouldRespondToBot(new_message) {
        await this.checkCooldown();
        let prompt = this.profile.bot_responder;
        let messages = this.agent.history.getHistory();
        messages.push({ role: 'user', content: new_message });
        prompt = await this.replaceStrings(prompt, null, null, messages);
        let res = await this.chat_model.sendRequest([], prompt);
        return res.trim().toLowerCase() === 'respond';
    }

    async promptVision(messages, imageBuffer) {
        await this.checkCooldown();
        let prompt = this.profile.image_analysis;
        prompt = await this.replaceStrings(prompt, messages, null, null, null);
        return await this.vision_model.sendVisionRequest(messages, prompt, imageBuffer);
    }

    async promptGoalSetting(messages, last_goals) {
        let system_message = this.profile.goal_setting;
        system_message = await this.replaceStrings(system_message, messages);

        let user_message = 'Use the below info to determine what goal to target next\n\n';
        user_message += '$LAST_GOALS\n$STATS\n$INVENTORY\n$CONVO'
        user_message = await this.replaceStrings(user_message, messages, null, null, last_goals);
        let user_messages = [{ role: 'user', content: user_message }];

        let res = await this.chat_model.sendRequest(user_messages, system_message);

        let goal = null;
        try {
            let data = res.split('```')[1].replace('json', '').trim();
            goal = JSON.parse(data);
        } catch (err) {
            console.log('Failed to parse goal:', res, err);
        }
        if (!goal || !goal.name || !goal.quantity || isNaN(parseInt(goal.quantity))) {
            console.log('Failed to set goal:', res);
            return null;
        }
        goal.quantity = parseInt(goal.quantity);
        return goal;
    }

    async _saveLog(prompt, messages, generation, tag) {
        if (!settings.log_all_prompts)
            return;
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        let logEntry;
        let task_id = this.agent.task.task_id;
        if (task_id == null) {
            logEntry = `[${timestamp}] \nPrompt:\n${prompt}\n\nConversation:\n${JSON.stringify(messages, null, 2)}\n\nResponse:\n${generation}\n\n`;
        } else {
            logEntry = `[${timestamp}] Task ID: ${task_id}\nPrompt:\n${prompt}\n\nConversation:\n${JSON.stringify(messages, null, 2)}\n\nResponse:\n${generation}\n\n`;
        }
        const logFile = `${tag}_${timestamp}.txt`;
        await this._saveToFile(logFile, logEntry);
    }

    async _saveToFile(logFile, logEntry) {
        let task_id = this.agent.task.task_id;
        let logDir;
        if (task_id == null) {
            logDir = path.join(__dirname, `../../bots/${this.agent.name}/logs`);
        } else {
            logDir = path.join(__dirname, `../../bots/${this.agent.name}/logs/${task_id}`);
        }

        await fs.mkdir(logDir, { recursive: true });

        logFile = path.join(logDir, logFile);
        await fs.appendFile(logFile, String(logEntry), 'utf-8');
    }
}
