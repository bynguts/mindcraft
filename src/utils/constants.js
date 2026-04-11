export const THRESHOLDS = {
    SIMILARITY_DUPLICATE: 0.92, // Similarity threshold for skill deduplication
    SKILL_SUCCESS_MIN: 0.3,     // Minimum success rate (30%) before auto-deletion
    SKILL_MIN_USES_EVAL: 3      // Minimum usages before evaluation
};

export const TIMEOUTS = {
    CONVERSATION_DELAY: 5000,   // Standard delay for conversation
    HEARTBEAT_MAX: 15000,       // Maximum absence time before bot is considered dead (Mindserver)
    RATE_LIMIT_DUPE: 5000,      // Duplicate message block time (Agent)
    RATE_LIMIT_SPAM: 1500       // Spam throttle time (Agent)
};