import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GameDevRuntime } from '../runtime.js';
import { findBlender, packagedScript } from '../util/blender.js';
import { GAME_DEV_VERSION } from '../version.js';

interface DoctorCheck {
  id: string;
  status: 'pass' | 'warning' | 'fail' | 'unavailable';
  detail: string;
  evidence?: Record<string, unknown>;
}

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

export async function runDoctor(runtime: GameDevRuntime): Promise<Record<string, unknown>> {
  const checks: DoctorCheck[] = [];
  checks.push({
    id: 'platform',
    status: process.platform === 'darwin' ? 'pass' : 'warning',
    detail: `${process.platform} ${process.arch}`,
  });
  checks.push({
    id: 'node-runtime',
    status: 'pass',
    detail: process.version,
    evidence: { executable: process.execPath },
  });
  checks.push({
    id: 'workspace',
    status: 'pass',
    detail: runtime.config.outputDir,
    evidence: { jobsDir: runtime.config.jobsDir },
  });
  checks.push({
    id: 'tripo-credential',
    status: runtime.config.tripoApiKey ? 'pass' : 'unavailable',
    detail: runtime.config.tripoApiKey ? 'configured; value redacted' : 'not configured',
  });
  checks.push({
    id: 'leonardo-credential',
    status: runtime.config.leonardoApiKey ? 'pass' : 'unavailable',
    detail: runtime.config.leonardoApiKey ? 'configured; value redacted' : 'not configured',
  });

  const blender = findBlender();
  checks.push({
    id: 'blender',
    status: blender ? 'pass' : 'unavailable',
    detail: blender ?? 'not installed or configured',
  });
  const normalizer = packagedScript('blender_normalize.py');
  checks.push({
    id: 'blender-normalizer',
    status: await exists(normalizer) ? 'pass' : 'fail',
    detail: normalizer,
  });

  const skillRoot = path.join(process.env.CODEX_HOME?.trim() || path.join(process.env.HOME ?? '', '.codex'), 'skills');
  const expectedSkills = [
    'game-development-studio',
    'game-asset-authoring',
    'game-asset-vendoring',
    'game-visual-debug',
    'game-performance-optimize',
  ];
  const skillStates = await Promise.all(expectedSkills.map(async (name) => ({
    name,
    installed: await exists(path.join(skillRoot, name, 'SKILL.md')),
  })));
  checks.push({
    id: 'codex-skills',
    status: skillStates.every((skill) => skill.installed) ? 'pass' : 'warning',
    detail: skillRoot,
    evidence: { skills: skillStates },
  });

  const invoked = process.argv[1] ? path.resolve(process.argv[1]) : fileURLToPath(import.meta.url);
  checks.push({
    id: 'helper-version',
    status: process.env.GAME_DEV_APP_VERSION && process.env.GAME_DEV_APP_VERSION !== GAME_DEV_VERSION
      ? 'warning'
      : 'pass',
    detail: GAME_DEV_VERSION,
    evidence: {
      executable: invoked,
      appVersion: process.env.GAME_DEV_APP_VERSION ?? 'not supplied',
    },
  });
  checks.push({
    id: 'metal-evidence',
    status: process.platform === 'darwin' ? 'warning' : 'unavailable',
    detail: process.platform === 'darwin'
      ? 'platform supports Metal; no GPU capture was executed by doctor'
      : 'Metal capture requires macOS',
  });

  return {
    schema: 'game_dev.doctor.v1',
    version: GAME_DEV_VERSION,
    healthy: !checks.some((check) => check.status === 'fail'),
    checks,
    evidenceCeiling:
      'Doctor proves local configuration and file/tool discovery only. It does not prove provider authentication, paid generation, Blender output, GPU capture, pixels, signing, notarization, or human review.',
  };
}
