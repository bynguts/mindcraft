import OpenAIApi from 'openai';
import { getKey, hasKey } from '../utils/keys.js';
import { strictFormat } from '../utils/text.js';

export class OpenRouter {
    static prefix = 'openrouter';
    constructor(model_name, url) {
        this.model_name = model_name;

        let config = {};
        config.baseURL = url || 'https://openrouter.ai/api/v1';

        const apiKey = getKey('OPENROUTER_API_KEY');
        if (!apiKey) {
            console.error('Error: OPENROUTER_API_KEY not found. Make sure it is set properly.');
        }

        config.apiKey = apiKey;

        this.openai = new OpenAIApi(config);
    }

    async sendRequest(turns, systemMessage, stop_seq = '*') {
        let messages = [{ role: 'system', content: systemMessage }, ...turns];
        messages = strictFormat(messages);

        const pack = {
            model: this.model_name,
            messages,
            stop: stop_seq
        };

        let res = 'My brain disconnected, try again.';
        const MAX_RETRIES = 3;

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
            try {
                console.log(`[OpenRouter] Awaiting response (Attempt ${attempt}/${MAX_RETRIES})...`);
                let completion = await this.openai.chat.completions.create(pack);

                if (!completion?.choices?.[0]) {
                    console.error('[OpenRouter] No completion or choices returned:', completion);
                    return 'No response received.';
                }
                if (completion.choices[0].finish_reason === 'length') {
                    throw new Error('Context length exceeded');
                }

                console.log('[OpenRouter] Received successfully.');
                return completion.choices[0].message.content;

            } catch (err) {
                const isRateLimit = err.status === 429 || (err.message && err.message.includes('429'));
                console.error(`[OpenRouter] Error on attempt ${attempt}:`, err.message || err);

                if (isRateLimit && attempt < MAX_RETRIES) {
                    const delay = attempt * 2000;
                    console.warn(`[OpenRouter] Rate limited! Retrying in ${delay}ms...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    continue;
                }
                break;
            }
        }
        return res;
    }

    async sendVisionRequest(messages, systemMessage, imageBuffer) {
        const imageMessages = [...messages];
        imageMessages.push({
            role: "user",
            content: [
                { type: "text", text: systemMessage },
                {
                    type: "image_url",
                    image_url: {
                        url: `data:image/jpeg;base64,${imageBuffer.toString('base64')}`
                    }
                }
            ]
        });

        return this.sendRequest(imageMessages, systemMessage);
    }

    async embed(text) {
        throw new Error('Embeddings are not supported by Openrouter.');
    }
}