export class MemoryBank {
	constructor() {
		this.memory = {};
	}

	rememberPlace(name, x, y, z) {
		this.memory[name] = [x, y, z];
	}

	recallPlace(name) {
		return this.memory[name];
	}

	// Remove a specific memory or completed quest
	forget(name) {
		if (this.memory[name]) {
			delete this.memory[name];
		}
	}

	// Prune old or completed quests to prevent memory bloat
	pruneQuests() {
		let prunedCount = 0;
		for (const key of Object.keys(this.memory)) {
			const item = this.memory[key];
			// Adjust this condition based on the actual quest data structure
			if (key.includes('quest') || (item && item.status === 'completed')) {
				delete this.memory[key];
				prunedCount++;
			}
		}
		if (prunedCount > 0) {
			console.log(`[MemoryBank] Successfully pruned ${prunedCount} completed quests.`);
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