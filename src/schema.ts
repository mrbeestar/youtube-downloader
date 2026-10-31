import { pgTable, bigint, text, boolean, timestamp, integer, serial } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// ── Users ──────────────────────────────────────────────────────────────────
export const usersTable = pgTable("bot_users", {
  id: bigint("id", { mode: "number" }).primaryKey(),
  username: text("username"),
  firstName: text("first_name").notNull().default(""),
  lastName: text("last_name"),
  languageCode: text("language_code"),
  isBanned: boolean("is_banned").notNull().default(false),
  downloadsCount: integer("downloads_count").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  lastActiveAt: timestamp("last_active_at").notNull().defaultNow(),
});

export const insertUserSchema = createInsertSchema(usersTable).omit({ createdAt: true, lastActiveAt: true });
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;

// ── Admins ─────────────────────────────────────────────────────────────────
export const adminsTable = pgTable("bot_admins", {
  id: bigint("id", { mode: "number" }).primaryKey(),
  username: text("username"),
  firstName: text("first_name").notNull().default(""),
  addedBy: bigint("added_by", { mode: "number" }).notNull(),
  addedAt: timestamp("added_at").notNull().defaultNow(),
});

export const insertAdminSchema = createInsertSchema(adminsTable).omit({ addedAt: true });
export type InsertAdmin = z.infer<typeof insertAdminSchema>;
export type Admin = typeof adminsTable.$inferSelect;

// ── Channels ───────────────────────────────────────────────────────────────
export const channelsTable = pgTable("bot_channels", {
  id: serial("id").primaryKey(),
  channelId: bigint("channel_id", { mode: "number" }).notNull().unique(),
  channelUsername: text("channel_username"),
  channelTitle: text("channel_title").notNull(),
  inviteLink: text("invite_link"),
  isActive: boolean("is_active").notNull().default(true),
  addedAt: timestamp("added_at").notNull().defaultNow(),
});

export const insertChannelSchema = createInsertSchema(channelsTable).omit({ id: true, addedAt: true });
export type InsertChannel = z.infer<typeof insertChannelSchema>;
export type Channel = typeof channelsTable.$inferSelect;

// ── Settings ───────────────────────────────────────────────────────────────
export const settingsTable = pgTable("bot_settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertSettingSchema = createInsertSchema(settingsTable).omit({ updatedAt: true });
export type InsertSetting = z.infer<typeof insertSettingSchema>;
export type Setting = typeof settingsTable.$inferSelect;

export const SETTINGS_KEYS = {
  YOUTUBE_ENABLED:  "youtube_enabled",
  TIKTOK_ENABLED:   "tiktok_enabled",
  FACEBOOK_ENABLED: "facebook_enabled",
  INSTAGRAM_ENABLED:"instagram_enabled",
  SNAPCHAT_ENABLED: "snapchat_enabled",
  X_ENABLED:        "x_enabled",
  PINTEREST_ENABLED:"pinterest_enabled",
  SOUNDCLOUD_ENABLED:"soundcloud_enabled",
  DOWNLOADS_ENABLED:"downloads_enabled",
  WELCOME_MESSAGE:  "welcome_message",
} as const;

// ── Download Logs ──────────────────────────────────────────────────────────
export const downloadLogsTable = pgTable("bot_download_logs", {
  id: serial("id").primaryKey(),
  userId: bigint("user_id", { mode: "number" }).notNull(),
  url: text("url").notNull(),
  platform: text("platform").notNull(),
  quality: text("quality"),
  status: text("status").notNull().default("pending"),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertDownloadLogSchema = createInsertSchema(downloadLogsTable).omit({ id: true, createdAt: true });
export type InsertDownloadLog = z.infer<typeof insertDownloadLogSchema>;
export type DownloadLog = typeof downloadLogsTable.$inferSelect;

// ── Video Registry (معرفات نتائج البحث — تبقى شهراً) ────────────────────
export const videoRegistryTable = pgTable("bot_video_registry", {
  sanitizedId: text("sanitized_id").primaryKey(),
  url: text("url").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type VideoRegistry = typeof videoRegistryTable.$inferSelect;

