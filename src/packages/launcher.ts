import { spawn } from 'node:child_process';
import path from 'node:path';
import { invalidInput } from '../util/errors.js';
import { readAssetPackage } from './format.js';

export type LaunchApplication = 'finder' | 'quicklook' | 'blender';

export interface LaunchPlan {
  schema: 'game_dev.launch_plan.v1';
  application: LaunchApplication;
  executable: '/usr/bin/open' | '/usr/bin/qlmanage';
  arguments: string[];
  target: string;
  mutatesPackage: false;
}

export async function planPackageLaunch(
  packagePath: string,
  application: LaunchApplication,
): Promise<LaunchPlan> {
  const root = path.resolve(packagePath);
  const manifest = await readAssetPackage(root);
  const model = path.join(root, manifest.model);
  if (application === 'finder') {
    return {
      schema: 'game_dev.launch_plan.v1',
      application,
      executable: '/usr/bin/open',
      arguments: ['-R', model],
      target: model,
      mutatesPackage: false,
    };
  }
  if (application === 'quicklook') {
    const target = manifest.preview ? path.join(root, manifest.preview) : model;
    return {
      schema: 'game_dev.launch_plan.v1',
      application,
      executable: '/usr/bin/qlmanage',
      arguments: ['-p', target],
      target,
      mutatesPackage: false,
    };
  }
  if (application === 'blender') {
    return {
      schema: 'game_dev.launch_plan.v1',
      application,
      executable: '/usr/bin/open',
      arguments: ['-a', 'Blender', model],
      target: model,
      mutatesPackage: false,
    };
  }
  throw invalidInput(`unsupported launch application: ${String(application)}`);
}

export async function executeLaunchPlan(plan: LaunchPlan): Promise<{ pid?: number; launched: true }> {
  return new Promise((resolve, reject) => {
    const child = spawn(plan.executable, plan.arguments, {
      detached: true,
      stdio: 'ignore',
      shell: false,
    });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve({ ...(child.pid !== undefined ? { pid: child.pid } : {}), launched: true });
    });
  });
}
