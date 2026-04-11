// src/utils/constants.js

export const THRESHOLDS = {
    SIMILARITY_DUPLICATE: 0.92, // Batas kemiripan (Cosine Similarity) untuk deduplikasi skill
    SKILL_SUCCESS_MIN: 0.3,     // Minimal success rate (30%) sebelum skill otomatis dihapus
    SKILL_MIN_USES_EVAL: 3      // Minimal penggunaan sebelum dievaluasi
};

export const TIMEOUTS = {
    CONVERSATION_DELAY: 5000,   // Delay standar untuk percakapan
    HEARTBEAT_MAX: 15000,       // Maksimal waktu absen sebelum bot dianggap mati (Mindserver)
    RATE_LIMIT_DUPE: 5000,      // Waktu blokir pesan duplikat (Agent)
    RATE_LIMIT_SPAM: 1500       // Waktu throttle pesan beruntun (Agent)
};