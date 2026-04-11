import fs from 'fs';
import path from 'path';
import { THRESHOLDS } from '../utils/constants.js';

export class LearnedSkills {
    constructor(agent) {
        this.agent = agent;
        this.dirPath = path.join(process.cwd(), 'bots', 'saved_skills');
        this.metadataPath = path.join(this.dirPath, 'metadata.json');
        this.vectorCachePath = path.join(this.dirPath, 'vector_cache.json');
        this.metadata = {};
        this.vectorCache = {};

        this.init();
    }

    init() {

        try {
            if (!fs.existsSync(this.dirPath)) {
                fs.mkdirSync(this.dirPath, { recursive: true });
            }
        } catch (err) {
            console.error(`[LearnedSkills] Critical Error: Failed to create directory at ${this.dirPath}. Permission denied? Error:`, err.message);
            this.disabled = true;
            return;
        }

        this.reload();


        let needsMigration = false;
        for (const [sName, sData] of Object.entries(this.metadata)) {
            if (sData.embedding) {
                delete sData.embedding;
                needsMigration = true;
            }
        }

        if (Object.keys(this.metadata).length === 0 && !fs.existsSync(this.metadataPath)) {
            this.save();
        } else if (needsMigration) {
            console.log('[LearnedSkills] Migrating old metadata: Cleaned up bloated embedding data.');
            this.save();
        } else {
            console.log(`[LearnedSkills] Loaded ${Object.keys(this.metadata).length} skills metadata.`);
        }
    }

    reload() {

        if (fs.existsSync(this.metadataPath)) {
            try {
                this.metadata = JSON.parse(fs.readFileSync(this.metadataPath, 'utf8'));
            } catch (e) {
                console.error('[LearnedSkills] Error parsing metadata.json', e);
            }
        }
        if (fs.existsSync(this.vectorCachePath)) {
            try {
                this.vectorCache = JSON.parse(fs.readFileSync(this.vectorCachePath, 'utf8'));
            } catch (e) {
                console.error('[LearnedSkills] Error parsing vector_cache.json', e);
            }
        }
    }


    save() {

        if (this.disabled) return;

        const tmpPath = `${this.metadataPath}.tmp`;
        try {
            fs.writeFileSync(tmpPath, JSON.stringify(this.metadata, null, 4));
            fs.renameSync(tmpPath, this.metadataPath);
        } catch (err) {
            console.error('[LearnedSkills] Failed to save metadata atomically:', err);
        }

        const tmpVector = `${this.vectorCachePath}.tmp`;
        try {
            fs.writeFileSync(tmpVector, JSON.stringify(this.vectorCache));
            fs.renameSync(tmpVector, this.vectorCachePath);
        } catch (err) {
            console.error('[LearnedSkills] Failed to save vector cache:', err);
        }
    }


    registerSkill(skillName, description, embedding, tags = [], dependencies = []) {
        this.reload();


        this.metadata[skillName] = {
            description: description,
            tags: tags,
            dependencies: dependencies,
            success_count: 0,
            fail_count: 0,
            learned_at: new Date().toISOString()
        };


        this.vectorCache[skillName] = embedding;

        this.save();
        console.log(`[LearnedSkills] Registered skill: ${skillName}`);
    }

    updateSkillPerformance(skillName, isSuccess) {
        this.reload();

        if (!this.metadata[skillName]) return;

        const skill = this.metadata[skillName];
        if (isSuccess) {
            skill.success_count++;
        } else {
            skill.fail_count++;
        }

        const totalUses = skill.success_count + skill.fail_count;
        const successRate = skill.success_count / totalUses;

        if (totalUses >= THRESHOLDS.SKILL_MIN_USES_EVAL && successRate < THRESHOLDS.SKILL_SUCCESS_MIN) {
            console.warn(`[LearnedSkills] DELETING low-quality skill: ${skillName} (Rate: ${(successRate * 100).toFixed(1)}%)`);


            const filePath = path.join(this.dirPath, `${skillName}.js`);

            try {
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                }
            } catch (err) {

                if (err.code !== 'ENOENT') {
                    console.error(`[LearnedSkills] Failed to delete file ${filePath}:`, err);
                } else {
                    console.warn(`[LearnedSkills] File ${filePath} already deleted by another process (Race condition mitigated).`);
                }
            }

            delete this.metadata[skillName];
        } else {
            console.log(`[LearnedSkills] Updated ${skillName}: Success Rate is ${(successRate * 100).toFixed(1)}% after ${totalUses} uses.`);
        }

