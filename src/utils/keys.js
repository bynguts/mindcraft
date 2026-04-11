import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '../../.env');

if (!fs.existsSync(envPath)) {
    console.warn('\n[Warning] .env file not found! Please ensure environment variables are set by OS/Docker.');
} else {
    dotenv.config({ path: envPath });
}

const KEY_FORMATS = {
    'OPENAI_API_KEY': /^sk-.+$/,
    'GEMINI_API_KEY': /^AIza.+$/,
    'ANTHROPIC_API_KEY': /^sk-ant-.+$/,
};


export function validateAllKeys() {
    let hasErrors = false;

    for (const [keyName, regex] of Object.entries(KEY_FORMATS)) {
        const keyValue = process.env[keyName];
        if (keyValue && keyValue.trim() !== '') {
            if (!regex.test(keyValue.trim())) {
                console.error(`[CRITICAL ERROR] Invalid API Key format for ${keyName}! Please ensure there are no typos or spaces.`);
                hasErrors = true;
            }
        }
    }

    if (hasErrors) {
        console.error("\n[System] Process aborted. Please fix your .env file and try again.");
        process.exit(1);
    }
}

export function getKey(name) {
    const key = process.env[name];
    if (!key) {
        throw new Error(`API key "${name}" not found! Please set it in your environment variables or .env file.`);
    }
    return key.trim();
}

export function hasKey(name) {
    return !!process.env[name] && process.env[name].trim() !== '';
}


validateAllKeys();