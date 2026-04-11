import { writeFileSync, readFileSync, mkdirSync, existsSync, promises as fsPromises } from 'fs';
import { NPCData } from './npc/data.js';
import settings from './settings.js';


export class History {
    constructor(agent) {
        this.agent = agent;
        this.name = agent.name;
        this.memory_fp = `./bots/${this.name}/memory.json`;
        this.full_history_fp = undefined;

        mkdirSync(`./bots/${this.name}/histories`, { recursive: true });

        this.turns = [];

        // Natural language memory as a summary of recent messages + previous memory
        this.memory = '';

        // Maximum number of messages to keep in context before saving chunk to memory
        this.max_messages = settings.max_messages;

        // Number of messages to remove from current history and save into memory
        this.summary_chunk_size = 10;
        // chunking reduces expensive calls to promptMemSaving and appendFullHistory
    }

    getHistory() { // expects an Examples object
        return JSON.parse(JSON.stringify(this.turns));
    }

    async summarizeMemories(turns) {
        console.log("Storing memories...");
        this.memory = await this.agent.prompter.promptMemSaving(turns);

        // FIXED: Proactive Auto-Compression before hitting the hard limit (Bug #38)
        let compressAttempts = 0;
        while (this.memory && this.memory.length > 500 && compressAttempts < 2) {
            console.log(`[History] Memory too large (${this.memory.length} chars). Triggering active auto-compression...`);

            const compressMsg = [{
                role: 'user',
                content: `Condense this text to strictly UNDER 500 characters. Keep only the most vital facts and omit conversational filler:\n\n${this.memory}`
            }];

            try {
                let compressed = await this.agent.prompter.chat_model.sendRequest(compressMsg, "You are a highly efficient text compressor. Output ONLY the compressed text.");

                // Strip out reasoning tags if using models like DeepSeek
                if (compressed?.includes('</think>')) {
                    compressed = compressed.split('</think>')[1].trim();
                }
                this.memory = compressed.trim();
            } catch (err) {
                console.warn('[History] Auto-compression failed, falling back to hard truncation.');
                break;
            }
            compressAttempts++;
        }

        // Fallback hard truncation just in case the LLM stubbornly refuses to shorten it
        if (this.memory && this.memory.length > 500) {
            this.memory = this.memory.slice(0, 497) + '...';
        }

        console.log("Memory updated to: ", this.memory);
    }

    async appendFullHistory(to_store) {
        // FIXED: Inisialisasi Buffer di memori
        if (!this._historyBuffer) {
            this._historyBuffer = [];
            this._lastFlushTime = Date.now();
        }

        // Tumpuk data di memori, JANGAN langsung I/O ke disk
        this._historyBuffer.push(...to_store);

        const now = Date.now();
        // Flush (Tulis ke disk) HANYA JIKA: ada >= 50 pesan di buffer, ATAU sudah lewat 60 detik
        if (this._historyBuffer.length >= 50 || now - this._lastFlushTime > 60000) {
            await this.flushHistory();
        }
    }

    // FIXED: Fungsi baru untuk Bulk Write meminimalisir Bottleneck I/O (Performa Multi-Agent)
    async flushHistory() {
        if (!this._historyBuffer || this._historyBuffer.length === 0) return;

        if (this.full_history_fp === undefined) {
            const string_timestamp = new Date().toLocaleString().replace(/[/:]/g, '-').replace(/ /g, '').replace(/,/g, '_');
            this.full_history_fp = `./bots/${this.name}/histories/${string_timestamp}.json`;
            await fsPromises.writeFile(this.full_history_fp, '[]', 'utf8');
        }

        try {
            // Baca, tambah, tulis 1x saja untuk puluhan pesan
            const data = await fsPromises.readFile(this.full_history_fp, 'utf8');
            let full_history = JSON.parse(data);

            full_history.push(...this._historyBuffer);

            await fsPromises.writeFile(this.full_history_fp, JSON.stringify(full_history, null, 4), 'utf8');

            // Kosongkan buffer setelah sukses
            const writtenCount = this._historyBuffer.length;
            this._historyBuffer = [];
            this._lastFlushTime = Date.now();
            console.log(`[History] Flushed ${writtenCount} buffered messages to disk for ${this.name}`);
        } catch (err) {
            console.error(`Error flushing ${this.name}'s full history file: ${err.message}`);
        }
    }

    async add(name, content) {
        let role = 'assistant';
        if (name === 'system') {
            role = 'system';
        }
        else if (name !== this.name) {
            role = 'user';
            content = `${name}: ${content}`;
        }
        this.turns.push({ role, content });

        if (this.turns.length >= this.max_messages) {
            let chunk = this.turns.splice(0, this.summary_chunk_size);
            while (this.turns.length > 0 && this.turns[0].role === 'assistant')
                chunk.push(this.turns.shift()); // remove until turns starts with system/user message

            await this.summarizeMemories(chunk);
            await this.appendFullHistory(chunk);
        }
    }

    async save() {
        try {
            const data = {
                name: this.agent.name,
                memory: this.memory,
                turns: this.turns,
                self_prompting_state: this.agent.self_prompter.state,
                self_prompt: this.agent.self_prompter.isStopped() ? null : this.agent.self_prompter.prompt,
                taskStart: this.agent.task.taskStartTime,
                last_sender: this.agent.last_sender,
                // FIXED: Include quest board in memory persistence (Bug #39)
                quests: this.agent.memory_bank.quests || []
            };
            // FIXED: Gunakan asynchronous writeFile untuk mencegah blocking event loop
            await fsPromises.writeFile(this.memory_fp, JSON.stringify(data, null, 2));
            console.log('Saved memory to:', this.memory_fp);

            if (this._historyBuffer && this._historyBuffer.length > 0) {
                if (Date.now() - (this._lastFlushTime || 0) > 15000) {
                    await this.flushHistory();
                }
            }

        } catch (error) {
            console.error('Failed to save history:', error);
            throw error;
        }
    }

    load() {
        try {
            if (!existsSync(this.memory_fp)) {
                console.log('No memory file found.');
                return null;
            }
            const data = JSON.parse(readFileSync(this.memory_fp, 'utf8'));
            this.memory = data.memory || '';
            this.turns = data.turns || [];
            console.log('Loaded memory:', this.memory);
            return data;
        } catch (error) {
            console.error('Failed to load history:', error);
            throw error;
        }
    }

    clear() {
        this.turns = [];
        this.memory = '';
    }
}