        this.save();
    }


    cosineSimilarity(vecA, vecB) {
        let dotProduct = 0, normA = 0, normB = 0;
        for (let i = 0; i < vecA.length; i++) {
            dotProduct += vecA[i] * vecB[i];
            normA += vecA[i] * vecA[i];
            normB += vecB[i] * vecB[i];
        }
        if (normA === 0 || normB === 0) return 0;
        return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    }


    async searchRelevantSkills(query) {
        const lowerQuery = query.toLowerCase();
        let results = [];
        let queryEmbedding = null;


        if (this.agent.prompter && this.agent.prompter.embedding_model) {
            try {
                queryEmbedding = await this.agent.prompter.embedding_model.embed(query);
            } catch (e) {
                console.warn('[LearnedSkills] API Embedding failed, falling back to pure substring match.');
            }
        }

        let metadataChanged = false;


        if (queryEmbedding) {
            const skillsToEmbed = [];
            for (const [skillName, data] of Object.entries(this.metadata)) {
                if (!this.vectorCache[skillName]) {
                    const tagsText = data.tags ? data.tags.join(' ') : '';
                    const textToEmbed = `${skillName} ${data.description} ${tagsText}`;
                    skillsToEmbed.push({ skillName, textToEmbed });
                }
            }

            if (skillsToEmbed.length > 0) {

                const BATCH_SIZE = 5;

                for (let i = 0; i < skillsToEmbed.length; i += BATCH_SIZE) {
                    const chunk = skillsToEmbed.slice(i, i + BATCH_SIZE);

                    await Promise.all(chunk.map(async ({ skillName, textToEmbed }) => {
                        try {
                            const newEmbed = await this.agent.prompter.embedding_model.embed(textToEmbed);
                            if (newEmbed && Array.isArray(newEmbed) && newEmbed.length > 0) {
                                this.vectorCache[skillName] = newEmbed;
                                metadataChanged = true;
                            } else {
                                console.warn(`[LearnedSkills] Invalid embedding for '${skillName}'. Skipping cache.`);
                            }
                        } catch (e) {
                            console.warn(`[LearnedSkills] Embedding API failed for '${skillName}':`, e.message);
                        }
                    }));


                    if (i + BATCH_SIZE < skillsToEmbed.length) {
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                }
            }
        }


        for (const [skillName, data] of Object.entries(this.metadata)) {
            let score = 0;

            if (queryEmbedding) {
                const skillVector = this.vectorCache[skillName];
                if (skillVector) {
                    score = this.cosineSimilarity(queryEmbedding, skillVector);
                }
            }


            const matchTag = data.tags && data.tags.some(tag => tag.toLowerCase().includes(lowerQuery));
            const matchDesc = data.description && data.description.toLowerCase().includes(lowerQuery);
            const matchName = skillName.toLowerCase().includes(lowerQuery);

            if (matchTag || matchDesc || matchName) {
                score += 0.3;
            }


            if (score > 0.75 || matchTag || matchDesc || matchName) {
                const total = (data.success_count || 0) + (data.fail_count || 0);
                const rate = total > 0 ? ((data.success_count || 0) / total) : 1.0;
                results.push({ name: skillName, ...data, rate, total, score });
            }
        }

        if (metadataChanged) this.save();


        results.sort((a, b) => b.score - a.score || b.rate - a.rate || b.total - a.total);
        return results.slice(0, 5);
    }


    async getFormattedSkills(query) {
        const skills = await this.searchRelevantSkills(query);
        if (skills.length === 0) return "No relevant saved skills found.";

        let output = `Relevant saved skills for '${query}':\n`;
        skills.forEach(s => {
            const deps = s.dependencies && s.dependencies.length > 0 ? ` [Requires: ${s.dependencies.join(', ')}]` : '';
            output += `- ${s.name}: ${s.description}${deps} (Success: ${(s.rate * 100).toFixed(0)}%, Uses: ${s.total})\n`;
        });
        return output;
    }
}