export class MemoryBank {
	constructor() {
		this.memory = {};
		// PHASE 1: Add dedicated memory for the Quest Board
		this.quests = [];
	}

	rememberPlace(name, x, y, z) {
		this.memory[name] = [x, y, z];
	}

	recallPlace(name) {
		return this.memory[name];
	}

	forget(name) {
		if (this.memory[name]) {
			delete this.memory[name];
		}
	}

	// === NEW FEATURE: QUEST & SUBTASK SYSTEM ===

	// 1. Register a new quest with its subtasks and priority
	addQuest(task, subtasks, priority = 2) {
		// Remove existing quest with the same name to prevent duplicates
		this.quests = this.quests.filter(q => q.task !== task);
		this.quests.push({ task, subtasks, priority, status: 'pending' });

		// Sort by priority: 1 (Highest) will be at the top
		this.quests.sort((a, b) => a.priority - b.priority);
		console.log(`[QuestManager] New Quest Added: ${task} | Priority: ${priority}`);
	}

	// 2. Mark completed subtask and move to the next one
	completeNextSubtask() {
		const active = this.getActiveQuest();
		if (active && active.subtasks.length > 0) {
			const finished = active.subtasks.shift(); // Remove the first task
			console.log(`[QuestManager] Subtask completed: ${finished}`);

			// If subtasks are empty, the main quest is completed
			if (active.subtasks.length === 0) {
				active.status = 'completed';
				console.log(`[QuestManager] Main Quest '${active.task}' is fully completed!`);
				this.pruneQuests(); // Automatically clean the quest board
			}
			return finished;
		}
		return null;
	}

	// 3. Get the current highest priority quest
	getActiveQuest() {
		const pending = this.quests.filter(q => q.status === 'pending');
		return pending.length > 0 ? pending[0] : null;
	}

	// 4. Translate Quest JSON to text for the AI's prompt
	getQuestBoard() {
		const active = this.getActiveQuest();
		if (!active) return ""; // If idle, do not fill the AI's context

		return `\n[URGENT QUEST BOARD]\n- Goal: ${active.task}\n- CURRENT FOCUS: ${active.subtasks[0]}\n- Pending Next: ${active.subtasks.slice(1).join(', ') || 'None'}\n*INSTRUCTION: Focus ONLY on achieving the 'CURRENT FOCUS'. When it is done, use command !nextSubtask.*\n`;
	}
	// ==========================================

	// Upgraded built-in Prune feature
	pruneQuests() {
		let prunedCount = 0;

		// Clean obsolete memories
		for (const key of Object.keys(this.memory)) {
			const item = this.memory[key];
			if (key.includes('quest') || (item && item.status === 'completed')) {
				delete this.memory[key];
				prunedCount++;
			}
		}

		// Clean completed quests array
		const initialLen = this.quests.length;
		this.quests = this.quests.filter(q => q.status !== 'completed');
		prunedCount += (initialLen - this.quests.length);

		if (prunedCount > 0) {
			console.log(`[MemoryBank] Successfully pruned ${prunedCount} completed quests/memories.`);
		}
		return prunedCount;
	}

	getJson() {
		return this.memory;
	}

	loadJson(json) {
		this.memory = json;
	}

	getKeys() {
		return Object.keys(this.memory).join(', ');
	}
}