"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.invalidateSettingsCache = invalidateSettingsCache;
exports.invalidateChannelsCache = invalidateChannelsCache;
exports.upsertUser = upsertUser;
exports.isUserBanned = isUserBanned;
exports.banUser = banUser;
exports.unbanUser = unbanUser;
exports.incrementDownloadCount = incrementDownloadCount;
exports.getUserStats = getUserStats;
exports.getAllUserIds = getAllUserIds;
exports.isAdmin = isAdmin;
exports.addAdmin = addAdmin;
exports.removeAdmin = removeAdmin;
exports.getAdmins = getAdmins;
exports.getActiveChannels = getActiveChannels;
exports.getAllChannels = getAllChannels;
exports.addChannel = addChannel;
exports.toggleChannel = toggleChannel;
exports.removeChannel = removeChannel;
exports.getSettings = getSettings;
exports.setSetting = setSetting;
exports.toggleSetting = toggleSetting;
exports.logDownload = logDownload;
exports.isPlatformEnabled = isPlatformEnabled;
exports.saveVideoId = saveVideoId;
exports.getVideoUrl = getVideoUrl;
exports.cleanupOldVideoIds = cleanupOldVideoIds;
const database_js_1 = require("./database.js");
const schema_js_1 = require("./schema.js");
const drizzle_orm_1 = require("drizzle-orm");
let settingsCache = null;
let channelsCache = null;
const SETTINGS_TTL_MS = 60_000; // 60 ثانية
const CHANNELS_TTL_MS = 30_000; // 30 ثانية
function invalidateSettingsCache() { settingsCache = null; }
function invalidateChannelsCache() { channelsCache = null; }
// ── Users ──────────────────────────────────────────────────────────────────
async function upsertUser(data) {
    await database_js_1.db
        .insert(schema_js_1.usersTable)
        .values({
        id: data.id,
        username: data.username,
        firstName: data.firstName,
        lastName: data.lastName,
        languageCode: data.languageCode,
    })
        .onConflictDoUpdate({
        target: schema_js_1.usersTable.id,
        set: {
            username: data.username,
            firstName: data.firstName,
            lastName: data.lastName,
            lastActiveAt: new Date(),
        },
    });
}
async function isUserBanned(userId) {
    const rows = await database_js_1.db
        .select({ isBanned: schema_js_1.usersTable.isBanned })
        .from(schema_js_1.usersTable)
        .where((0, drizzle_orm_1.eq)(schema_js_1.usersTable.id, userId));
    return rows[0]?.isBanned ?? false;
}
async function banUser(userId) {
    await database_js_1.db.update(schema_js_1.usersTable).set({ isBanned: true }).where((0, drizzle_orm_1.eq)(schema_js_1.usersTable.id, userId));
}
async function unbanUser(userId) {
    await database_js_1.db.update(schema_js_1.usersTable).set({ isBanned: false }).where((0, drizzle_orm_1.eq)(schema_js_1.usersTable.id, userId));
}
async function incrementDownloadCount(userId) {
    await database_js_1.db
        .update(schema_js_1.usersTable)
        .set({ downloadsCount: (0, drizzle_orm_1.sql) `${schema_js_1.usersTable.downloadsCount} + 1` })
        .where((0, drizzle_orm_1.eq)(schema_js_1.usersTable.id, userId));
}
async function getUserStats() {
    const [userStats] = await database_js_1.db
        .select({
        totalUsers: (0, drizzle_orm_1.count)(),
        bannedUsers: (0, drizzle_orm_1.sql) `sum(case when ${schema_js_1.usersTable.isBanned} then 1 else 0 end)::int`,
        totalDownloads: (0, drizzle_orm_1.sql) `sum(${schema_js_1.usersTable.downloadsCount})::int`,
    })
        .from(schema_js_1.usersTable);
    return {
        totalUsers: userStats?.totalUsers ?? 0,
        totalDownloads: userStats?.totalDownloads ?? 0,
        bannedUsers: userStats?.bannedUsers ?? 0,
    };
}
async function getAllUserIds() {
    const rows = await database_js_1.db
        .select({ id: schema_js_1.usersTable.id })
        .from(schema_js_1.usersTable)
        .where((0, drizzle_orm_1.eq)(schema_js_1.usersTable.isBanned, false));
    return rows.map(r => r.id);
}
// ── Admins ─────────────────────────────────────────────────────────────────
async function isAdmin(userId) {
    const ownerId = parseInt(process.env["OWNER_ID"] || "0", 10);
    if (userId === ownerId)
        return true;
    const rows = await database_js_1.db.select().from(schema_js_1.adminsTable).where((0, drizzle_orm_1.eq)(schema_js_1.adminsTable.id, userId));
    return rows.length > 0;
}
async function addAdmin(id, firstName, username, addedBy) {
    await database_js_1.db
        .insert(schema_js_1.adminsTable)
        .values({ id, firstName, username, addedBy })
        .onConflictDoNothing();
}
async function removeAdmin(id) {
    await database_js_1.db.delete(schema_js_1.adminsTable).where((0, drizzle_orm_1.eq)(schema_js_1.adminsTable.id, id));
}
async function getAdmins() {
    return database_js_1.db
        .select({ id: schema_js_1.adminsTable.id, firstName: schema_js_1.adminsTable.firstName, username: schema_js_1.adminsTable.username })
        .from(schema_js_1.adminsTable);
}
// ── Channels ───────────────────────────────────────────────────────────────
async function getActiveChannels() {
    const now = Date.now();
    if (channelsCache && channelsCache.expiresAt > now) {
        return channelsCache.value.filter((c) => c.isActive);
    }
    const all = await database_js_1.db.select().from(schema_js_1.channelsTable);
    channelsCache = { value: all, expiresAt: now + CHANNELS_TTL_MS };
    return all.filter(c => c.isActive);
}
async function getAllChannels() {
    const now = Date.now();
    if (channelsCache && channelsCache.expiresAt > now)
        return channelsCache.value;
    const all = await database_js_1.db.select().from(schema_js_1.channelsTable);
    channelsCache = { value: all, expiresAt: now + CHANNELS_TTL_MS };
    return all;
}
async function addChannel(data) {
    await database_js_1.db
        .insert(schema_js_1.channelsTable)
        .values({
        channelId: data.channelId,
        channelUsername: data.channelUsername,
        channelTitle: data.channelTitle,
        inviteLink: data.inviteLink,
    })
        .onConflictDoNothing();
    invalidateChannelsCache();
}
async function toggleChannel(id) {
    const [ch] = await database_js_1.db.select().from(schema_js_1.channelsTable).where((0, drizzle_orm_1.eq)(schema_js_1.channelsTable.id, id));
    if (!ch)
        return false;
    const newState = !ch.isActive;
    await database_js_1.db.update(schema_js_1.channelsTable).set({ isActive: newState }).where((0, drizzle_orm_1.eq)(schema_js_1.channelsTable.id, id));
    invalidateChannelsCache();
    return newState;
}
async function removeChannel(id) {
    await database_js_1.db.delete(schema_js_1.channelsTable).where((0, drizzle_orm_1.eq)(schema_js_1.channelsTable.id, id));
    invalidateChannelsCache();
}
// ── Settings ───────────────────────────────────────────────────────────────
async function initDefaultSettings() {
    const defaults = {
        [schema_js_1.SETTINGS_KEYS.YOUTUBE_ENABLED]: "true",
        [schema_js_1.SETTINGS_KEYS.TIKTOK_ENABLED]: "true",
        [schema_js_1.SETTINGS_KEYS.FACEBOOK_ENABLED]: "true",
        [schema_js_1.SETTINGS_KEYS.INSTAGRAM_ENABLED]: "true",
        [schema_js_1.SETTINGS_KEYS.SNAPCHAT_ENABLED]: "true",
        [schema_js_1.SETTINGS_KEYS.X_ENABLED]: "true",
        [schema_js_1.SETTINGS_KEYS.PINTEREST_ENABLED]: "true",
        [schema_js_1.SETTINGS_KEYS.SOUNDCLOUD_ENABLED]: "true",
        [schema_js_1.SETTINGS_KEYS.DOWNLOADS_ENABLED]: "true",
    };
    for (const [key, value] of Object.entries(defaults)) {
        await database_js_1.db.insert(schema_js_1.settingsTable).values({ key, value }).onConflictDoNothing();
    }
}
async function getSettings() {
    const now = Date.now();
    if (settingsCache && settingsCache.expiresAt > now)
        return settingsCache.value;
    await initDefaultSettings();
    const rows = await database_js_1.db.select().from(schema_js_1.settingsTable);
    const value = Object.fromEntries(rows.map(r => [r.key, r.value]));
    settingsCache = { value, expiresAt: now + SETTINGS_TTL_MS };
    return value;
}
async function setSetting(key, value) {
    await database_js_1.db
        .insert(schema_js_1.settingsTable)
        .values({ key, value })
        .onConflictDoUpdate({ target: schema_js_1.settingsTable.key, set: { value, updatedAt: new Date() } });
    invalidateSettingsCache();
}
async function toggleSetting(key) {
    const settings = await getSettings();
    const current = settings[key] !== "false";
    await setSetting(key, current ? "false" : "true");
    return !current;
}
// ── Download Logs ──────────────────────────────────────────────────────────
async function logDownload(data) {
    await database_js_1.db.insert(schema_js_1.downloadLogsTable).values(data).catch(() => { });
}
// ── Platform check ─────────────────────────────────────────────────────────
async function isPlatformEnabled(platform) {
    const settings = await getSettings();
    const key = `${platform}_enabled`;
    return settings[key] !== "false" && settings["downloads_enabled"] !== "false";
}
// ── Video Registry (معرفات نتائج البحث — تبقى شهراً) ────────────────────
/** احفظ معرف فيديو وربطه برابط YouTube في قاعدة البيانات */
async function saveVideoId(sanitizedId, url) {
    await database_js_1.db
        .insert(schema_js_1.videoRegistryTable)
        .values({ sanitizedId, url })
        .onConflictDoNothing()
        .catch(() => { });
}
/** جلب الرابط من قاعدة البيانات عبر المعرف */
async function getVideoUrl(sanitizedId) {
    const rows = await database_js_1.db
        .select({ url: schema_js_1.videoRegistryTable.url })
        .from(schema_js_1.videoRegistryTable)
        .where((0, drizzle_orm_1.eq)(schema_js_1.videoRegistryTable.sanitizedId, sanitizedId));
    return rows[0]?.url;
}
/** حذف السجلات الأقدم من 30 يوماً */
async function cleanupOldVideoIds() {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await database_js_1.db
        .delete(schema_js_1.videoRegistryTable)
        .where((0, drizzle_orm_1.lt)(schema_js_1.videoRegistryTable.createdAt, thirtyDaysAgo))
        .catch(() => { });
}
//# sourceMappingURL=db.js.map