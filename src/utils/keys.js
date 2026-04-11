import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

// 1. FIXED: Peringatan jika file .env benar-benar tidak ada di root
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, '../../.env');

if (!fs.existsSync(envPath)) {
    console.warn('\n[Warning] File .env tidak ditemukan! Memastikan environment variable sudah di-set oleh OS/Docker.');
} else {
    dotenv.config({ path: envPath });
}

// 2. FIXED: Kamus Prefix untuk validasi format (Regex)
const KEY_FORMATS = {
    'OPENAI_API_KEY': /^sk-[a-zA-Z0-9\-_]+$/,         // OpenAI standar (sk-...) atau project (sk-proj-...)
    'GEMINI_API_KEY': /^AIza[a-zA-Z0-9\-_]+$/,        // Google/Gemini selalu diawali AIza
    'ANTHROPIC_API_KEY': /^sk-ant-[a-zA-Z0-9\-_]+$/,  // Claude
};

// 3. FIXED: Validasi Agresif saat Startup (Fail-Fast)
export function validateAllKeys() {
    let hasErrors = false;

    // Cek format key yang diisi oleh user
    for (const [keyName, regex] of Object.entries(KEY_FORMATS)) {
        const keyValue = process.env[keyName];
        if (keyValue && keyValue.trim() !== '') {
            if (!regex.test(keyValue.trim())) {
                console.error(`[CRITICAL ERROR] Format API Key tidak valid untuk ${keyName}! Pastikan tidak ada typo atau spasi.`);
                hasErrors = true;
            }
        }
    }

    // Garansi keamanan Web UI (terhubung dengan patch kita sebelumnya)
    if (!process.env.MINDCRAFT_SECRET || process.env.MINDCRAFT_SECRET.trim() === '') {
        console.error('[CRITICAL ERROR] MINDCRAFT_SECRET tidak ditemukan di .env! Server rentan terhadap pembajakan.');
        hasErrors = true;
    }

    if (hasErrors) {
        console.error("\n[System] Proses dibatalkan. Harap perbaiki file .env Anda dan coba lagi.");
        process.exit(1); // Matikan aplikasi seketika
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

// Jalankan validasi secara otomatis SAAT file ini pertama kali di-import (Startup)
validateAllKeys();