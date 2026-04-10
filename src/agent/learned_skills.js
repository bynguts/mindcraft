import fs from 'fs';
import path from 'path';

export class LearnedSkills {
    constructor(agent) {
        this.agent = agent;
        // Use standard paths consistent with the project structure
        this.dirPath = path.join(process.cwd(), 'bots', 'saved_skills');
        this.metadataPath = path.join(this.dirPath, 'metadata.json');
        this.vectorCachePath = path.join(this.dirPath, 'vector_cache.json'); // NEW: Dedicated vector storage
        this.metadata = {};
        this.vectorCache = {};

        this.init();
    }

    init() {
        // FIXED: Wrap directory creation in try-catch to prevent synchronous constructor crashes
        // Handles cases where OS permissions deny folder creation
        try {
            if (!fs.existsSync(this.dirPath)) {
                fs.mkdirSync(this.dirPath, { recursive: true });
            }
        } catch (err) {
            console.error(`[LearnedSkills] Critical Error: Failed to create directory at ${this.dirPath}. Permission denied? Error:`, err.message);
            this.disabled = true; // Disable saving to prevent further crashes
            return;
        }

        this.reload();

        // FIXED: MIGRATION - Bersihkan metadata lama yang membengkak karena data.embedding
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

    // FIXED: Synchronize state before modifying to prevent race conditions across agents
    reload() {
        if (fs.existsSync(this.metadataPath)) {
            try {
                this.metadata = JSON.parse(fs.readFileSync(this.metadataPath, 'utf8'));
            } catch (e) { console.error('[LearnedSkills] Error parsing metadata.json', e); }
        }
        if (fs.existsSync(this.vectorCachePath)) {
            try {
                this.vectorCache = JSON.parse(fs.readFileSync(this.vectorCachePath, 'utf8'));
            } catch (e) { console.error('[LearnedSkills] Error parsing vector_cache.json', e); }
        }
    }

    // FIXED: Implemented POSIX Atomic Write pattern to prevent JSON corruption during concurrent writes
    save() {
        // FIXED: Do not attempt to save if initialization failed (e.g., no permissions)
        if (this.disabled) return;

        const tmpPath = `${this.metadataPath}.tmp`;
        try {
            // Write to a temporary file first
            fs.writeFileSync(tmpPath, JSON.stringify(this.metadata, null, 4));
            // Rename is an atomic OS operation, guaranteeing file integrity
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

    // FIXED: Tambahkan parameter dependencies dan perbaiki urutan argumen
    registerSkill(skillName, description, embedding, tags = [], dependencies = []) {
        this.reload();

        // 1. Simpan data ringan ke metadata
        this.metadata[skillName] = {
            description: description,
            tags: tags,
            dependencies: dependencies,
            success_count: 0,
            fail_count: 0,
            learned_at: new Date().toISOString()
        };

        // 2. Simpan array float 1536 dimensi murni ke vector cache
        this.vectorCache[skillName] = embedding;

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

    // FIXED: Helper untuk menghitung jarak vektor (Semantic Similarity)
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

    // FIXED: Upgrade dari Lexical Substring ke Semantic Vector Search (Bug #37)
    async searchRelevantSkills(query) {
        const lowerQuery = query.toLowerCase();
        let results = [];
        let queryEmbedding = null;

        // 1. Ambil vektor dari user query
        if (this.agent.prompter && this.agent.prompter.embedding_model) {
            try {
                queryEmbedding = await this.agent.prompter.embedding_model.embed(query);
            } catch (e) {
                console.warn('[LearnedSkills] API Embedding failed, falling back to pure substring match.');
            }
        }

        let metadataChanged = false;

        for (const [skillName, data] of Object.entries(this.metadata)) {
            let score = 0;

            // 2. Semantic Search Logic (FIXED: Route strictly to vectorCache and add Guard Clause)
            if (queryEmbedding) {
                if (!this.vectorCache[skillName]) {
                    const tagsText = data.tags ? data.tags.join(' ') : '';
                    const textToEmbed = `${skillName} ${data.description} ${tagsText}`;
                    try {
                        const newEmbed = await this.agent.prompter.embedding_model.embed(textToEmbed);
                        // GUARD CLAUSE: Jangan save ke cache kalau API gagal/down
                        if (newEmbed && Array.isArray(newEmbed) && newEmbed.length > 0) {
                            this.vectorCache[skillName] = newEmbed;
                            metadataChanged = true;
                        } else {
                            console.warn(`[LearnedSkills] Invalid embedding for '${skillName}'. Skipping cache.`);
                        }
                    } catch (e) {
                        console.warn(`[LearnedSkills] Embedding API failed for '${skillName}':`, e.message);
                    }
                }

                const skillVector = this.vectorCache[skillName];
                if (skillVector) {
                    score = this.cosineSimilarity(queryEmbedding, skillVector);
                }
            }

            // 3. Fallback / Hybrid Boost (Lexical Match)
            const matchTag = data.tags.some(tag => tag.toLowerCase().includes(lowerQuery));
            const matchDesc = data.description.toLowerCase().includes(lowerQuery);
            const matchName = skillName.toLowerCase().includes(lowerQuery);

            if (matchTag || matchDesc || matchName) {
                score += 0.3; // Boost skor kalau string-nya cocok persis
            }

            // 4. Threshold Filter
            if (score > 0.75 || matchTag || matchDesc || matchName) {
                const total = data.success_count + data.fail_count;
                const rate = total > 0 ? (data.success_count / total) : 1.0;
                results.push({ name: skillName, ...data, rate, total, score });
            }
        }

        if (metadataChanged) this.save();

        // 5. Urutkan berdasarkan Skor Semantik tertinggi
        results.sort((a, b) => b.score - a.score || b.rate - a.rate || b.total - a.total);
        return results.slice(0, 5); // Batasi top 5 skills biar konteks LLM nggak kepenuhan
    }

    // FIXED: Ubah menjadi Async karena pencarian vektor butuh waktu (Bug #37)
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