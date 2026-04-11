import 'dotenv/config'; // FIXED: Otomatis load dari .env, standar keamanan industri

export function getKey(name) {
    const key = process.env[name];
    if (!key) {
        throw new Error(`API key "${name}" not found! Please set it in your environment variables or .env file.`);
    }
    return key;
}

export function hasKey(name) {
    // Kembalikan true jika key ada di environment variable
    return !!process.env[name];
}