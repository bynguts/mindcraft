import fs from 'fs';
import path from 'path';

export class LearnedSkills {
    constructor(agent) {
        this.agent = agent;
        // Use standard paths consistent with the project structure
        this.dirPath = path.join(process.cwd(), 'bots', 'saved_skills');
        this.metadataPath = path.join(this.dirPath, 'metadata.json');
        this.metadata = {};

        this.init();
    }

    init() {
        if (!fs.existsSync(this.dirPath)) {
            fs.mkdirSync(this.dirPath, { recursive: true });
        }

        this.reload();

        if (Object.keys(this.metadata).length === 0 && !fs.existsSync(this.metadataPath)) {
            this.save();
        } else {
            console.log(`[LearnedSkills] Loaded ${Object.keys(this.metadata).length} skills metadata.`);
        }
    }

    // FIXED: Synchronize state before modifying to prevent race conditions across agents
    reload() {
        if (fs.existsSync(this.metadataPath)) {
            const rawData = fs.readFileSync(this.metadataPath, 'utf8');
            try {
                this.metadata = JSON.parse(rawData);
            } catch (error) {
                console.error('[LearnedSkills] Error parsing metadata.json during reload. Keeping cached state.');
            }
        }
    }

    // FIXED: Implemented POSIX Atomic Write pattern to prevent JSON corruption during concurrent writes
    save() {
        const tmpPath = `${this.metadataPath}.tmp`;
        try {
            // Write to a temporary file first
            fs.writeFileSync(tmpPath, JSON.stringify(this.metadata, null, 4));
            // Rename is an atomic OS operation, guaranteeing file integrity
            fs.renameSync(tmpPath, this.metadataPath);
        } catch (err) {
            console.error('[LearnedSkills] Failed to save metadata atomically:', err);
        }
    }

    // Register a new skill with explicit success/fail tracking
    registerSkill(skillName, description, tags = []) {
        this.reload(); // Sync with other agents before writing

        if (!this.metadata[skillName]) {
            this.metadata[skillName] = {
                description: description,
                tags: tags,
                success_count: 0,
                fail_count: 0,
                learned_at: new Date().toISOString()
            };
        } else {
            this.metadata[skillName].description = description;
            this.metadata[skillName].tags = tags;
        }
        this.save();
        console.log(`[LearnedSkills] Registered skill: ${skillName}`);
    }

    // PHASE 3: Update performance and auto-delete low-quality skills
    updateSkillPerformance(skillName, isSuccess) {
        this.reload(); // Sync with other agents to ensure accurate usage counts

        if (!this.metadata[skillName]) return;

        const skill = this.metadata[skillName];
        if (isSuccess) {
            skill.success_count++;
        } else {
            skill.fail_count++;
        }

        const totalUses = skill.success_count + skill.fail_count;
        const successRate = skill.success_count / totalUses;

        // CRITICAL LOGIC: Auto-delete if usage >= 3 and success rate < 30%
        if (totalUses >= 3 && successRate < 0.3) {
            console.warn(`[LearnedSkills] DELETING low-quality skill: ${skillName} (Rate: ${(successRate * 100).toFixed(1)}%)`);

            // Delete the physical JS file
            const filePath = path.join(this.dirPath, `${skillName}.js`);
            if (fs.existsSync(filePath)) {
                fs.unlinkSync(filePath);
            }

            // Remove from metadata
            delete this.metadata[skillName];
        } else {
            console.log(`[LearnedSkills] Updated ${skillName}: Success Rate is ${(successRate * 100).toFixed(1)}% after ${totalUses} uses.`);
        }

        this.save();
    }

    searchRelevantSkills(query) {
        const lowerQuery = query.toLowerCase();
        let results = [];

        for (const [skillName, data] of Object.entries(this.metadata)) {
            const matchTag = data.tags.some(tag => tag.toLowerCase().includes(lowerQuery));
            const matchDesc = data.description.toLowerCase().includes(lowerQuery);
            const matchName = skillName.toLowerCase().includes(lowerQuery);

            if (matchTag || matchDesc || matchName) {
                const total = data.success_count + data.fail_count;
                const rate = total > 0 ? (data.success_count / total) : 1.0;
                results.push({ name: skillName, ...data, rate, total });
            }
        }

        results.sort((a, b) => b.rate - a.rate || b.total - a.total);
        return results;
    }

    getFormattedSkills(query) {
        const skills = this.searchRelevantSkills(query);
        if (skills.length === 0) return "No relevant saved skills found.";

        let output = `Relevant saved skills for '${query}':\n`;
        skills.forEach(s => {
            output += `- ${s.name}: ${s.description} (Success: ${(s.rate * 100).toFixed(0)}%, Uses: ${s.total})\n`;
        });
        return output;
    }
}