import "dotenv/config";
import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(5001),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),

  // MongoDB / DocumentDB
  MONGODB_URI: z.string().min(1),
  MONGODB_TLS: z.string().optional().transform((v) => v === "true"),
  MONGODB_TLS_CA_FILE: z.string().optional(),

  // Redis / ElastiCache
  REDIS_HOST: z.string().min(1),
  REDIS_PORT: z.coerce.number().default(6379),
  REDIS_USERNAME: z.string().optional(),
  REDIS_PASSWORD: z.string().optional(),
  REDIS_TLS: z.string().optional().transform((v) => v === "true"),

  // JWT
  JWT_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),

  // SMTP / Email
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(465),
  SMTP_SECURE: z.string().optional().transform((v) => v === "true"),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),

  // Push notifications (Expo gateway -> FCM/APNs)
  PUSH_NOTIFICATION_PROVIDER: z.enum(["expo"]).default("expo"),
  EXPO_ACCESS_TOKEN: z.string().optional(),
  EXPO_PUSH_SECURITY_MODE: z.enum(["enabled", "disabled"]).default("enabled"),
  EXPO_PUSH_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(15000),
  EXPO_MAX_PAYLOAD_BYTES: z.coerce.number().int().min(1024).max(4096).default(4096),
  EXPO_PUSH_TOKEN_MAX_LENGTH: z.coerce.number().int().min(64).max(2048).default(512),
  EXPO_GENERIC_PUSH_SEND_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  EXPO_GENERIC_PUSH_INLINE_SEND_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(1),
  EXPO_GENERIC_PUSH_RETRY_BASE_MS: z.coerce.number().int().min(1000).max(60000).default(10000),
  EXPO_GENERIC_PUSH_RECEIPT_DELAY_MS: z.coerce.number().int().min(15000).max(3600000).default(900000),
  EXPO_GENERIC_PUSH_RECEIPT_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(30).default(8),
  EXPO_GENERIC_PUSH_RECEIPT_JOB_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(6),
  PUSH_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(2),
  PUSH_DELIVERY_LOG_RETENTION_DAYS: z.coerce.number().int().min(7).max(3650).default(90),
  PUSH_DEVICE_TOMBSTONE_DAYS: z.coerce.number().int().min(7).max(365).default(90),
  PUSH_REQUEST_RECOVERY_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
  NOTIFICATION_PUSH_OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(12),
  CALL_RING_TTL_SECONDS: z.coerce.number().int().min(15).max(120).default(30),
  CALL_DISCONNECT_GRACE_MS: z.coerce.number().int().min(1000).max(30000).default(30000),
  MAX_CALL_DURATION_SECONDS: z.coerce.number().int().min(300).max(86400).default(14400),
  CALL_STATE_PUSH_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(50).default(12),
  INITIAL_VOIP_OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(5),
  APNS_TEAM_ID: z.string().optional(),
  APNS_KEY_ID: z.string().optional(),
  APNS_PRIVATE_KEY: z.string().optional(),
  APNS_PRIVATE_KEY_BASE64: z.string().optional(),
  APNS_BUNDLE_ID: z.string().default("com.arcSquadHunt"),
  APNS_VOIP_TOPIC: z.string().optional(),
  APNS_ENVIRONMENT: z.enum(["sandbox", "production"]).optional(),
  APNS_VOIP_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(5),
  APNS_VOIP_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(10000),
  APNS_VOIP_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(10),

  // AWS
  AWS_REGION: z.string().default("us-east-1"),
  AWS_S3_BUCKET: z.string().optional(),
  AWS_S3_BUCKET_NAME: z.string().optional(),
  AWS_S3_CDN_URL: z.string().optional(),
  AWS_ACCESS_KEY_ID: z.string().optional(),
  AWS_SECRET_ACCESS_KEY: z.string().optional(),

  // Razorpay
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),
  RAZORPAY_PREMIUM_PLAN_IDS: z.string().optional(),

  // Hardcoded admin credentials (admin panel login)
  // Generate ADMIN_PASSWORD_HASH with: node scripts/generate-admin-hash.js <password>
  ADMIN_USERNAME: z.string().optional(),
  ADMIN_PASSWORD_HASH: z.string().optional(),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error("Invalid environment variables:", parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
