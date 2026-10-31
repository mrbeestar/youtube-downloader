"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.videoRegistryTable = exports.downloadLogsTable = exports.SETTINGS_KEYS = exports.settingsTable = exports.channelsTable = exports.adminsTable = exports.usersTable = void 0;
const pg_core_1 = require("drizzle-orm/pg-core");
// ── Users ──────────────────────────────────────────────────────────────────
exports.usersTable = (0, pg_core_1.pgTable)("bot_users", {
    id: (0, pg_core_1.bigint)("id", { mode: "number" }).primaryKey(),
    username: (0, pg_core_1.text)("username"),
    firstName: (0, pg_core_1.text)("first_name").notNull().default(""),
    lastName: (0, pg_core_1.text)("last_name"),
    languageCode: (0, pg_core_1.text)("language_code"),
    isBanned: (0, pg_core_1.boolean)("is_banned").notNull().default(false),
    downloadsCount: (0, pg_core_1.integer)("downloads_count").notNull().default(0),
    createdAt: (0, pg_core_1.timestamp)("created_at").notNull().defaultNow(),
    lastActiveAt: (0, pg_core_1.timestamp)("last_active_at").notNull().defaultNow(),
});
// ── Admins ─────────────────────────────────────────────────────────────────
exports.adminsTable = (0, pg_core_1.pgTable)("bot_admins", {
    id: (0, pg_core_1.bigint)("id", { mode: "number" }).primaryKey(),
    username: (0, pg_core_1.text)("username"),
    firstName: (0, pg_core_1.text)("first_name").notNull().default(""),
    addedBy: (0, pg_core_1.bigint)("added_by", { mode: "number" }).notNull(),
    addedAt: (0, pg_core_1.timestamp)("added_at").notNull().defaultNow(),
});
// ── Channels ───────────────────────────────────────────────────────────────
exports.channelsTable = (0, pg_core_1.pgTable)("bot_channels", {
    id: (0, pg_core_1.serial)("id").primaryKey(),
    channelId: (0, pg_core_1.bigint)("channel_id", { mode: "number" }).notNull().unique(),
    channelUsername: (0, pg_core_1.text)("channel_username"),
    channelTitle: (0, pg_core_1.text)("channel_title").notNull(),
    inviteLink: (0, pg_core_1.text)("invite_link"),
    isActive: (0, pg_core_1.boolean)("is_active").notNull().default(true),
    addedAt: (0, pg_core_1.timestamp)("added_at").notNull().defaultNow(),
});
// ── Settings ───────────────────────────────────────────────────────────────
exports.settingsTable = (0, pg_core_1.pgTable)("bot_settings", {
    key: (0, pg_core_1.text)("key").primaryKey(),
    value: (0, pg_core_1.text)("value").notNull(),
    updatedAt: (0, pg_core_1.timestamp)("updated_at").notNull().defaultNow(),
});
exports.SETTINGS_KEYS = {
    YOUTUBE_ENABLED: "youtube_enabled",
    TIKTOK_ENABLED: "tiktok_enabled",
    FACEBOOK_ENABLED: "facebook_enabled",
    INSTAGRAM_ENABLED: "instagram_enabled",
    SNAPCHAT_ENABLED: "snapchat_enabled",
    X_ENABLED: "x_enabled",
    PINTEREST_ENABLED: "pinterest_enabled",
    SOUNDCLOUD_ENABLED: "soundcloud_enabled",
    DOWNLOADS_ENABLED: "downloads_enabled",
    WELCOME_MESSAGE: "welcome_message",
};
// ── Download Logs ──────────────────────────────────────────────────────────
exports.downloadLogsTable = (0, pg_core_1.pgTable)("bot_download_logs", {
    id: (0, pg_core_1.serial)("id").primaryKey(),
    userId: (0, pg_core_1.bigint)("user_id", { mode: "number" }).notNull(),
    url: (0, pg_core_1.text)("url").notNull(),
    platform: (0, pg_core_1.text)("platform").notNull(),
    quality: (0, pg_core_1.text)("quality"),
    status: (0, pg_core_1.text)("status").notNull().default("pending"),
    errorMessage: (0, pg_core_1.text)("error_message"),
    createdAt: (0, pg_core_1.timestamp)("created_at").notNull().defaultNow(),
});
// ── Video Registry (معرفات نتائج البحث — تبقى شهراً) ────────────────────
exports.videoRegistryTable = (0, pg_core_1.pgTable)("bot_video_registry", {
    sanitizedId: (0, pg_core_1.text)("sanitized_id").primaryKey(),
    url: (0, pg_core_1.text)("url").notNull(),
    createdAt: (0, pg_core_1.timestamp)("created_at").notNull().defaultNow(),
});
//# sourceMappingURL=schema.js.map