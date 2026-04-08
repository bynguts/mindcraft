import fs from 'fs';
import path from 'path';

export class LearnedSkills {
    constructor(agent) {
        this.agent = agent;
        // Path to the saved_skills folder and metadata.json
        this.dirPath = path.join(process.cwd(), 'saved_skills');
        this.metadataPath = path.join(this.dirPath, 'metadata.json');
        this.metadata = {};

        this.init();
    }

    // Initialize the library: create folder/file if they don't exist
    init() {
        if (!fs.existsSync(this.dirPath)) {
            fs.mkdirSync(this.dirPath, { recursive: true });
        }

        if (fs.existsSync(this.metadataPath)) {
            const rawData = fs.readFileSync(this.metadataPath, 'utf8');
            try {
                this.metadata = JSON.parse(rawData);
                console.log(`[LearnedSkills] Loaded ${Object.keys(this.metadata).length} skills metadata.`);
            } catch (error) {
                console.error('[LearnedSkills] Error parsing metadata.json, creating a new one.');
                this.metadata = {};
                this.save();
            }
        } else {
            this.save(); // Create empty metadata.json
        }
    }

    // Save current metadata to JSON
    save() {
        fs.writeFileSync(this.metadataPath, JSON.stringify(this.metadata, null, 4));
    }

    // Add a new skill or update its description/tags
    registerSkill(skillName, description, tags = []) {
        if (!this.metadata[skillName]) {
            this.metadata[skillName] = {
                description: description,
                tags: tags,
                successRate: 1.0, // Starts at 100% confidence
                usageCount: 0
            };
        } else {
            this.metadata[skillName].description = description;
            this.metadata[skillName].tags = tags;
        }
        this.save();
        console.log(`[LearnedSkills] Registered skill: ${skillName}`);
    }

    // Update the success rate after the bot attempts to use the skill
    updateSkillResult(skillName, isSuccess) {
        if (this.metadata[skillName]) {
            const skill = this.metadata[skillName];

            let currentWins = skill.successRate * skill.usageCount;
            if (isSuccess) currentWins += 1;

            skill.usageCount += 1;
            skill.successRate = Number((currentWins / skill.usageCount).toFixed(2));

            this.save();
            console.log(`[LearnedSkills] Updated ${skillName}: Success Rate is now ${skill.successRate} after ${skill.usageCount} uses.`);
        }
    }

    // Search skills based on a query (tag or keyword in description)
    searchRelevantSkills(query) {
        const lowerQuery = query.toLowerCase();
        let results = [];

        for (const [skillName, data] of Object.entries(this.metadata)) {
            const matchTag = data.tags.some(tag => tag.toLowerCase().includes(lowerQuery));
            const matchDesc = data.description.toLowerCase().includes(lowerQuery);
            const matchName = skillName.toLowerCase().includes(lowerQuery);

            if (matchTag || matchDesc || matchName) {
                results.push({ name: skillName, ...data });
            }
        }

        results.sort((a, b) => {
            if (b.successRate !== a.successRate) {
                return b.successRate - a.successRate;
            }
            return b.usageCount - a.usageCount;
        });

        return results;
    }

    getFormattedSkills(query) {
        const skills = this.searchRelevantSkills(query);
        if (skills.length === 0) return "No relevant saved skills found.";

        let output = `Relevant saved skills for '${query}':\n`;
        skills.forEach(s => {
            output += `- ${s.name}: ${s.description} (Success: ${s.successRate * 100}%, Uses: ${s.usageCount})\n`;
        });
        return output;
    }
}