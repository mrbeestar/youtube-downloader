import { db } from "./database.js";
import {
  usersTable,
  adminsTable,
  channelsTable,
  settingsTable,
  downloadLogsTable,
  videoRegistryTable,
  SETTINGS_KEYS,
  type InsertUser,
  type InsertDownloadLog,
} from "./schema.js";
import { eq, count, sql, lt } from "drizzle-orm";

// ── In-memory TTL caches ───────────────────────────────────────────────────

interface CacheEntry<T> { value: T; expiresAt: number; }

let settingsCache: CacheEntry<Record<string, string>> | null = null;
let channelsCache: CacheEntry<any[]> | null = null;

const SETTINGS_TTL_MS = 60_000;  // 60 ثانية
const CHANNELS_TTL_MS = 30_000;  // 30 ثانية

export function invalidateSettingsCache(): void { settingsCache = null; }
export function invalidateChannelsCache(): void { channelsCache = null; }

// ── Users ──────────────────────────────────────────────────────────────────

export async function upsertUser(data: {
  id: number;
  username?: string;
  firstName: string;
  lastName?: string;
  languageCode?: string;
}): Promise<void> {
  await db
    .insert(usersTable)
    .values({
      id: data.id,
      username: data.username,
      firstName: data.firstName,
      lastName: data.lastName,
      languageCode: data.languageCode,
    })
    .onConflictDoUpdate({
      target: usersTable.id,
      set: {
        username: data.username,
        firstName: data.firstName,
        lastName: data.lastName,
        lastActiveAt: new Date(),
      },
    });
}

export async function isUserBanned(userId: number): Promise<boolean> {
  const rows = await db
    .select({ isBanned: usersTable.isBanned })
    .from(usersTable)
    .where(eq(usersTable.id, userId));
  return rows[0]?.isBanned ?? false;
}

export async function banUser(userId: number): Promise<void> {
  await db.update(usersTable).set({ isBanned: true }).where(eq(usersTable.id, userId));
}

export async function unbanUser(userId: number): Promise<void> {
  await db.update(usersTable).set({ isBanned: false }).where(eq(usersTable.id, userId));
}

export async function incrementDownloadCount(userId: number): Promise<void> {
  await db
    .update(usersTable)
    .set({ downloadsCount: sql`${usersTable.downloadsCount} + 1` })
    .where(eq(usersTable.id, userId));
}

export async function getUserStats(): Promise<{
  totalUsers: number;
  totalDownloads: number;
  bannedUsers: number;
}> {
  const [userStats] = await db
    .select({
      totalUsers: count(),
      bannedUsers: sql<number>`sum(case when ${usersTable.isBanned} then 1 else 0 end)::int`,
      totalDownloads: sql<number>`sum(${usersTable.downloadsCount})::int`,
    })
    .from(usersTable);

  return {
    totalUsers: userStats?.totalUsers ?? 0,
    totalDownloads: userStats?.totalDownloads ?? 0,
    bannedUsers: userStats?.bannedUsers ?? 0,
  };
}

export async function getAllUserIds(): Promise<number[]> {
  const rows = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .where(eq(usersTable.isBanned, false));
  return rows.map(r => r.id);
}

// ── Admins ─────────────────────────────────────────────────────────────────

export async function isAdmin(userId: number): Promise<boolean> {
  const ownerId = parseInt(process.env["OWNER_ID"] || "0", 10);
  if (userId === ownerId) return true;
  const rows = await db.select().from(adminsTable).where(eq(adminsTable.id, userId));
  return rows.length > 0;
}

export async function addAdmin(
  id: number,
  firstName: string,
  username: string | undefined,
  addedBy: number
): Promise<void> {
  await db
    .insert(adminsTable)
    .values({ id, firstName, username, addedBy })
    .onConflictDoNothing();
}

export async function removeAdmin(id: number): Promise<void> {
  await db.delete(adminsTable).where(eq(adminsTable.id, id));
}

export async function getAdmins(): Promise<
  Array<{ id: number; firstName: string; username: string | null }>
> {
  return db
    .select({ id: adminsTable.id, firstName: adminsTable.firstName, username: adminsTable.username })
    .from(adminsTable);
}

// ── Channels ───────────────────────────────────────────────────────────────

export async function getActiveChannels() {
  const now = Date.now();
  if (channelsCache && channelsCache.expiresAt > now) {
    return (channelsCache.value as any[]).filter((c: any) => c.isActive);
  }
  const all = await db.select().from(channelsTable);
  channelsCache = { value: all, expiresAt: now + CHANNELS_TTL_MS };
  return all.filter(c => c.isActive);
}

