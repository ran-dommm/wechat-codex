import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { basename, join, parse } from 'node:path';
import { randomUUID } from 'node:crypto';

import { MEDIA_MAX_DURATION_SECONDS, MEDIA_TOOL_TIMEOUT_MS, TMP_DIR } from '../constants.js';

export interface MediaProbeResult {
  durationSeconds: number;
  hasAudio: boolean;
  hasVideo: boolean;
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

interface FfprobeStream {
  codec_type?: string;
}

interface FfprobeFormat {
  duration?: string;
}

interface FfprobePayload {
  streams?: FfprobeStream[];
  format?: FfprobeFormat;
}

export function calculateTranscriptionTimeoutMs(durationSeconds: number): number {
  const scaledTimeoutMs = Math.ceil(durationSeconds) * 2_000 + 60_000;
  return Math.max(MEDIA_TOOL_TIMEOUT_MS, scaledTimeoutMs);
}

async function runCommand(command: string, args: string[], timeoutMs = MEDIA_TOOL_TIMEOUT_MS): Promise<CommandResult> {
  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      stderr += `${command} timed out after ${timeoutMs}ms`;
      child.kill('SIGTERM');
      setTimeout(() => {
        if (!settled) {
          child.kill('SIGKILL');
        }
      }, 3000);
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      settled = true;
      clearTimeout(timer);
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new Error(`Missing required tool: ${command}`));
        return;
      }
      reject(error);
    });

    child.on('close', (code) => {
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });
  });
}

export async function probeMedia(filePath: string): Promise<MediaProbeResult> {
  const { stdout } = await runCommand('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-show_streams',
    '-of',
    'json',
    filePath,
  ]);

  const payload = JSON.parse(stdout) as FfprobePayload;
  const streams = payload.streams ?? [];
  const durationSeconds = Number(payload.format?.duration ?? '0');

  return {
    durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : 0,
    hasAudio: streams.some((stream) => stream.codec_type === 'audio'),
    hasVideo: streams.some((stream) => stream.codec_type === 'video'),
  };
}

export async function extractAudioForTranscription(
  inputPath: string,
  maxDurationSeconds = MEDIA_MAX_DURATION_SECONDS,
): Promise<string> {
  mkdirSync(TMP_DIR, { recursive: true });
  const outputPath = join(TMP_DIR, `${randomUUID()}.wav`);

  await runCommand('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    inputPath,
    '-vn',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-t',
    String(maxDurationSeconds),
    outputPath,
  ]);

  return outputPath;
}

export async function extractVideoPreviewImage(inputPath: string): Promise<string> {
  mkdirSync(TMP_DIR, { recursive: true });
  const outputPath = join(TMP_DIR, `${randomUUID()}.jpg`);

  await runCommand('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-i',
    inputPath,
    '-frames:v',
    '1',
    '-q:v',
    '2',
    outputPath,
  ]);

  return outputPath;
}

export async function transcribeAudio(filePath: string, durationSeconds = 0): Promise<string> {
  mkdirSync(TMP_DIR, { recursive: true });
  const outputDir = mkdtempSync(join(TMP_DIR, 'whisper-'));
  const outputBaseName = parse(basename(filePath)).name;
  const timeoutMs = calculateTranscriptionTimeoutMs(durationSeconds);

  try {
    await runCommand(
      'whisper',
      [
        '--model',
        'turbo',
        '--language',
        'zh',
        '--task',
        'transcribe',
        '--output_format',
        'txt',
        '--output_dir',
        outputDir,
        '--verbose',
        'False',
        filePath,
      ],
      timeoutMs,
    );

    const transcriptPath = join(outputDir, `${outputBaseName}.txt`);
    return readFileSync(transcriptPath, 'utf8').trim();
  } finally {
    rmSync(outputDir, { recursive: true, force: true });
  }
}
