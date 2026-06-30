import { S3Client, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import sharp from "sharp";
import { v4 as uuidv4 } from "uuid";
import { env } from "../../config/env";

const s3 = new S3Client({ region: env.AWS_REGION });

const BUCKET = env.AWS_S3_BUCKET ?? "";

function publicUrl(key: string): string {
  if (env.AWS_S3_CDN_URL) return `${env.AWS_S3_CDN_URL}/${key}`;
  return `https://${BUCKET}.s3.${env.AWS_REGION}.amazonaws.com/${key}`;
}

function assertBucket(): void {
  if (!BUCKET) throw new Error("AWS_S3_BUCKET is not set");
}

export interface UploadResult {
  url: string;
  publicId: string;
}

function getAudioFileExtension(file: { mimetype?: string; originalname?: string }): string {
  const mimetype = String(file.mimetype || "").toLowerCase();
  const byMime: Record<string, string> = {
    "audio/mpeg": "mp3",
    "audio/mp3": "mp3",
    "audio/mp4": "m4a",
    "audio/x-m4a": "m4a",
    "audio/aac": "aac",
    "audio/wav": "wav",
    "audio/x-wav": "wav",
    "audio/ogg": "ogg",
    "audio/webm": "webm",
  };
  if (byMime[mimetype]) return byMime[mimetype];

  const name = String(file.originalname || "").toLowerCase();
  const match = name.match(/\.(mp3|m4a|aac|wav|ogg|oga|webm)$/);
  return match?.[1] || "m4a";
}

function getAudioContentType(file: { mimetype?: string; originalname?: string }): string {
  const mimetype = String(file.mimetype || "").toLowerCase();
  if (mimetype.startsWith("audio/")) return mimetype;

  const extension = getAudioFileExtension(file);
  const byExtension: Record<string, string> = {
    mp3: "audio/mpeg",
    m4a: "audio/mp4",
    aac: "audio/aac",
    wav: "audio/wav",
    ogg: "audio/ogg",
    oga: "audio/ogg",
    webm: "audio/webm",
  };
  return byExtension[extension] || "audio/mp4";
}

export async function uploadImage(
  file: { buffer: Buffer; mimetype?: string },
  folder = "gaming-social",
  opts?: { width?: number; height?: number }
): Promise<UploadResult & { width: number; height: number }> {
  assertBucket();
  const key = `${folder}/${uuidv4()}.webp`;
  const { data, info } = await sharp(file.buffer)
    .resize(opts?.width ?? 1200, opts?.height ?? 1200, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 85 })
    .toBuffer({ resolveWithObject: true });

  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: data,
      ContentType: "image/webp",
      CacheControl: "public, max-age=31536000",
    })
  );

  return { url: publicUrl(key), publicId: key, width: info.width, height: info.height };
}

export async function uploadAvatar(
  file: { buffer: Buffer },
  folder = "gaming-social/avatars"
): Promise<UploadResult> {
  return uploadImage(file, folder, { width: 400, height: 400 });
}

export async function uploadAvatarFromUrl(
  imageUrl: string,
  folder = "gaming-social/avatars"
): Promise<UploadResult> {
  const res = await fetch(imageUrl, {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Failed to fetch avatar URL: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  return uploadAvatar({ buffer }, folder);
}

export async function uploadVideo(
  file: { buffer: Buffer },
  folder = "gaming-social"
): Promise<UploadResult & { duration?: number; width?: number; height?: number }> {
  assertBucket();
  const key = `${folder}/${uuidv4()}.mp4`;
  const upload = new Upload({
    client: s3,
    params: {
      Bucket: BUCKET,
      Key: key,
      Body: file.buffer,
      ContentType: "video/mp4",
      CacheControl: "public, max-age=31536000, immutable",
    },
  });
  await upload.done();
  return { url: publicUrl(key), publicId: key };
}

export async function uploadAudio(
  file: { buffer: Buffer; mimetype?: string; originalname?: string },
  folder = "gaming-social/audio"
): Promise<UploadResult> {
  assertBucket();
  const extension = getAudioFileExtension(file);
  const key = `${folder}/${uuidv4()}.${extension}`;
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: file.buffer,
      ContentType: getAudioContentType(file),
      CacheControl: "public, max-age=31536000, immutable",
    })
  );
  return { url: publicUrl(key), publicId: key };
}

export async function deleteFile(publicId: string): Promise<void> {
  assertBucket();
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: publicId }));
}

export async function uploadMultipleFiles(
  files: Array<{ buffer: Buffer; mimetype: string }>,
  folder = "gaming-social"
): Promise<Array<{ type: string } & UploadResult>> {
  const results = await Promise.all(
    files.map(async (f) => {
      if (f.mimetype.startsWith("image/")) {
        const r = await uploadImage(f, folder);
        return { type: "image" as const, ...r };
      }
      if (f.mimetype.startsWith("video/")) {
        const r = await uploadVideo(f, folder);
        return { type: "video" as const, ...r };
      }
      if (f.mimetype.startsWith("audio/")) {
        const r = await uploadAudio(f, `${folder}/voice-messages`);
        return { type: "audio" as const, ...r };
      }
      throw new Error(`Unsupported file type: ${f.mimetype}`);
    })
  );
  return results;
}