export async function getAllChannels() {
  const now = Date.now();
  if (channelsCache && channelsCache.expiresAt > now) return channelsCache.value;
  const all = await db.select().from(channelsTable);
  channelsCache = { value: all, expiresAt: now + CHANNELS_TTL_MS };
  return all;
}

export async function addChannel(data: {
  channelId: number;
  channelUsername?: string;
  channelTitle: string;
  inviteLink?: string;
}): Promise<void> {
  await db
    .insert(channelsTable)
    .values({
      channelId: data.channelId,
      channelUsername: data.channelUsername,
      channelTitle: data.channelTitle,
      inviteLink: data.inviteLink,
    })
    .onConflictDoNothing();
  invalidateChannelsCache();
}

export async function toggleChannel(id: number): Promise<boolean> {
  const [ch] = await db.select().from(channelsTable).where(eq(channelsTable.id, id));
  if (!ch) return false;
  const newState = !ch.isActive;
  await db.update(channelsTable).set({ isActive: newState }).where(eq(channelsTable.id, id));
  invalidateChannelsCache();
  return newState;
}

export async function removeChannel(id: number): Promise<void> {
  await db.delete(channelsTable).where(eq(channelsTable.id, id));
  invalidateChannelsCache();
}

// ── Settings ───────────────────────────────────────────────────────────────

async function initDefaultSettings(): Promise<void> {
  const defaults: Record<string, string> = {
    [SETTINGS_KEYS.YOUTUBE_ENABLED]:   "true",
    [SETTINGS_KEYS.TIKTOK_ENABLED]:    "true",
    [SETTINGS_KEYS.FACEBOOK_ENABLED]:  "true",
    [SETTINGS_KEYS.INSTAGRAM_ENABLED]: "true",
    [SETTINGS_KEYS.SNAPCHAT_ENABLED]:  "true",
    [SETTINGS_KEYS.X_ENABLED]:         "true",
    [SETTINGS_KEYS.PINTEREST_ENABLED]: "true",
    [SETTINGS_KEYS.SOUNDCLOUD_ENABLED]:"true",
    [SETTINGS_KEYS.DOWNLOADS_ENABLED]: "true",
  };
  for (const [key, value] of Object.entries(defaults)) {
    await db.insert(settingsTable).values({ key, value }).onConflictDoNothing();
  }
}

export async function getSettings(): Promise<Record<string, string>> {
  const now = Date.now();
  if (settingsCache && settingsCache.expiresAt > now) return settingsCache.value;
  await initDefaultSettings();
  const rows = await db.select().from(settingsTable);
  const value = Object.fromEntries(rows.map(r => [r.key, r.value]));
  settingsCache = { value, expiresAt: now + SETTINGS_TTL_MS };
  return value;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await db
    .insert(settingsTable)
    .values({ key, value })
    .onConflictDoUpdate({ target: settingsTable.key, set: { value, updatedAt: new Date() } });
  invalidateSettingsCache();
}

export async function toggleSetting(key: string): Promise<boolean> {
  const settings = await getSettings();
  const current = settings[key] !== "false";
  await setSetting(key, current ? "false" : "true");
  return !current;
}

// ── Download Logs ──────────────────────────────────────────────────────────

export async function logDownload(data: InsertDownloadLog): Promise<void> {
  await db.insert(downloadLogsTable).values(data).catch(() => {});
}

// ── Platform check ─────────────────────────────────────────────────────────

export async function isPlatformEnabled(platform: string): Promise<boolean> {
  const settings = await getSettings();
  const key = `${platform}_enabled`;
  return settings[key] !== "false" && settings["downloads_enabled"] !== "false";
}

// ── Video Registry (معرفات نتائج البحث — تبقى شهراً) ────────────────────

/** احفظ معرف فيديو وربطه برابط YouTube في قاعدة البيانات */
export async function saveVideoId(sanitizedId: string, url: string): Promise<void> {
  await db
    .insert(videoRegistryTable)
    .values({ sanitizedId, url })
    .onConflictDoNothing()
    .catch(() => {});
}

/** جلب الرابط من قاعدة البيانات عبر المعرف */
export async function getVideoUrl(sanitizedId: string): Promise<string | undefined> {
  const rows = await db
    .select({ url: videoRegistryTable.url })
    .from(videoRegistryTable)
    .where(eq(videoRegistryTable.sanitizedId, sanitizedId));
  return rows[0]?.url;
}

/** حذف السجلات الأقدم من 30 يوماً */
export async function cleanupOldVideoIds(): Promise<void> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  await db
    .delete(videoRegistryTable)
    .where(lt(videoRegistryTable.createdAt, thirtyDaysAgo))
    .catch(() => {});
}
