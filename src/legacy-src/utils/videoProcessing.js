const { spawn } = require('child_process');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { randomUUID } = require('crypto');
const log = require('./logger');

const STORY_MAX_SECONDS = 30;

const runFfmpeg = (args) => new Promise((resolve, reject) => {
  const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';

  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  child.on('error', reject);
  child.on('close', (code) => {
    if (code === 0) {
      resolve();
      return;
    }
    reject(new Error(stderr || `ffmpeg exited with code ${code}`));
  });
});

const processStoryVideo = async (file) => {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'arc-story-'));
  const inputPath = path.join(workDir, `${randomUUID()}.input`);
  const outputPath = path.join(workDir, `${randomUUID()}.mp4`);

  try {
    await fs.writeFile(inputPath, file.buffer);
    await runFfmpeg([
      '-y',
      '-i', inputPath,
      '-t', String(STORY_MAX_SECONDS),
      '-vf', "scale='if(gt(iw,720),720,trunc(iw/2)*2)':-2",
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-profile:v', 'main',
      '-level', '4.0',
      '-pix_fmt', 'yuv420p',
      '-b:v', '1500k',
      '-maxrate', '1800k',
      '-bufsize', '3000k',
      '-c:a', 'aac',
      '-b:a', '96k',
      '-ac', '2',
      '-movflags', '+faststart',
      outputPath,
    ]);

    const buffer = await fs.readFile(outputPath);
    return {
      ...file,
      buffer,
      mimetype: 'video/mp4',
      originalname: `${path.parse(file.originalname || 'story').name}.mp4`,
      size: buffer.length,
      optimized: true,
    };
  } catch (err) {
    if (String(file.mimetype || '').toLowerCase() === 'video/mp4') {
      log.warn('Story video optimization failed; uploading original MP4 video', { error: String(err) });
      return file;
    }
    const error = new Error('Could not process this video. Please upload an MP4 video or try a shorter clip.');
    error.statusCode = 422;
    error.cause = err;
    throw error;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
};

module.exports = {
  STORY_MAX_SECONDS,
  processStoryVideo,
};
